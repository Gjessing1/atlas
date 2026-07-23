#!/usr/bin/env node
// Build the offline NVDB speed-limit dataset (ROADMAP §2.1).
//
//   node build-nvdb.mjs [out.sqlite] [minLng,minLat,maxLng,maxLat]
//   node build-nvdb.mjs /mnt/data/atlas/nvdb/nvdb.sqlite            # all Norway
//   node build-nvdb.mjs ./nvdb-oslo.sqlite 10.4,59.7,11.0,60.1     # one bbox
//
// Imports Vegvesen NVDB object type 105 (Fartsgrense) — the authoritative
// Norwegian posted speed limits — into a SQLite the backend and Android packs
// read via NvdbStore / @atlas/routing's nvdbSpeedOverrides. This is the offline
// artefact the §2.1 rule demands: NVDB is an online service, but a speed limit
// is static, so it is baked into a shipped file rather than fetched live.
//
// No account, API key or registration: Vegvesen's open-data terms exempt road
// data, and the API answers with just an X-Client header (verified 2026-07-20).
// Meant to run occasionally (like the Planetiler basemap build), not per request.
//
// Output schema (mirror of backend/src/nvdb-db.ts):
//   speed_segment(id INTEGER PK, limit_kph INTEGER, geom TEXT)  geom="[[lat,lng],…]"
//   speed_rtree(id, min_lng, max_lng, min_lat, max_lat)         bbox index

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const API = 'https://nvdbapiles.atlas.vegvesen.no/vegobjekter/api/v4/vegobjekter/105';
const X_CLIENT = process.env.NVDB_CLIENT ?? 'atlas-offline-pipeline';
const PAGE = 1000; // API max page size.
// egenskap 2021 = the posted limit; 5127 = valid-from date (unused, but the
// object always carries the limit under 2021).
const EGENSKAP_FARTSGRENSE = 2021;

// Default extent: mainland Norway plus the coastal margin. Svalbard is out of
// scope (no NVDB road network there worth shipping).
const NORWAY_BBOX = '4.0,57.9,31.6,71.3';

const outPath = process.argv[2] ?? '/mnt/data/atlas/nvdb/nvdb.sqlite';
const bbox = process.argv[3] ?? NORWAY_BBOX;

/**
 * Parse a WKT LINESTRING (with or without a Z ordinate) into `[[lat, lng], …]`.
 * NVDB returns srid=4326 geometry as `lat lng z` triples. Non-LINESTRING
 * geometries (the rare MULTILINESTRING) are skipped by the caller.
 */
function parseLineString(wkt) {
  const m = /^LINESTRING\s*(?:Z\s*)?\(([^)]*)\)/i.exec(wkt ?? '');
  if (!m) return null;
  const points = [];
  for (const pair of m[1].split(',')) {
    const nums = pair.trim().split(/\s+/).map(Number);
    if (nums.length >= 2 && Number.isFinite(nums[0]) && Number.isFinite(nums[1])) {
      // Round to ~0.1 m so the JSON geometry stays compact.
      points.push([Math.round(nums[0] * 1e6) / 1e6, Math.round(nums[1] * 1e6) / 1e6]);
    }
  }
  return points.length >= 2 ? points : null;
}

/** One page of type-105 objects; returns `{ objects, next }`. */
async function fetchPage(start) {
  const params = new URLSearchParams({
    inkluder: 'egenskaper,lokasjon',
    srid: '4326',
    segmentering: 'true',
    antall: String(PAGE),
    kartutsnitt: bbox,
  });
  if (start) params.set('start', start);
  const url = `${API}?${params}`;
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        headers: { 'X-Client': X_CLIENT, Accept: 'application/json' },
      });
    } catch (err) {
      if (attempt >= 5) throw err;
      await new Promise((r) => setTimeout(r, 1000 * attempt));
      continue;
    }
    if (res.ok) {
      const json = await res.json();
      return { objects: json.objekter ?? [], next: json.metadata?.neste?.start ?? null };
    }
    // 429/5xx are transient; back off and retry. A 4xx (bad bbox) is fatal.
    if (res.status < 500 && res.status !== 429) {
      throw new Error(`NVDB ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    if (attempt >= 5) throw new Error(`NVDB ${res.status} after ${attempt} attempts`);
    await new Promise((r) => setTimeout(r, 1000 * attempt));
  }
}

function openDb(file) {
  mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    DROP TABLE IF EXISTS speed_segment;
    DROP TABLE IF EXISTS speed_rtree;
    CREATE TABLE speed_segment (id INTEGER PRIMARY KEY, limit_kph INTEGER NOT NULL, geom TEXT NOT NULL);
    CREATE VIRTUAL TABLE speed_rtree USING rtree(id, min_lng, max_lng, min_lat, max_lat);
  `);
  return db;
}

async function main() {
  console.log(`==> NVDB Fartsgrense (105) → ${outPath}`);
  console.log(`    extent: ${bbox}`);
  const db = openDb(outPath);
  const insSeg = db.prepare('INSERT INTO speed_segment (id, limit_kph, geom) VALUES (?, ?, ?)');
  const insBox = db.prepare(
    'INSERT INTO speed_rtree (id, min_lng, max_lng, min_lat, max_lat) VALUES (?, ?, ?, ?, ?)',
  );

  let id = 0;
  let seen = 0;
  let skipped = 0;
  let start = null;
  let page = 0;
  do {
    const { objects, next } = await fetchPage(start);
    db.exec('BEGIN');
    for (const obj of objects) {
      seen++;
      const limit = obj.egenskaper?.find((e) => e.id === EGENSKAP_FARTSGRENSE)?.verdi;
      const points = parseLineString(obj.lokasjon?.geometri?.wkt);
      if (typeof limit !== 'number' || limit <= 0 || !points) {
        skipped++;
        continue;
      }
      let minLat = Infinity,
        maxLat = -Infinity,
        minLng = Infinity,
        maxLng = -Infinity;
      for (const [lat, lng] of points) {
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
        if (lng < minLng) minLng = lng;
        if (lng > maxLng) maxLng = lng;
      }
      id++;
      insSeg.run(id, limit, JSON.stringify(points));
      insBox.run(id, minLng, maxLng, minLat, maxLat);
    }
    db.exec('COMMIT');
    start = next;
    if (++page % 20 === 0 || !start) {
      console.log(`    page ${page}: ${seen} objects seen, ${id} stored, ${skipped} skipped`);
    }
  } while (start);

  db.exec('PRAGMA optimize; VACUUM;');
  db.close();
  console.log(`==> done: ${id} speed segments (${skipped} without limit/geometry skipped)`);
}

main().catch((err) => {
  console.error('NVDB build failed:', err.message);
  process.exit(1);
});
