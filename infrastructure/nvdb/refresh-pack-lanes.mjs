#!/usr/bin/env node
// Add/replace only the NVDB 616 lane tables in an already-built region pack.
// This preserves its basemap, search, routing, assets and OSM camera rows while
// allowing a new national road-data table to ship without rebuilding Valhalla.
//
//   node refresh-pack-lanes.mjs <pack-dir> [master-nvdb.sqlite]

// The manifest version and nvdb digest are updated, so installed packs are
// honestly reported stale and the normal verified/atomic update path applies.

import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const [packDir, masterPath = '/mnt/data/atlas/nvdb/nvdb.sqlite'] = process.argv.slice(2);
if (!packDir) {
  console.error('usage: refresh-pack-lanes.mjs <pack-dir> [master-nvdb.sqlite]');
  process.exit(1);
}

const manifestPath = path.join(packDir, 'pack.json');
const nvdbPath = path.join(packDir, 'nvdb.sqlite');
for (const file of [manifestPath, nvdbPath, masterPath]) {
  if (!existsSync(file)) throw new Error(`missing ${file}`);
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const { sw, ne } = manifest.bbox ?? {};
if (
  !sw ||
  !ne ||
  ![sw.lng, sw.lat, ne.lng, ne.lat].every((value) => typeof value === 'number') ||
  !manifest.files?.nvdb
) {
  throw new Error(`invalid pack manifest ${manifestPath}`);
}

const db = new DatabaseSync(nvdbPath);
db.prepare('ATTACH DATABASE ? AS master').run(masterPath);
db.exec(`
  BEGIN IMMEDIATE;
  DROP TABLE IF EXISTS main.lane_segment;
  DROP TABLE IF EXISTS main.lane_rtree;
  CREATE TABLE main.lane_segment (id INTEGER PRIMARY KEY, field_codes TEXT NOT NULL, geom TEXT NOT NULL);
  CREATE VIRTUAL TABLE main.lane_rtree USING rtree(id, min_lng, max_lng, min_lat, max_lat);
`);
db.prepare(
  `INSERT INTO lane_segment (id, field_codes, geom)
   SELECT s.id, s.field_codes, s.geom
     FROM master.lane_rtree r JOIN master.lane_segment s ON s.id = r.id
    WHERE r.min_lng <= ? AND r.max_lng >= ? AND r.min_lat <= ? AND r.max_lat >= ?`,
).run(ne.lng, sw.lng, ne.lat, sw.lat);
db.prepare(
  `INSERT INTO lane_rtree (id, min_lng, max_lng, min_lat, max_lat)
   SELECT id, min_lng, max_lng, min_lat, max_lat
     FROM master.lane_rtree
    WHERE min_lng <= ? AND max_lng >= ? AND min_lat <= ? AND max_lat >= ?`,
).run(ne.lng, sw.lng, ne.lat, sw.lat);
db.exec('COMMIT; DETACH DATABASE master; PRAGMA optimize; VACUUM;');
const count = db.prepare('SELECT count(*) AS count FROM lane_segment').get().count;
db.close();

const sha256 = await new Promise((resolve, reject) => {
  const hash = createHash('sha256');
  createReadStream(nvdbPath)
    .on('data', (chunk) => hash.update(chunk))
    .on('error', reject)
    .on('end', () => resolve(hash.digest('hex')));
});
const now = Date.now();
manifest.version = now;
manifest.builtAt = now;
manifest.files.nvdb.bytes = statSync(nvdbPath).size;
manifest.files.nvdb.sha256 = sha256;
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`${manifest.id}: ${count} lane segments; nvdb ${manifest.files.nvdb.bytes} bytes`);
