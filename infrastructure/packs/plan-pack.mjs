#!/usr/bin/env node
// Resolve and validate one region's build plan, before the build spends hours on it.
//
//   node plan-pack.mjs <source> <region> [--plan <plan.json>]
//
// Prints shell assignments on stdout for build-pack.sh to eval, and (with
// --plan) writes the machine-readable plan the manifest writer and the smoke
// checker read. Everything it prints is derived from the committed spec in
// specs/<source>.json — the producer has no naming conventions of its own left.
//
// What it refuses, and why each one used to be discovered late:
//   * a region the masters do not cover — pmtiles and osmium both cut an empty
//     archive from an out-of-range bbox and exit 0, so the pack installs and
//     shows nothing;
//   * a master whose own header does not reach the region — the same failure
//     one level down, e.g. a basemap rebuilt for a smaller area;
//   * a missing required input;
//   * a country missing from the admin database — its roads inherit Valhalla's
//     default admin, which drives on the left (384d847).
import { createHash } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { parseRegionBuildSpec, regionFromSpec } from '@atlas/core';
import { PMTiles } from 'pmtiles';
import { open } from 'node:fs/promises';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.ATLAS_DATA_DIR ?? '/mnt/data/atlas';

const [sourceId, regionId, ...rest] = process.argv.slice(2);
if (!sourceId || !regionId) {
  die('usage: plan-pack.mjs <source> <region> [--plan <plan.json>]');
}
const planPath = rest[0] === '--plan' ? rest[1] : null;

function die(message) {
  // stderr, because stdout is shell the caller evals.
  console.error(message);
  process.exit(1);
}

const specPath = path.join(HERE, 'specs', `${sourceId}.json`);
if (!existsSync(specPath)) {
  die(`no build spec at ${specPath} — specs/<source>.json is the whole list of sources`);
}
const specRaw = readFileSync(specPath);
let spec;
let region;
try {
  spec = parseRegionBuildSpec(JSON.parse(specRaw.toString('utf8')), sourceId);
  region = regionFromSpec(spec, regionId);
} catch (err) {
  die(String(err instanceof Error ? err.message : err));
}

const bbox = [region.bbox.sw.lng, region.bbox.sw.lat, region.bbox.ne.lng, region.bbox.ne.lat];

// ---- inputs -----------------------------------------------------------------

// Hashing 3 GB of masters on every pack of a six-pack rebuild is pure repetition
// — the files do not change between them. Cache by path+size+mtime, which is
// exactly the identity a rebuilt master breaks.
const cachePath = path.join(DATA_DIR, 'packs-build', 'input-hashes.json');
const cache = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, 'utf8')) : {};

async function sha256File(file, stat) {
  const key = `${file}:${stat.size}:${stat.mtimeMs}`;
  if (cache[key]) return cache[key];
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', resolve)
      .on('error', reject);
  });
  cache[key] = hash.digest('hex');
  return cache[key];
}

const inputs = [];
const resolved = {};
for (const [id, input] of Object.entries(spec.inputs)) {
  if (input.path === null) {
    if (input.required) die(`${sourceId}.inputs.${id}: required but declared absent`);
    resolved[id] = '';
    continue;
  }
  const absolute = path.join(DATA_DIR, input.path);
  if (!existsSync(absolute)) {
    if (input.required) {
      die(
        `missing required input ${id}: ${absolute}\n` +
          `  ${howToBuild(id, spec)}\n` +
          `  (declared in ${path.relative(process.cwd(), specPath)})`,
      );
    }
    console.error(`note: optional input ${id} absent (${absolute}) — the pack ships without it`);
    resolved[id] = '';
    continue;
  }
  resolved[id] = absolute;
  const stat = statSync(absolute);
  inputs.push({
    id,
    path: input.path,
    bytes: stat.isDirectory() ? 0 : stat.size,
    modifiedAt: Math.round(stat.mtimeMs),
    // A directory (assets) has no meaningful digest, and hashing its contents
    // would only restate what the built assets.zip already hashes.
    ...(stat.isDirectory() ? {} : { sha256: await sha256File(absolute, stat) }),
  });
}
mkdirSync(path.dirname(cachePath), { recursive: true });
writeFileSync(cachePath, JSON.stringify(cache, null, 2));

function howToBuild(id, spec) {
  switch (id) {
    case 'basemap':
      return `build it: infrastructure/tiles/build-basemap.sh ${spec.id}`;
    case 'outdoor':
      return 'build it: infrastructure/tiles/build-outdoor.sh';
    case 'osm':
      return `download it: it is one of infrastructure/valhalla/coverage.list's extracts, fetched by infrastructure/valhalla/build-tiles.sh`;
    case 'admins':
      return 'build it: infrastructure/valhalla/build-admins.sh';
    case 'timezones':
      return 'start infrastructure/valhalla once — it writes timezones.sqlite on first build';
    case 'nvdb':
      return 'build it: infrastructure/nvdb/build-nvdb.mjs';
    default:
      return 'see CLAUDE.md § Map Data & Services for how this dataset is produced';
  }
}

// ---- coverage ---------------------------------------------------------------

// The declared bounds are checked by the parser; these two check the artifacts
// themselves, which is where a master rebuilt for a smaller area shows up.
class FileSource {
  constructor(handle, key) {
    this.handle = handle;
    this.key = key;
  }
  getKey() {
    return this.key;
  }
  async getBytes(offset, length) {
    const buffer = Buffer.alloc(length);
    await this.handle.read(buffer, 0, length, offset);
    return { data: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.length) };
  }
}

async function pmtilesBounds(file) {
  const handle = await open(file);
  try {
    const header = await new PMTiles(new FileSource(handle, file)).getHeader();
    return [header.minLon, header.minLat, header.maxLon, header.maxLat];
  } finally {
    await handle.close();
  }
}

function covers(outer, inner) {
  return (
    outer[0] <= inner[0] && outer[1] <= inner[1] && outer[2] >= inner[2] && outer[3] >= inner[3]
  );
}

for (const id of ['basemap', 'outdoor']) {
  if (!resolved[id]) continue;
  const bounds = await pmtilesBounds(resolved[id]);
  if (!covers(bounds, bbox)) {
    die(
      `${id} archive does not cover ${regionId}: ${path.basename(resolved[id])} holds ` +
        `${bounds.join(',')}, the region needs ${bbox.join(',')}`,
    );
  }
}

// The OSM extract's own header bbox, read through the pinned osmium image —
// this is what catches "the spec points at the wrong country's extract", which
// otherwise produces a pack with a map but no roads.
const tools = JSON.parse(readFileSync(path.join(HERE, '..', 'tools.json'), 'utf8'));
const osmDir = path.dirname(resolved.osm);
const info = execFileSync(
  'docker',
  [
    'run',
    '--rm',
    '-v',
    `${osmDir}:/in:ro`,
    '--entrypoint',
    'sh',
    tools.osmium.image,
    '-c',
    `osmium fileinfo /in/${path.basename(resolved.osm)}`,
  ],
  { encoding: 'utf8' },
);
const boxes = [
  ...info.matchAll(/\(\s*(-?[\d.]+),\s*(-?[\d.]+),\s*(-?[\d.]+),\s*(-?[\d.]+)\)/g),
].map((match) => match.slice(1).map(Number));
if (boxes.length === 0) die(`could not read a bounding box from ${resolved.osm}`);
if (!boxes.some((box) => covers(box, bbox))) {
  die(
    `osm extract does not cover ${regionId}: ${path.basename(resolved.osm)} holds ` +
      `${boxes.map((box) => box.join(',')).join(' / ')}, the region needs ${bbox.join(',')}`,
  );
}
const replication = /osmosis_replication_timestamp=(\S+)/.exec(info)?.[1] ?? null;

// ---- the admin database -----------------------------------------------------

const admins = new DatabaseSync(resolved.admins, { readOnly: true });
try {
  const rows = admins
    .prepare(
      'select iso_code, drive_on_right from admins where admin_level = 2 and iso_code is not null',
    )
    .all();
  const sides = new Map(rows.map((row) => [row.iso_code, row.drive_on_right]));
  const missing = spec.countries.filter((iso) => !sides.has(iso));
  if (missing.length > 0) {
    die(
      `admins.sqlite has no country row for ${missing.join(', ')} — every road there would ` +
        `inherit Valhalla's default admin, which drives on the LEFT.\n` +
        `  rebuild it: infrastructure/valhalla/build-admins.sh`,
    );
  }
} finally {
  admins.close();
}

// ---- output -----------------------------------------------------------------

const plan = {
  source: spec.id,
  sourceName: spec.name,
  region,
  bbox,
  spec: {
    path: path.relative(path.resolve(HERE, '../..'), specPath),
    sha256: createHash('sha256').update(specRaw).digest('hex'),
  },
  dataDir: DATA_DIR,
  builder: hostname(),
  osmReplication: replication,
  inputs,
  tools: Object.entries(tools)
    .filter(([id]) => !id.startsWith('_'))
    .map(([id, tool]) => ({ id, image: tool.image, version: tool.version })),
};
if (planPath) {
  mkdirSync(path.dirname(planPath), { recursive: true });
  writeFileSync(planPath, JSON.stringify(plan, null, 2));
}

const quote = (value) => `'${String(value).replaceAll("'", `'\\''`)}'`;
const assignments = [
  ['PACK_SOURCE', spec.id],
  ['PACK_ID', region.id],
  ['PACK_NAME', region.name],
  ['PACK_BBOX', bbox.join(',')],
  ...Object.entries(resolved).map(([id, absolute]) => [`IN_${id.toUpperCase()}`, absolute]),
  // The same inputs as paths *relative to the data dir*, for the steps that
  // mount the data dir whole rather than one input's parent directory (the
  // Valhalla build reads two masters that a spec need not keep side by side).
  ...Object.entries(spec.inputs).map(([id, input]) => [
    `REL_${id.toUpperCase()}`,
    resolved[id] ? input.path : '',
  ]),
  ...plan.tools.map((tool) => [`TOOL_${tool.id.toUpperCase()}`, tool.image]),
];
process.stdout.write(assignments.map(([key, value]) => `${key}=${quote(value)}`).join('\n') + '\n');
