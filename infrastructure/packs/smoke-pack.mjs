#!/usr/bin/env node
// Prove a freshly built pack actually works, before it is published.
//
//   node smoke-pack.mjs <plan.json> <pack-dir>
//
// Checksums prove a file arrived intact; they cannot tell an intact archive of
// the wrong place from the right one. Every check here opens a real artifact
// and asks it the question a phone will ask: draw this tile, find this place,
// route between these two points. The place and the points come from the
// region's own spec, so "known good" is committed rather than remembered.
//
// A failure here stops publication — the previously published pack stays.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { ftsMatchQuery, haversineM } from '@atlas/core';
import { PMTiles } from 'pmtiles';

const [planPath, packDir] = process.argv.slice(2);
if (!planPath || !packDir) {
  console.error('usage: smoke-pack.mjs <plan.json> <pack-dir>');
  process.exit(1);
}
const plan = JSON.parse(readFileSync(planPath, 'utf8'));
const [minLng, minLat, maxLng, maxLat] = plan.bbox;
const centre = { lat: (minLat + maxLat) / 2, lng: (minLng + maxLng) / 2 };
const tool = (id) => plan.tools.find((entry) => entry.id === id).image;

const failures = [];
const notes = [];
const check = async (what, run) => {
  try {
    notes.push(`    ${what}: ${(await run()) ?? 'ok'}`);
  } catch (err) {
    failures.push(`${what}: ${err instanceof Error ? err.message : String(err)}`);
  }
};

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

async function withPmtiles(file, fn) {
  const handle = await open(file);
  try {
    return await fn(new PMTiles(new FileSource(handle, file)));
  } finally {
    await handle.close();
  }
}

/** Web Mercator tile containing a point. */
function tileFor(zoom, { lat, lng }) {
  const n = 2 ** zoom;
  const x = Math.floor(((lng + 180) / 360) * n);
  const rad = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n);
  return { x, y };
}

// ---- the basemap: a tile at the region's centre must actually be in there ----
// An out-of-range cut produces a valid archive with no tiles at all, which is
// the pack that installs and shows an empty map.
await check('basemap', () =>
  withPmtiles(path.join(packDir, 'basemap.pmtiles'), async (archive) => {
    const header = await archive.getHeader();
    const zoom = Math.min(12, header.maxZoom);
    const { x, y } = tileFor(zoom, centre);
    const tile = await archive.getZxy(zoom, x, y);
    if (!tile?.data?.byteLength) throw new Error(`no tile at ${zoom}/${x}/${y} (region centre)`);
    return `z${header.minZoom}-${header.maxZoom}, ${tile.data.byteLength} B at ${zoom}/${x}/${y}`;
  }),
);

// The outdoor overlay is genuinely sparse — a region with no cabins or gates
// has no tile at its centre and that is not a fault. Only the archive itself is
// checked, and that it is not the empty file an out-of-range cut leaves.
if (existsSync(path.join(packDir, 'outdoor.pmtiles'))) {
  await check('outdoor', () =>
    withPmtiles(path.join(packDir, 'outdoor.pmtiles'), async (archive) => {
      const header = await archive.getHeader();
      if (header.numTileEntries === 0) throw new Error('archive holds no tiles');
      return `${header.numTileEntries} tiles, z${header.minZoom}-${header.maxZoom}`;
    }),
  );
}

// ---- search: the phone's own query, and the answer must be in the region ----
await check('search', () => {
  const db = new DatabaseSync(path.join(packDir, 'search.sqlite'), { readOnly: true });
  try {
    const found = [];
    for (const name of plan.region.smoke.search) {
      const rows = db
        .prepare('SELECT name, lat, lng FROM places WHERE places MATCH ? ORDER BY rank LIMIT 5')
        .all(ftsMatchQuery(name));
      if (rows.length === 0) throw new Error(`no result for ${JSON.stringify(name)}`);
      // Coordinates outside the bbox mean the index was built from the wrong
      // extract — a Scottish bbox cut from Norwegian masters would still return
      // rows, just not any that are in Scotland.
      const inside = rows.filter(
        (row) => row.lng >= minLng && row.lng <= maxLng && row.lat >= minLat && row.lat <= maxLat,
      );
      if (inside.length === 0) {
        throw new Error(`${JSON.stringify(name)} matched only places outside the region`);
      }
      found.push(`${name} → ${inside[0].name}`);
    }
    return found.join('; ');
  } finally {
    db.close();
  }
});

// ---- the road-data side dataset, when the region ships one ------------------
if (existsSync(path.join(packDir, 'nvdb.sqlite'))) {
  await check('nvdb', () => {
    const db = new DatabaseSync(path.join(packDir, 'nvdb.sqlite'), { readOnly: true });
    try {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all()
        .map((row) => row.name);
      if (tables.length === 0) throw new Error('database has no tables');
      // The rtree shadow tables restate their parent's rows; counting them
      // would bury the two numbers anyone reads (how many speed limits, how
      // many cameras) under fifteen that repeat them.
      const counts = tables
        .filter((name) => !name.startsWith('sqlite_') && !/_rtree(_|$)/.test(name))
        .map((name) => `${name}=${db.prepare(`SELECT count(*) c FROM "${name}"`).get().c}`);
      return counts.join(', ');
    } finally {
      db.close();
    }
  });
}

// ---- assets: labels and icons, or the offline map renders neither ----------
await check('assets', () => {
  const listing = execFileSync(
    'python3',
    [
      '-c',
      'import sys, zipfile; print("\\n".join(zipfile.ZipFile(sys.argv[1]).namelist()))',
      path.join(packDir, 'assets.zip'),
    ],
    { encoding: 'utf8' },
  ).split('\n');
  for (const prefix of ['fonts/', 'sprites/']) {
    if (!listing.some((entry) => entry.startsWith(prefix))) {
      throw new Error(`no ${prefix} entries in assets.zip`);
    }
  }
  return `${listing.filter(Boolean).length} entries`;
});

// ---- routing: the pack's own tiles, asked for a real route ------------------
const route = plan.region.smoke.route;
if (route) {
  await check('routing', () => {
    const request = JSON.stringify({
      locations: [
        { lat: route.from.lat, lon: route.from.lng },
        { lat: route.to.lat, lon: route.to.lng },
      ],
      costing: 'auto',
    });
    // The service is started inside the container and asked there: no port to
    // publish, nothing to collide with the running atlas-valhalla.
    const input = (id) => plan.inputs.find((entry) => entry.id === id).path;
    const script = `
      set -e
      valhalla_build_config --mjolnir-tile-extract /pack/valhalla.tar \
        --mjolnir-timezone /data/${input('timezones')} \
        --mjolnir-admin /data/${input('admins')} > /tmp/config.json
      valhalla_service /tmp/config.json 1 >/tmp/service.log 2>&1 &
      for i in $(seq 1 60); do
        curl -sf http://localhost:8002/status >/dev/null 2>&1 && break
        sleep 1
      done
      curl -sf http://localhost:8002/route -d '${request}'
    `;
    const out = execFileSync(
      'docker',
      [
        'run',
        '--rm',
        '--memory',
        '2g',
        '--memory-swap',
        '2g',
        '--cpus',
        '2',
        '-v',
        `${path.resolve(packDir)}:/pack:ro`,
        '-v',
        `${plan.dataDir}:/data:ro`,
        '--entrypoint',
        'bash',
        tool('valhalla'),
        '-c',
        script,
      ],
      { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
    );
    const answer = JSON.parse(out);
    const summary = answer?.trip?.summary;
    if (!summary || !(summary.length > 0))
      throw new Error(`no route in the answer: ${out.slice(0, 200)}`);
    const straight = haversineM(route.from, route.to) / 1000;
    // A route far shorter than the straight line is not a route at all.
    if (summary.length < straight * 0.8) {
      throw new Error(
        `route is ${summary.length.toFixed(1)} km for a ${straight.toFixed(1)} km hop`,
      );
    }
    return `${summary.length.toFixed(1)} km, ${Math.round(summary.time / 60)} min`;
  });
}

// ---- what the manifest will claim ------------------------------------------
for (const file of ['basemap.pmtiles', 'search.sqlite', 'valhalla.tar', 'assets.zip']) {
  const full = path.join(packDir, file);
  if (!existsSync(full) || statSync(full).size === 0) failures.push(`${file}: missing or empty`);
}

console.log(notes.join('\n'));
if (failures.length > 0) {
  console.error(`\nsmoke checks failed for ${plan.region.id}:`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  console.error('\nnothing was published — the previously published pack is untouched.');
  process.exit(1);
}
