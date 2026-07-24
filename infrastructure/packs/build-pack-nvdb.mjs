#!/usr/bin/env node
// Build a region pack's offline road-data dataset (ROADMAP §2.1): the same
// nvdb.sqlite schema the backend's NvdbStore reads, so speed-limit overrides
// and speed-camera warnings work on-device with no network.
//
//   node build-pack-nvdb.mjs <out.sqlite> <minLng,minLat,maxLng,maxLat> [master-nvdb.sqlite] \
//        < region.geojsonseq
//
// Two sources, combined:
//   1. NVDB (Norway, authoritative) — speed limits + ATK cameras clipped from
//      the national master dataset (built by infrastructure/nvdb/build-nvdb.mjs)
//      to the region bounding box. Absent/empty for a region outside Norway.
//   2. OSM `highway=speed_camera` point cameras read from the region's own OSM
//      extract (the GeoJSONSeq build-pack.sh already produces for search) — the
//      only camera data available outside Norway, deduped against any NVDB
//      camera nearby so a Norwegian pack never double-warns one installation.
//
// The result is byte-for-byte a smaller nvdb.sqlite: the on-device reader and
// the shared conflation (@atlas/routing) run on it unchanged. When neither
// source yields anything (a region with no NVDB clip and no OSM cameras) the
// file is removed and nothing is shipped — build-pack.sh omits it from the
// manifest, and a pack with no dataset degrades to exactly the pre-NVDB
// behaviour, per the §2.1 rule.
//
// Requires the workspace packages to be built (`npm run build`) so
// `@atlas/routing` resolves — like every other post-build pipeline artefact.

import { existsSync, rmSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';

import { osmCameraFromTags } from '@atlas/routing';

const [outPath, bboxArg, masterPath] = process.argv.slice(2);
if (!outPath || !bboxArg) {
  console.error(
    'usage: build-pack-nvdb.mjs <out.sqlite> <minLng,minLat,maxLng,maxLat> [master-nvdb.sqlite] < region.geojsonseq',
  );
  process.exit(1);
}

const [minLng, minLat, maxLng, maxLat] = bboxArg.split(',').map(Number);
if ([minLng, minLat, maxLng, maxLat].some((n) => !Number.isFinite(n))) {
  console.error(`bad bbox: ${bboxArg}`);
  process.exit(1);
}

// An OSM camera this close to an NVDB camera is taken to be the same physical
// installation; the NVDB one (with its resolved direction) wins and the OSM
// duplicate is dropped. Generous enough to absorb the gantry-vs-centreline
// offset between the two surveys without merging genuinely distinct cameras.
const DEDUPE_M = 75;

const inBbox = (lat, lng) => lng >= minLng && lng <= maxLng && lat >= minLat && lat <= maxLat;

const distM = (aLat, aLng, bLat, bLng) =>
  Math.hypot((bLat - aLat) * 111_320, (bLng - aLng) * 111_320 * Math.cos((aLat * Math.PI) / 180));

function boundsOf(points) {
  let bMinLat = Infinity,
    bMaxLat = -Infinity,
    bMinLng = Infinity,
    bMaxLng = -Infinity;
  for (const [lat, lng] of points) {
    if (lat < bMinLat) bMinLat = lat;
    if (lat > bMaxLat) bMaxLat = lat;
    if (lng < bMinLng) bMinLng = lng;
    if (lng > bMaxLng) bMaxLng = lng;
  }
  return { bMinLat, bMaxLat, bMinLng, bMaxLng };
}

function openOut(file) {
  mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  if (existsSync(file)) rmSync(file);
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE speed_segment (id INTEGER PRIMARY KEY, limit_kph INTEGER NOT NULL, geom TEXT NOT NULL);
    CREATE VIRTUAL TABLE speed_rtree USING rtree(id, min_lng, max_lng, min_lat, max_lat);
    CREATE TABLE camera_point (id INTEGER PRIMARY KEY, name TEXT, bearing_deg REAL, lat REAL NOT NULL, lng REAL NOT NULL);
    CREATE VIRTUAL TABLE camera_point_rtree USING rtree(id, min_lng, max_lng, min_lat, max_lat);
    CREATE TABLE camera_section (id INTEGER PRIMARY KEY, name TEXT, geom TEXT NOT NULL);
    CREATE VIRTUAL TABLE camera_section_rtree USING rtree(id, min_lng, max_lng, min_lat, max_lat);
  `);
  return db;
}

/** Rows of a table whose rtree bbox intersects the region, as {id, ...cols}. */
function clipTable(master, table, rtree, cols) {
  return master
    .prepare(
      `SELECT t.id AS id, ${cols.map((c) => `t.${c} AS ${c}`).join(', ')}
         FROM ${rtree} r JOIN ${table} t ON t.id = r.id
        WHERE r.min_lng <= ? AND r.max_lng >= ? AND r.min_lat <= ? AND r.max_lat >= ?`,
    )
    .all(maxLng, minLng, maxLat, minLat);
}

/** Copy the NVDB speed limits + cameras covering the region out of the master DB. */
function importNvdbClip(db, masterFile) {
  const nvdbCameras = []; // NVDB camera positions, for OSM dedup
  if (!masterFile || !existsSync(masterFile)) {
    console.log('    no master nvdb.sqlite — OSM cameras only');
    return { speed: 0, points: 0, sections: 0, nvdbCameras };
  }
  const master = new DatabaseSync(masterFile, { readOnly: true });
  let speed = 0;
  let points = 0;
  let sections = 0;
  try {
    const insSeg = db.prepare('INSERT INTO speed_segment (id, limit_kph, geom) VALUES (?, ?, ?)');
    const insSegBox = db.prepare(
      'INSERT INTO speed_rtree (id, min_lng, max_lng, min_lat, max_lat) VALUES (?, ?, ?, ?, ?)',
    );
    db.exec('BEGIN');
    for (const row of clipTable(master, 'speed_segment', 'speed_rtree', ['limit_kph', 'geom'])) {
      let coords;
      try {
        coords = JSON.parse(row.geom);
      } catch {
        continue;
      }
      if (!Array.isArray(coords) || coords.length < 2) continue;
      const b = boundsOf(coords);
      insSeg.run(row.id, row.limit_kph, row.geom);
      insSegBox.run(row.id, b.bMinLng, b.bMaxLng, b.bMinLat, b.bMaxLat);
      speed++;
    }

    const insPt = db.prepare(
      'INSERT INTO camera_point (id, name, bearing_deg, lat, lng) VALUES (?, ?, ?, ?, ?)',
    );
    const insPtBox = db.prepare(
      'INSERT INTO camera_point_rtree (id, min_lng, max_lng, min_lat, max_lat) VALUES (?, ?, ?, ?, ?)',
    );
    for (const row of clipTable(master, 'camera_point', 'camera_point_rtree', [
      'name',
      'bearing_deg',
      'lat',
      'lng',
    ])) {
      insPt.run(row.id, row.name, row.bearing_deg, row.lat, row.lng);
      insPtBox.run(row.id, row.lng, row.lng, row.lat, row.lat);
      nvdbCameras.push([row.lat, row.lng]);
      points++;
    }

    const insSec = db.prepare('INSERT INTO camera_section (id, name, geom) VALUES (?, ?, ?)');
    const insSecBox = db.prepare(
      'INSERT INTO camera_section_rtree (id, min_lng, max_lng, min_lat, max_lat) VALUES (?, ?, ?, ?, ?)',
    );
    for (const row of clipTable(master, 'camera_section', 'camera_section_rtree', [
      'name',
      'geom',
    ])) {
      let coords;
      try {
        coords = JSON.parse(row.geom);
      } catch {
        continue;
      }
      if (!Array.isArray(coords) || coords.length < 2) continue;
      const b = boundsOf(coords);
      insSec.run(row.id, row.name, row.geom);
      insSecBox.run(row.id, b.bMinLng, b.bMaxLng, b.bMinLat, b.bMaxLat);
      sections++;
    }
    db.exec('COMMIT');
  } catch (err) {
    // A master without the camera tables (an older build) is not fatal — take
    // the speed limits it does have and move on.
    try {
      db.exec('COMMIT');
    } catch {
      /* not in a transaction */
    }
    console.warn(`    partial NVDB clip: ${err.message}`);
  } finally {
    master.close();
  }
  console.log(`    NVDB clip: ${speed} speed, ${points} point cameras, ${sections} sections`);
  return { speed, points, sections, nvdbCameras };
}

/** The next free camera_point id, above every id the NVDB clip used. */
function maxCameraId(db) {
  const row = db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM camera_point').get();
  return Number(row.m) || 0;
}

/**
 * Read OSM speed cameras from the GeoJSONSeq on stdin, adding any that fall in
 * the region and aren't already covered by an NVDB camera nearby.
 */
async function importOsmCameras(db, nvdbCameras) {
  const insPt = db.prepare(
    'INSERT INTO camera_point (id, name, bearing_deg, lat, lng) VALUES (?, ?, ?, ?, ?)',
  );
  const insPtBox = db.prepare(
    'INSERT INTO camera_point_rtree (id, min_lng, max_lng, min_lat, max_lat) VALUES (?, ?, ?, ?, ?)',
  );
  let id = maxCameraId(db);
  let added = 0;
  let deduped = 0;
  const added0 = id;

  const rl = createInterface({ input: process.stdin, terminal: false });
  db.exec('BEGIN');
  for await (const rawLine of rl) {
    const text = rawLine.charCodeAt(0) === 0x1e ? rawLine.slice(1) : rawLine;
    if (!text.trim()) continue;
    let feature;
    try {
      feature = JSON.parse(text);
    } catch {
      continue;
    }
    if (feature?.geometry?.type !== 'Point') continue;
    const coords = feature.geometry.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) continue;
    const [lng, lat] = coords;
    if (typeof lat !== 'number' || typeof lng !== 'number' || !inBbox(lat, lng)) continue;
    const cam = osmCameraFromTags(feature.properties ?? {}, lat, lng);
    if (!cam) continue;
    if (nvdbCameras.some(([nLat, nLng]) => distM(lat, lng, nLat, nLng) <= DEDUPE_M)) {
      deduped++;
      continue;
    }
    id++;
    insPt.run(id, cam.name, cam.bearingDeg, cam.lat, cam.lng);
    insPtBox.run(id, cam.lng, cam.lng, cam.lat, cam.lat);
    // Guard against two OSM cameras mapped metres apart double-warning.
    nvdbCameras.push([cam.lat, cam.lng]);
    added++;
  }
  db.exec('COMMIT');
  console.log(`    OSM cameras: ${added} added, ${deduped} deduped against NVDB`);
  return { added, ignored: id === added0 };
}

async function main() {
  console.log(`==> pack nvdb.sqlite → ${outPath} (bbox ${bboxArg})`);
  const db = openOut(outPath);
  const nvdb = importNvdbClip(db, masterPath);
  const osm = await importOsmCameras(db, nvdb.nvdbCameras);
  db.exec('PRAGMA optimize; VACUUM;');
  const empty = nvdb.speed === 0 && nvdb.points === 0 && nvdb.sections === 0 && osm.added === 0;
  db.close();
  if (empty) {
    rmSync(outPath);
    console.log('==> no road data for this region — nvdb.sqlite skipped');
  } else {
    console.log('==> done');
  }
}

main().catch((err) => {
  console.error('pack nvdb build failed:', err.message);
  process.exit(1);
});
