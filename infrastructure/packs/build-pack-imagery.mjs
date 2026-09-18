#!/usr/bin/env node
// Build a region pack's offline satellite slab: the coarse half of the
// satellite layer, cut to the region's box so the imagery survives losing
// signal.
//
//   node build-pack-imagery.mjs <out.zip> <minLng,minLat,maxLng,maxLat> <meta.json> [origin]
//
// **Only the mosaic can be kept.** The satellite layer is streamed Esri detail
// over a 10 m Sentinel-2 mosaic, and Esri's item terms exclude offline export —
// which is why the overlay proxy marks that band `cache: 'upstream'` and never
// writes it to disk. The mosaic underneath is Copernicus data via Kartverket
// inside Norway and EOX's CC BY 4.0 s2cloudless elsewhere: both redistributable
// with the attribution the layer already carries. So a pack ships the mosaic,
// the app draws it *beneath* the live layer, and the detail simply is not there
// when there is no connection.
//
// Which layer, and how deep, are read from the catalog rather than named here:
// a layer advertises `offlinePack.maxzoom` (see LayerMeta) and this script cuts
// no deeper than that. z13 for a 10 m mosaic — 9.6 m a pixel at 60°N, past
// which the source has no more detail and the archive would only get bigger.
//
// Tiles come from the running backend's own overlay proxy, deliberately:
// - it is the one place the mosaic's composition lives (Kartverket, falling
//   back to EOX outside Norway), so a pack cannot drift from what the layer
//   serves online;
// - its disk cache absorbs the repeats, so rebuilding a region — or building
//   two that overlap — costs the upstreams nothing the second time.
//
// Missing tiles are left out rather than failed on: MapLibre draws nothing for
// a tile that is not in the archive, which is what an unpacked area already
// looks like. A build where *many* fail is a different thing and does fail.

import { writeFileSync, rmSync } from 'node:fs';
import { zipSync } from 'fflate';
import Jimp from 'jimp-compact';

const [outPath, bboxArg, metaPath, originArg] = process.argv.slice(2);
if (!outPath || !bboxArg || !metaPath) {
  console.error(
    'usage: build-pack-imagery.mjs <out.zip> <minLng,minLat,maxLng,maxLat> <meta.json> [origin]',
  );
  process.exit(1);
}

const origin = originArg || process.env.ATLAS_ORIGIN || 'http://127.0.0.1:3100';

const [minLng, minLat, maxLng, maxLat] = bboxArg.split(',').map(Number);
if ([minLng, minLat, maxLng, maxLat].some((n) => !Number.isFinite(n))) {
  console.error(`bad bbox: ${bboxArg}`);
  process.exit(1);
}

/**
 * The most tiles one region may ship.
 *
 * Chosen against what a pack already weighs rather than in the abstract: the
 * published packs run 138 MB (Oslo) to 1.1 GB (Østlandet), and at the ~20 KB a
 * recompressed mosaic tile measures this budget is a ~400 MB ceiling — a
 * visible but proportionate addition to the big ones, and nothing at all to
 * Oslo. It is a *budget*, not a zoom: the deepest pyramid that fits is what
 * gets cut, so Oslo reaches the mosaic's full z13 while Nord-Norge, which is
 * most of a continent's worth of box, settles at z11 instead of shipping five
 * gigabytes.
 *
 * Approximate on purpose. The tiles that keep their alpha (below) stay PNG at
 * around 150 KB, so a heavily indented coastline lands above the estimate. The
 * manifest records the bytes that were actually written.
 */
const TILE_BUDGET = 20_000;

/**
 * JPEG quality for the tiles that can take it. Measured over Oslo's z13 tiles:
 * 158 KB as the PNG the WMS returns, 16 KB at q75, 20 KB at q82, 27 KB at q90.
 * q82 is where a 10 m landscape mosaic — which is going to be *overzoomed* on
 * screen anyway — stops visibly gaining from more bytes.
 */
const JPEG_QUALITY = 82;

/** How many tiles may be missing before the archive is not worth shipping. */
const MAX_MISSING_FRACTION = 0.05;

/** Parallel tile requests. Low on purpose: every miss is an upstream WMS render. */
const CONCURRENCY = 4;

const lngToX = (lng, z) => Math.floor(((lng + 180) / 360) * 2 ** z);
const latToY = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
};

/** Every tile of the z0..maxzoom pyramid the box touches. */
function tilesForBox(maxzoom) {
  const tiles = [];
  for (let z = 0; z <= maxzoom; z++) {
    const span = 2 ** z;
    const clamp = (v) => Math.min(span - 1, Math.max(0, v));
    const x0 = clamp(lngToX(minLng, z));
    const x1 = clamp(lngToX(maxLng, z));
    // y grows southwards, so the northern edge gives the smaller index.
    const y0 = clamp(latToY(maxLat, z));
    const y1 = clamp(latToY(minLat, z));
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) tiles.push({ z, x, y });
  }
  return tiles;
}

/** Give up on the artifact, leaving the build free to ship a pack without one. */
function skip(reason) {
  console.log(`    no offline imagery: ${reason}`);
  rmSync(outPath, { force: true });
  rmSync(metaPath, { force: true });
  process.exit(0);
}

let catalog;
try {
  const res = await fetch(`${origin}/api/layers`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  catalog = (await res.json()).layers;
} catch (err) {
  // Not an absent input — a broken build host. The whole point of the artifact
  // is that the imagery is there when the network is not, so shipping a pack
  // silently missing it is the one outcome worth failing for.
  console.error(`could not read the layer catalog at ${origin}: ${err.message}`);
  console.error('start the backend (npm run dev:backend, or the deployed container) and retry');
  process.exit(1);
}

const layer = (catalog ?? []).find((meta) => meta.offlinePack?.maxzoom >= 0);
if (!layer) skip('no catalog layer declares offlinePack');

// The deepest complete pyramid that fits the budget. Reported either way: a
// region that had to stop short is a fact about the pack, not an implementation
// detail, and it is what the client overzooms from.
let maxzoom = -1;
for (let z = 0; z <= layer.offlinePack.maxzoom; z++) {
  if (tilesForBox(z).length > TILE_BUDGET) break;
  maxzoom = z;
}
if (maxzoom < 0) skip(`even z0 exceeds the ${TILE_BUDGET}-tile budget`);

const tiles = tilesForBox(maxzoom);
console.log(
  `    ${layer.id}: z0–z${maxzoom}, ${tiles.length} tiles` +
    (maxzoom < layer.offlinePack.maxzoom
      ? ` (capped by the ${TILE_BUDGET}-tile budget; the layer offers z${layer.offlinePack.maxzoom})`
      : ''),
);

const files = {};
let missing = 0;
let blank = 0;
let kept = 0;
let done = 0;
let cursor = 0;

/**
 * The bytes to store for one tile, or null for a tile not worth storing.
 *
 * The proxy answers in PNG, which for a photograph is about eight times what
 * the same picture costs as JPEG — the difference between a 400 MB slab and a
 * 3 GB one. But the alpha channel is load-bearing here and JPEG has none: at
 * the low zooms Kartverket draws Norway and leaves the rest of the world
 * transparent for the basemap to show through, and flattening that would ship a
 * black planet with Norway on it. So the conversion is conditional on the tile
 * being fully opaque, which every tile well inside the mosaic is, and the
 * handful along its edges keep their original bytes.
 *
 * A fully transparent tile is dropped rather than stored: MapLibre draws
 * nothing for a tile that is not in the archive, which is exactly what a
 * transparent one would have looked like.
 */
async function encodeTile(body) {
  let image;
  try {
    image = await Jimp.read(body);
  } catch {
    // Not decodable here is still a tile the client may understand; ship it.
    return body;
  }
  let min = 255;
  let max = 0;
  image.scan(0, 0, image.bitmap.width, image.bitmap.height, (_x, _y, offset) => {
    const alpha = image.bitmap.data[offset + 3];
    if (alpha < min) min = alpha;
    if (alpha > max) max = alpha;
  });
  if (max === 0) return null;
  if (min < 255) return body;
  return await image.quality(JPEG_QUALITY).getBufferAsync(Jimp.MIME_JPEG);
}

async function fetchTile({ z, x, y }) {
  const url = `${origin}/api/overlay/${layer.id}/${z}/${x}/${y}.png`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (res.ok) {
        const body = Buffer.from(await res.arrayBuffer());
        // The entries are named .png whatever the source sent, because that is
        // the template the client mounts ({z}/{x}/{y}.png) and MapLibre reads
        // the bytes, not the name. Kartverket answers PNG and EOX JPEG, so the
        // archive genuinely holds both.
        if (body.byteLength > 0) return body;
      }
      // A 502 is the proxy saying the upstream refused this one; retrying the
      // same tile immediately would just ask it again.
      if (res.status >= 400 && res.status < 500) return null;
    } catch {
      // network/timeout — worth another go
    }
    await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
  }
  return null;
}

async function worker() {
  while (cursor < tiles.length) {
    const tile = tiles[cursor++];
    const body = await fetchTile(tile);
    if (!body) missing++;
    else {
      const encoded = await encodeTile(body);
      if (!encoded) blank++;
      else {
        // `encodeTile` hands back the very buffer it was given for a tile whose
        // alpha it had to preserve; anything else is the recompressed JPEG.
        if (encoded === body) kept++;
        files[`${tile.z}/${tile.x}/${tile.y}.png`] = [encoded, { level: 0 }];
      }
    }
    done++;
    if (done % 1000 === 0 || done === tiles.length) {
      console.log(`    ${done}/${tiles.length} tiles (${missing} missing, ${blank} blank)`);
    }
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker));

if (missing > tiles.length * MAX_MISSING_FRACTION) {
  console.error(
    `imagery build failed: ${missing} of ${tiles.length} tiles could not be fetched ` +
      `(limit ${Math.floor(tiles.length * MAX_MISSING_FRACTION)}) — the upstream or the proxy is unwell`,
  );
  process.exit(1);
}

// Stored, not deflated: PNG and JPEG are already compressed, so the zip is a
// container here rather than a compressor — exactly as the derived surfaces do.
const archive = Buffer.from(zipSync(files, { level: 0 }));
writeFileSync(outPath, archive);
writeFileSync(
  metaPath,
  JSON.stringify({ kind: 'imagery', layer: layer.id, minzoom: 0, maxzoom }, null, 2),
);
console.log(
  `    wrote ${(archive.byteLength / 1024 / 1024).toFixed(1)} MB ` +
    `(${Object.keys(files).length} tiles, ${kept} kept as PNG for their alpha, ` +
    `${blank} blank, ${missing} missing)`,
);
