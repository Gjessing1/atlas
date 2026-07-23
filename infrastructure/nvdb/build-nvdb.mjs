#!/usr/bin/env node
// Build the offline NVDB dataset (ROADMAP §2.1): speed limits + ATK cameras.
//
//   node build-nvdb.mjs [out.sqlite] [minLng,minLat,maxLng,maxLat]
//   node build-nvdb.mjs /mnt/data/atlas/nvdb/nvdb.sqlite            # all Norway
//   node build-nvdb.mjs ./nvdb-oslo.sqlite 10.4,59.7,11.0,60.1     # one bbox
//
// Imports Vegvesen NVDB object types 105 (Fartsgrense — the authoritative
// Norwegian posted speed limits), 162 (Punkt-ATK speed cameras) and 823
// (Streknings-ATK average-speed sections) into a SQLite the backend and
// Android packs read via NvdbStore / @atlas/routing. This is the offline
// artefact the §2.1 rule demands: NVDB is an online service, but limits and
// camera sites are static (sites move on the order of years), so they are
// baked into a shipped file rather than fetched live.
//
// No account, API key or registration: Vegvesen's open-data terms exempt road
// data, and the API answers with just an X-Client header (verified 2026-07-20).
// Meant to run occasionally (like the Planetiler basemap build), not per request.
//
// Direction resolution (validated 2026-07-23 against 25 cameras whose names
// state the controlled direction — "… mot Førde" — geocoded and compared;
// 24 agree, the 25th is a geocoding artefact): geometry follows the
// stedfesting, whose `retning` MED/MOT relates it to the metering direction,
// and Kontrollretning ("Med/Mot metreringsretning") relates the *controlled*
// travel direction to the same metering. So travel follows the geometry order
// iff the two agree:  flip = (retning === 'MOT') !== (kontrollretning is Mot).
// Point cameras get a compass bearing from the road-link geometry at their
// stedfesting position (vegnett API); section geometry is stored pre-flipped
// into travel order so the conflation only checks traversal order.
//
// Output schema (mirror of backend/src/nvdb-db.ts):
//   speed_segment(id INTEGER PK, limit_kph INTEGER, geom TEXT)  geom="[[lat,lng],…]"
//   speed_rtree(id, min_lng, max_lng, min_lat, max_lat)         bbox index
//   camera_point(id, name, bearing_deg, lat, lng)               + camera_point_rtree
//   camera_section(id, name, geom)  geom in travel order        + camera_section_rtree

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const API_BASE = 'https://nvdbapiles.atlas.vegvesen.no';
const X_CLIENT = process.env.NVDB_CLIENT ?? 'atlas-offline-pipeline';
const PAGE = 1000; // API max page size.
// egenskap 2021 = the posted limit; 5127 = valid-from date (unused, but the
// object always carries the limit under 2021).
const EGENSKAP_FARTSGRENSE = 2021;
// Punkt-ATK (162): 9522 = name, 9527 = Kontrollretning (NVDB spells the
// display name "Kontollretning"; match by id, not name).
const EGENSKAP_ATK_NAVN = 9522;
const EGENSKAP_ATK_RETNING = 9527;
// Streknings-ATK (823): 9520 = name, 9519 = Kontrollretning.
const EGENSKAP_SATK_NAVN = 9520;
const EGENSKAP_SATK_RETNING = 9519;

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

/**
 * Parse a WKT MULTILINESTRING into one stitched `[[lat, lng], …]` — the parts
 * arrive contiguous for a section spanning several road links. Returns null
 * when a junction gap says they are not actually one line.
 */
function parseMultiLineString(wkt) {
  const m = /^MULTILINESTRING\s*(?:Z\s*)?\((.*)\)\s*$/i.exec(wkt ?? '');
  if (!m) return null;
  const out = [];
  for (const part of m[1].split(/\)\s*,\s*\(/)) {
    const points = parseLineString(`LINESTRING(${part.replace(/[()]/g, '')})`);
    if (!points) return null;
    if (out.length > 0) {
      const [aLat, aLng] = out[out.length - 1];
      const [bLat, bLng] = points[0];
      const gapM = Math.hypot(
        (bLat - aLat) * 111_320,
        (bLng - aLng) * 111_320 * Math.cos((aLat * Math.PI) / 180),
      );
      if (gapM > 100) return null;
    }
    out.push(...points);
  }
  return out.length >= 2 ? out : null;
}

/** Parse a WKT POINT (with or without Z) into `[lat, lng]`. */
function parsePoint(wkt) {
  const m = /^POINT\s*(?:Z\s*)?\(([^)]*)\)/i.exec(wkt ?? '');
  if (!m) return null;
  const nums = m[1].trim().split(/\s+/).map(Number);
  return nums.length >= 2 && Number.isFinite(nums[0]) && Number.isFinite(nums[1])
    ? [nums[0], nums[1]]
    : null;
}

/** GET a JSON NVDB resource, retrying transient failures. */
async function fetchJson(url) {
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
    if (res.ok) return res.json();
    // 429/5xx are transient; back off and retry. A 4xx (bad bbox) is fatal.
    if (res.status < 500 && res.status !== 429) {
      throw new Error(`NVDB ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    if (attempt >= 5) throw new Error(`NVDB ${res.status} after ${attempt} attempts`);
    await new Promise((r) => setTimeout(r, 1000 * attempt));
  }
}

/** One page of vegobjekter of `type`; returns `{ objects, next }`. */
async function fetchPage(type, start, extraParams = {}) {
  const params = new URLSearchParams({
    inkluder: 'egenskaper,lokasjon',
    srid: '4326',
    antall: String(PAGE),
    kartutsnitt: bbox,
    ...extraParams,
  });
  if (start) params.set('start', start);
  const json = await fetchJson(`${API_BASE}/vegobjekter/api/v4/vegobjekter/${type}?${params}`);
  const next = json.metadata?.neste?.start ?? null;
  const objects = json.objekter ?? [];
  // The v4 API repeats the same `neste` cursor on the final (empty) page
  // forever, so "there is a cursor" is NOT "there is more" — an empty page or
  // a cursor that did not advance is the end (measured 2026-07-23).
  return { objects, next: objects.length === 0 || next === start ? null : next };
}

/** Every vegobjekt of `type` in the build extent. */
async function fetchAll(type, extraParams = {}) {
  const all = [];
  let start = null;
  do {
    const { objects, next } = await fetchPage(type, start, extraParams);
    all.push(...objects);
    start = next;
  } while (start);
  return all;
}

const egenskap = (obj, id) => obj.egenskaper?.find((e) => e.id === id)?.verdi;
const isMotMetrering = (verdi) => typeof verdi === 'string' && /^mot/i.test(verdi);

/** Initial bearing (deg from north) from `[lat,lng]` `a` to `b`. */
function bearingDeg(a, b) {
  const x = (b[1] - a[1]) * Math.cos((a[0] * Math.PI) / 180);
  const y = b[0] - a[0];
  return ((Math.atan2(x, y) * 180) / Math.PI + 360) % 360;
}

const distM = (a, b) =>
  Math.hypot((b[0] - a[0]) * 111_320, (b[1] - a[1]) * 111_320 * Math.cos((a[0] * Math.PI) / 180));

/** Geometry of one veglenkesekvens, cached (cameras on the same road share it). */
const linkCache = new Map();
async function fetchLink(veglenkesekvensid) {
  if (linkCache.has(veglenkesekvensid)) return linkCache.get(veglenkesekvensid);
  const json = await fetchJson(
    `${API_BASE}/vegnett/api/v4/veglenkesekvenser/${veglenkesekvensid}?srid=4326`,
  );
  linkCache.set(veglenkesekvensid, json);
  return json;
}

/**
 * The road's bearing (geometry order) at `relativPosisjon` of a
 * veglenkesekvens, from the active veglenke portion covering that position.
 */
async function linkBearingAt(veglenkesekvensid, relativPosisjon) {
  const json = await fetchLink(veglenkesekvensid);
  const link = (json.veglenker ?? []).find(
    (l) =>
      !('sluttdato' in l) &&
      l.startposisjon <= relativPosisjon &&
      relativPosisjon <= l.sluttposisjon,
  );
  const points = parseLineString(link?.geometri?.wkt);
  if (!points) return null;
  const lens = points.slice(1).map((p, i) => distM(points[i], p));
  const total = lens.reduce((a, b) => a + b, 0);
  if (total <= 0) return null;
  const frac =
    (relativPosisjon - link.startposisjon) / (link.sluttposisjon - link.startposisjon || 1);
  const target = total * Math.min(1, Math.max(0, frac));
  let acc = 0;
  let i = 0;
  for (; i < lens.length - 1 && acc + lens[i] < target; i++) acc += lens[i];
  return bearingDeg(points[i], points[i + 1]);
}

function openDb(file) {
  mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    DROP TABLE IF EXISTS speed_segment;
    DROP TABLE IF EXISTS speed_rtree;
    DROP TABLE IF EXISTS camera_point;
    DROP TABLE IF EXISTS camera_point_rtree;
    DROP TABLE IF EXISTS camera_section;
    DROP TABLE IF EXISTS camera_section_rtree;
    CREATE TABLE speed_segment (id INTEGER PRIMARY KEY, limit_kph INTEGER NOT NULL, geom TEXT NOT NULL);
    CREATE VIRTUAL TABLE speed_rtree USING rtree(id, min_lng, max_lng, min_lat, max_lat);
    CREATE TABLE camera_point (id INTEGER PRIMARY KEY, name TEXT, bearing_deg REAL, lat REAL NOT NULL, lng REAL NOT NULL);
    CREATE VIRTUAL TABLE camera_point_rtree USING rtree(id, min_lng, max_lng, min_lat, max_lat);
    CREATE TABLE camera_section (id INTEGER PRIMARY KEY, name TEXT, geom TEXT NOT NULL);
    CREATE VIRTUAL TABLE camera_section_rtree USING rtree(id, min_lng, max_lng, min_lat, max_lat);
  `);
  return db;
}

const boundsOf = (points) => {
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
  return { minLat, maxLat, minLng, maxLng };
};

async function importSpeedLimits(db) {
  console.log('==> Fartsgrense (105)');
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
    const { objects, next } = await fetchPage(105, start, { segmentering: 'true' });
    db.exec('BEGIN');
    for (const obj of objects) {
      seen++;
      const limit = egenskap(obj, EGENSKAP_FARTSGRENSE);
      const points = parseLineString(obj.lokasjon?.geometri?.wkt);
      if (typeof limit !== 'number' || limit <= 0 || !points) {
        skipped++;
        continue;
      }
      const b = boundsOf(points);
      id++;
      insSeg.run(id, limit, JSON.stringify(points));
      insBox.run(id, b.minLng, b.maxLng, b.minLat, b.maxLat);
    }
    db.exec('COMMIT');
    start = next;
    if (++page % 20 === 0 || !start) {
      console.log(`    page ${page}: ${seen} objects seen, ${id} stored, ${skipped} skipped`);
    }
  } while (start);
  console.log(`    done: ${id} speed segments (${skipped} without limit/geometry skipped)`);
}

async function importPointCameras(db) {
  console.log('==> Punkt-ATK (162)');
  const objects = await fetchAll(162);
  const ins = db.prepare(
    'INSERT INTO camera_point (id, name, bearing_deg, lat, lng) VALUES (?, ?, ?, ?, ?)',
  );
  const insBox = db.prepare(
    'INSERT INTO camera_point_rtree (id, min_lng, max_lng, min_lat, max_lat) VALUES (?, ?, ?, ?, ?)',
  );
  let id = 0;
  let skipped = 0;
  let noBearing = 0;
  for (const obj of objects) {
    const point = parsePoint(obj.lokasjon?.geometri?.wkt);
    if (!point) {
      skipped++;
      continue;
    }
    const name = egenskap(obj, EGENSKAP_ATK_NAVN);
    const kontroll = egenskap(obj, EGENSKAP_ATK_RETNING);
    const sted = obj.lokasjon?.stedfestinger?.[0];
    // Controlled travel bearing from the road link's geometry at the camera,
    // flipped per the XOR rule (see the header). Null when unresolvable — the
    // camera then warns both directions, which errs on the side of warning.
    let bearing = null;
    if (typeof kontroll === 'string' && sted?.veglenkesekvensid != null) {
      try {
        const geomBearing = await linkBearingAt(sted.veglenkesekvensid, sted.relativPosisjon ?? 0);
        if (geomBearing !== null) {
          const flip = (sted.retning === 'MOT') !== isMotMetrering(kontroll);
          bearing = (geomBearing + (flip ? 180 : 0)) % 360;
        }
      } catch {
        // Best-effort: a dead link lookup costs the direction, not the camera.
      }
    }
    if (bearing === null) noBearing++;
    id++;
    ins.run(id, typeof name === 'string' ? name : null, bearing, point[0], point[1]);
    insBox.run(id, point[1], point[1], point[0], point[0]);
  }
  console.log(
    `    done: ${id} point cameras (${skipped} without geometry, ${noBearing} without direction)`,
  );
}

async function importSectionCameras(db) {
  console.log('==> Streknings-ATK (823)');
  const objects = await fetchAll(823);
  const ins = db.prepare('INSERT INTO camera_section (id, name, geom) VALUES (?, ?, ?)');
  const insBox = db.prepare(
    'INSERT INTO camera_section_rtree (id, min_lng, max_lng, min_lat, max_lat) VALUES (?, ?, ?, ?, ?)',
  );
  let id = 0;
  let skipped = 0;
  for (const obj of objects) {
    const wkt = obj.lokasjon?.geometri?.wkt;
    const points = parseLineString(wkt) ?? parseMultiLineString(wkt);
    const kontroll = egenskap(obj, EGENSKAP_SATK_RETNING);
    const stedfestinger = obj.lokasjon?.stedfestinger ?? [];
    const retninger = new Set(stedfestinger.map((s) => s.retning).filter(Boolean));
    if (!points || typeof kontroll !== 'string' || retninger.size !== 1) {
      // A section whose pieces disagree on retning has no single geometry
      // order to flip; none exist today (86 objects checked), so refuse
      // loudly rather than guess.
      skipped++;
      console.warn(`    skipping 823/${obj.id}: geometry=${!!points} retninger=${retninger.size}`);
      continue;
    }
    const flip = retninger.has('MOT') !== isMotMetrering(kontroll);
    const travel = flip ? [...points].reverse() : points;
    const name = egenskap(obj, EGENSKAP_SATK_NAVN);
    const b = boundsOf(travel);
    id++;
    ins.run(id, typeof name === 'string' ? name : null, JSON.stringify(travel));
    insBox.run(id, b.minLng, b.maxLng, b.minLat, b.maxLat);
  }
  console.log(`    done: ${id} average-speed sections (${skipped} skipped)`);
}

async function main() {
  console.log(`==> NVDB → ${outPath}`);
  console.log(`    extent: ${bbox}`);
  const db = openDb(outPath);
  await importSpeedLimits(db);
  await importPointCameras(db);
  await importSectionCameras(db);
  db.exec('PRAGMA optimize; VACUUM;');
  db.close();
  console.log('==> done');
}

main().catch((err) => {
  console.error('NVDB build failed:', err.message);
  process.exit(1);
});
