#!/usr/bin/env node
// Build an offline imagery pack: the satellite layer's stand-in for when there
// is no connection, for a whole country, as one PMTiles archive the phone reads
// in place. Listed in the app's Offline regions beside the region packs.
//
//   node build-imagery-pack.mjs <pack-id>          (an entry in imagery-packs.json)
//
//   ATLAS_ORIGIN    backend to read tiles through (default http://127.0.0.1:3100)
//   ATLAS_DATA_DIR  where packs/ and packs-build/ live (default /mnt/data/atlas)
//
// **Why a pack of its own.** Online, the satellite layer is Esri at every zoom,
// and Esri's terms exclude storing it. What may be stored is Kartverket's 10 m
// Sentinel-2 mosaic — open Copernicus data, and the finest imagery of Norway
// Atlas is allowed to put on a phone (Norge i bilder is closed to anyone outside
// Norge digitalt). At z13 that is ~250 000 tiles for the mainland, far past
// what belongs inside a region pack, so it is one download the user opts into,
// covering the whole country once rather than a slab per region.
//
// **Where the tiles come from.** Through the backend's overlay proxy
// (`/api/overlay/<layer>/offline/…`), reading `OverlayLayer.offline` — the one
// place the stand-in's source is defined — so the producer names no upstream,
// and the proxy's disk cache makes a rebuild (or a resumed one) cost Kartverket
// nothing it already answered. Which layer and how deep come from the catalog
// (`LayerMeta.offlinePack`).
//
// **What gets cut** is the source's own footprint inside the spec's box, found
// by descending the pyramid: a child is fetched only where its parent had
// pixels. The mosaic stops at the border and a few kilometres offshore, so this
// is mainland Norway and no open sea, with no coastline file to maintain.
//
// **How it is encoded.** A tile whose parent quadrant was fully opaque is asked
// for as JPEG (`?opaque=1`), encoded by the upstream — most of the pack, and
// several times faster than re-encoding PNGs here. Only tiles on the footprint's
// edge keep a PNG, because their transparency is what lets the basemap show
// beyond the border.
//
// Publication mirrors build-pack.sh: staged, smoke-checked, pack.json written
// last, swapped in whole. A failure leaves the published pack untouched.

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { open } from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { PACK_RUNTIME_IMAGERY, PACK_SCHEMA_VERSION } from '@atlas/core';
import Jimp from 'jimp-compact';
import { PMTiles } from 'pmtiles';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SPEC_PATH = path.join(HERE, 'imagery-packs.json');
const TOOLS_PATH = path.join(HERE, '..', 'tools.json');

const packId = process.argv[2];
if (!packId) {
  console.error('usage: build-imagery-pack.mjs <pack-id>   (see imagery-packs.json)');
  process.exit(1);
}
const origin = (process.env.ATLAS_ORIGIN || 'http://127.0.0.1:3100').replace(/\/+$/, '');
const dataDir = process.env.ATLAS_DATA_DIR || '/mnt/data/atlas';

const specText = readFileSync(SPEC_PATH, 'utf8');
const spec = JSON.parse(specText).packs.find((entry) => entry.id === packId);
if (!spec) {
  console.error(`no pack '${packId}' in ${SPEC_PATH}`);
  process.exit(1);
}
const tools = JSON.parse(readFileSync(TOOLS_PATH, 'utf8'));

/** Parallel tile requests. Kartverket answers a tile in ~0.1 s; this keeps it polite. */
const CONCURRENCY = 8;

/** How many tiles may fail outright before the archive is not worth shipping. */
const MAX_FAILED_FRACTION = 0.002;

/**
 * Parent pixels of margin a quadrant must be opaque beyond its own edge before
 * its child is asked for as JPEG. The upstream renders each tile afresh, so the
 * footprint's edge can land a pixel or so differently at the child's scale; a
 * child misjudged as opaque would carry the JPEG's white fill past the border.
 */
const OPAQUE_MARGIN = 2;

const work = path.join(dataDir, 'packs-build', packId);
const stage = path.join(work, 'stage');
const out = path.join(dataDir, 'packs', packId);
const mbtilesPath = path.join(work, 'imagery.mbtiles');

// ---- the layer, from the catalog -------------------------------------------
let layer;
try {
  const res = await fetch(`${origin}/api/layers`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  layer = (await res.json()).layers.find((meta) => meta.offlinePack?.maxzoom >= 0);
} catch (err) {
  console.error(`could not read the layer catalog at ${origin}: ${err.message}`);
  console.error('start the backend (npm run dev:backend, or the deployed container) and retry');
  process.exit(1);
}
if (!layer) {
  console.error('no catalog layer declares offlinePack — nothing to build');
  process.exit(1);
}
const maxzoom = layer.offlinePack.maxzoom;

// ---- tile math -------------------------------------------------------------
const lngToX = (lng, z) => Math.floor(((lng + 180) / 360) * 2 ** z);
const latToY = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
};
const xToLng = (x, z) => (x / 2 ** z) * 360 - 180;
const yToLat = (y, z) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) * 180) / Math.PI;

/** The spec box as a tile range at one zoom. */
function boxRange(z) {
  const span = 2 ** z;
  const clamp = (v) => Math.min(span - 1, Math.max(0, v));
  return {
    x0: clamp(lngToX(spec.bbox.sw.lng, z)),
    x1: clamp(lngToX(spec.bbox.ne.lng, z)),
    // y grows southwards, so the northern edge gives the smaller index.
    y0: clamp(latToY(spec.bbox.ne.lat, z)),
    y1: clamp(latToY(spec.bbox.sw.lat, z)),
  };
}
const ranges = Array.from({ length: maxzoom + 1 }, (_, z) => boxRange(z));
const inBox = ({ z, x, y }) => {
  const r = ranges[z];
  return x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1;
};

// ---- fetching --------------------------------------------------------------
async function fetchTile({ z, x, y }, opaque) {
  const url = `${origin}/api/overlay/${layer.id}/offline/${z}/${x}/${y}.png${opaque ? '?opaque=1' : ''}`;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      if (res.ok) {
        const body = Buffer.from(await res.arrayBuffer());
        if (body.byteLength > 0) return body;
      } else if (res.status >= 400 && res.status < 500) {
        return null;
      }
    } catch {
      // network/timeout — worth another go
    }
    await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
  }
  return null;
}

const isJpeg = (data) => data[0] === 0xff && data[1] === 0xd8;

/**
 * Which quadrants of a PNG tile hold pixels, and which are opaque with margin
 * to spare. Null for a tile with no pixels at all.
 */
async function coverage(body) {
  const image = await Jimp.read(body);
  const { width, height, data } = image.bitmap;
  if (width !== 256 || height !== 256) throw new Error(`unexpected tile size ${width}×${height}`);
  const alpha = (px, py) => data[(py * 256 + px) * 4 + 3];
  let any = false;
  let all = true;
  const quadrants = [];
  for (let qy = 0; qy < 2; qy++) {
    for (let qx = 0; qx < 2; qx++) {
      let inked = false;
      let opaque = true;
      const x0 = Math.max(0, qx * 128 - OPAQUE_MARGIN);
      const x1 = Math.min(256, qx * 128 + 128 + OPAQUE_MARGIN);
      const y0 = Math.max(0, qy * 128 - OPAQUE_MARGIN);
      const y1 = Math.min(256, qy * 128 + 128 + OPAQUE_MARGIN);
      for (let py = y0; py < y1; py++) {
        for (let px = x0; px < x1; px++) {
          const a = alpha(px, py);
          const own =
            px >= qx * 128 && px < qx * 128 + 128 && py >= qy * 128 && py < qy * 128 + 128;
          if (own && a > 0) inked = true;
          if (a < 255) opaque = false;
        }
      }
      quadrants.push({ dx: qx, dy: qy, inked, opaque });
      any ||= inked;
      all &&= opaque;
    }
  }
  return any ? { quadrants, all } : null;
}

// ---- the archive, written as it grows --------------------------------------
mkdirSync(work, { recursive: true });
rmSync(mbtilesPath, { force: true });
const db = new DatabaseSync(mbtilesPath);
db.exec(`
  PRAGMA journal_mode = OFF;
  PRAGMA synchronous = OFF;
  CREATE TABLE metadata (name TEXT, value TEXT);
  CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB);
  CREATE UNIQUE INDEX tile_index ON tiles (zoom_level, tile_column, tile_row);
`);
const insert = db.prepare('INSERT INTO tiles VALUES (?, ?, ?, ?)');
let pending = 0;
/** The tile range actually written at the deepest zoom: the pack's real extent. */
const deepest = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
db.exec('BEGIN');
function store({ z, x, y }, data) {
  // MBTiles rows count from the south (TMS).
  insert.run(z, x, 2 ** z - 1 - y, data);
  if (z === maxzoom) {
    deepest.minX = Math.min(deepest.minX, x);
    deepest.maxX = Math.max(deepest.maxX, x);
    deepest.minY = Math.min(deepest.minY, y);
    deepest.maxY = Math.max(deepest.maxY, y);
  }
  if (++pending >= 2000) {
    db.exec('COMMIT');
    db.exec('BEGIN');
    pending = 0;
  }
}

// ---- descend the pyramid ---------------------------------------------------
const started = Date.now();
const totals = { jpeg: 0, png: 0, empty: 0, failed: 0, bytes: 0 };

let level = [];
{
  const r = ranges[0];
  for (let x = r.x0; x <= r.x1; x++)
    for (let y = r.y0; y <= r.y1; y++) level.push({ z: 0, x, y, opaque: false });
}

for (let z = 0; z <= maxzoom && level.length > 0; z++) {
  const next = [];
  const counts = { jpeg: 0, png: 0, empty: 0, failed: 0, bytes: 0 };
  let cursor = 0;
  let done = 0;

  const children = (tile, quadrants) => {
    if (z >= maxzoom) return;
    for (const { dx, dy, inked, opaque: quadrantOpaque } of quadrants) {
      if (!inked) continue;
      const child = { z: z + 1, x: tile.x * 2 + dx, y: tile.y * 2 + dy, opaque: quadrantOpaque };
      if (inBox(child)) next.push(child);
    }
  };
  const allOpaque = [0, 1].flatMap((dy) =>
    [0, 1].map((dx) => ({ dx, dy, inked: true, opaque: true })),
  );
  const levelStarted = Date.now();

  async function worker() {
    while (cursor < level.length) {
      const tile = level[cursor++];
      let body = await fetchTile(tile, tile.opaque);
      if (!body) {
        counts.failed++;
      } else if (tile.opaque && isJpeg(body)) {
        store(tile, body);
        counts.jpeg++;
        counts.bytes += body.byteLength;
        children(tile, allOpaque);
      } else {
        const seen = await coverage(body).catch(() => null);
        if (!seen) {
          counts.empty++;
        } else {
          if (seen.all) {
            // Opaque after all (the low zooms, where no parent could say so):
            // ask again for the upstream's JPEG rather than ship a photo as PNG.
            const jpeg = await fetchTile(tile, true);
            if (jpeg && isJpeg(jpeg)) body = jpeg;
          }
          store(tile, body);
          if (isJpeg(body)) counts.jpeg++;
          else counts.png++;
          counts.bytes += body.byteLength;
          children(tile, seen.all ? allOpaque : seen.quadrants);
        }
      }
      if (++done % 5000 === 0) {
        const rate = done / ((Date.now() - levelStarted) / 1000);
        console.log(`      z${z}: ${done}/${level.length} (${rate.toFixed(0)} tiles/s)`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  for (const key of Object.keys(totals)) totals[key] += counts[key];
  console.log(
    `    z${z}: ${level.length} asked — ${counts.jpeg} jpeg, ${counts.png} png edge, ` +
      `${counts.empty} empty, ${counts.failed} failed, ${(counts.bytes / 1024 / 1024).toFixed(1)} MB ` +
      `(${((Date.now() - levelStarted) / 1000).toFixed(0)} s)`,
  );
  level = next;
}
db.exec('COMMIT');

const asked = totals.jpeg + totals.png + totals.empty + totals.failed;
if (totals.failed > asked * MAX_FAILED_FRACTION) {
  console.error(
    `imagery build failed: ${totals.failed} of ${asked} tiles could not be fetched — ` +
      'the upstream or the proxy is unwell; rerun (the proxy cache keeps what arrived)',
  );
  process.exit(1);
}
if (!Number.isFinite(deepest.minX)) {
  console.error(`imagery build failed: no tile reached z${maxzoom}`);
  process.exit(1);
}

// What the archive actually covers, which is what the app asks "does this
// pack draw where I am looking?" against — not the spec's box, which is only a
// limit on the descent.
const bounds = {
  sw: { lat: yToLat(deepest.maxY + 1, maxzoom), lng: xToLng(deepest.minX, maxzoom) },
  ne: { lat: yToLat(deepest.minY, maxzoom), lng: xToLng(deepest.maxX + 1, maxzoom) },
};
const round = (v) => Math.round(v * 1e5) / 1e5;
for (const [key, value] of Object.entries({
  name: spec.name,
  // Mostly JPEG; the footprint's edge is PNG. MapLibre decodes by content.
  format: 'jpg',
  type: 'overlay',
  minzoom: '0',
  maxzoom: String(maxzoom),
  bounds: [bounds.sw.lng, bounds.sw.lat, bounds.ne.lng, bounds.ne.lat].map(round).join(','),
  attribution: '© Copernicus Sentinel data / Kartverket',
})) {
  db.prepare('INSERT INTO metadata VALUES (?, ?)').run(key, value);
}
db.close();
console.log(
  `    ${asked} tiles asked in ${((Date.now() - started) / 60000).toFixed(1)} min: ` +
    `${totals.jpeg} jpeg + ${totals.png} png, ${(totals.bytes / 1024 / 1024).toFixed(0)} MB of tiles`,
);

// ---- MBTiles → PMTiles, with the pinned tool -------------------------------
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
const convert = spawnSync(
  'docker',
  [
    'run',
    '--rm',
    '--memory',
    '4g',
    '--cpus',
    '2',
    '-v',
    `${work}:/work`,
    tools.pmtiles.image,
    'convert',
    '/work/imagery.mbtiles',
    '/work/stage/imagery.pmtiles',
  ],
  { stdio: 'inherit' },
);
if (convert.status !== 0) {
  console.error('pmtiles convert failed');
  process.exit(1);
}
const archivePath = path.join(stage, 'imagery.pmtiles');

// ---- smoke: the archive must draw where the spec says it does --------------
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
{
  const handle = await open(archivePath);
  try {
    const archive = new PMTiles(new FileSource(handle, archivePath));
    const header = await archive.getHeader();
    if (header.maxZoom !== maxzoom) {
      throw new Error(`archive stops at z${header.maxZoom}, expected z${maxzoom}`);
    }
    for (const point of spec.smoke) {
      const x = lngToX(point.lng, maxzoom);
      const y = latToY(point.lat, maxzoom);
      const tile = await archive.getZxy(maxzoom, x, y);
      // A real 10 m tile is kilobytes; a blank or a fill colour is a few hundred bytes.
      if (!tile?.data || tile.data.byteLength < 2000) {
        throw new Error(
          `smoke: ${point.name} has ${tile?.data?.byteLength ?? 'no'} bytes at z${maxzoom}/${x}/${y}`,
        );
      }
      console.log(`    smoke: ${point.name} ${tile.data.byteLength} B at z${maxzoom}/${x}/${y}`);
    }
  } catch (err) {
    console.error(`imagery build failed its smoke check: ${err.message}`);
    process.exit(1);
  } finally {
    await handle.close();
  }
}

// ---- manifest, then publish ------------------------------------------------
const sha256 = (file) =>
  new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
const builtAt = Date.now();
const manifest = {
  id: spec.id,
  name: spec.name,
  bbox: {
    sw: { lat: round(bounds.sw.lat), lng: round(bounds.sw.lng) },
    ne: { lat: round(bounds.ne.lat), lng: round(bounds.ne.lng) },
  },
  version: builtAt,
  builtAt,
  // A raster PMTiles archive in `layers` is a format older apps cannot draw —
  // they would download a country's worth of imagery and show none of it — so
  // this pack names the runtime that first reads it, and older apps decline it.
  compat: { schema: PACK_SCHEMA_VERSION, minRuntime: PACK_RUNTIME_IMAGERY },
  provenance: {
    spec: {
      source: 'imagery',
      region: spec.id,
      sha256: createHash('sha256').update(specText).digest('hex'),
    },
    builder: hostname(),
    inputs: [],
    tools: [{ id: 'pmtiles', image: tools.pmtiles.image, version: tools.pmtiles.version }],
  },
  files: {
    layers: [
      {
        path: 'imagery.pmtiles',
        bytes: statSync(archivePath).size,
        sha256: await sha256(archivePath),
        kind: 'imagery',
        layer: layer.id,
        minzoom: 0,
        maxzoom,
      },
    ],
  },
};
writeFileSync(path.join(stage, 'pack.json'), JSON.stringify(manifest, null, 2));

// The swap, as build-pack.sh does it: park the previous pack, move the new one
// in, drop the parked copy only once the new one is in place.
if (existsSync(out)) {
  rmSync(`${out}.old`, { recursive: true, force: true });
  renameSync(out, `${out}.old`);
}
mkdirSync(path.dirname(out), { recursive: true });
try {
  renameSync(stage, out);
} catch (err) {
  if (existsSync(`${out}.old`)) renameSync(`${out}.old`, out);
  console.error(`publish failed — the previous pack is back in place: ${err.message}`);
  process.exit(1);
}
rmSync(`${out}.old`, { recursive: true, force: true });
rmSync(mbtilesPath, { force: true });
console.log(
  `==> [${spec.id}] published v${manifest.version}: ` +
    `${(manifest.files.layers[0].bytes / 1024 / 1024).toFixed(0)} MB, z0–z${maxzoom}`,
);
