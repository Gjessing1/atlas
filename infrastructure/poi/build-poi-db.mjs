#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const [output, configFile, sourceTimestamp, sourceUrl, sourceMd5, coverageFile, startedArg] =
  process.argv.slice(2);
if (
  !output ||
  !configFile ||
  !sourceTimestamp ||
  !sourceUrl ||
  !sourceMd5 ||
  !coverageFile ||
  !startedArg
) {
  console.error(
    'usage: build-poi-db.mjs <output> <config.json> <source timestamp> <source URL> <source md5> <coverage.poly> <build-start epoch-seconds>',
  );
  process.exit(2);
}

const config = JSON.parse(readFileSync(configFile, 'utf8'));
const wantedTags = new Set(config.tagKeys);

function parsePoly(text) {
  const lines = text.split(/\r?\n/);
  const outers = [];
  const holes = [];
  let ring = null;
  let hole = false;
  // First line is the polygon name; every subsequent non-END heading begins a ring.
  for (const raw of lines.slice(1)) {
    const line = raw.trim();
    if (!line) continue;
    if (line === 'END') {
      if (ring) {
        (hole ? holes : outers).push(ring);
        ring = null;
      } else {
        break;
      }
      continue;
    }
    const values = line.split(/\s+/).map(Number);
    if (values.length === 2 && values.every(Number.isFinite)) {
      ring?.push(values);
    } else {
      hole = line.startsWith('!');
      ring = [];
    }
  }
  if (!outers.length) throw new Error(`${coverageFile}: no outer ring`);
  return { outers, holes };
}

function categoriesFor(tags) {
  return config.categories
    .filter((category) =>
      category.selectors.some((selector) => {
        const value = tags[selector.key];
        return value !== undefined && (!selector.values || selector.values.includes(value));
      }),
    )
    .map((category) => category.id);
}

function geometryCenter(geometry) {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  const visit = (coordinates) => {
    if (
      Array.isArray(coordinates) &&
      coordinates.length >= 2 &&
      Number.isFinite(coordinates[0]) &&
      Number.isFinite(coordinates[1])
    ) {
      west = Math.min(west, coordinates[0]);
      east = Math.max(east, coordinates[0]);
      south = Math.min(south, coordinates[1]);
      north = Math.max(north, coordinates[1]);
      return;
    }
    if (Array.isArray(coordinates)) for (const child of coordinates) visit(child);
  };
  if (geometry?.type === 'GeometryCollection') {
    for (const child of geometry.geometries ?? []) visit(child.coordinates);
  } else {
    visit(geometry?.coordinates);
  }
  return Number.isFinite(west) ? { lng: (west + east) / 2, lat: (south + north) / 2 } : null;
}

const db = new DatabaseSync(output);
db.exec(`
  PRAGMA journal_mode = OFF;
  PRAGMA synchronous = OFF;
  PRAGMA locking_mode = EXCLUSIVE;
  PRAGMA temp_store = FILE;
  PRAGMA cache_size = -524288;
  CREATE TABLE metadata (name TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE pois (
    id INTEGER PRIMARY KEY,
    osm_type TEXT NOT NULL,
    osm_id TEXT NOT NULL,
    lat REAL NOT NULL,
    lng REAL NOT NULL,
    name TEXT NOT NULL,
    category_ids TEXT NOT NULL,
    tags TEXT NOT NULL,
    UNIQUE (osm_type, osm_id)
  );
  CREATE TABLE poi_categories (
    poi_id INTEGER NOT NULL REFERENCES pois(id),
    category_id TEXT NOT NULL
  );
  CREATE VIRTUAL TABLE poi_rtree USING rtree(id, min_lng, max_lng, min_lat, max_lat);
  BEGIN;
`);
const insertPoi = db.prepare(
  'INSERT OR IGNORE INTO pois (osm_type, osm_id, lat, lng, name, category_ids, tags) VALUES (?, ?, ?, ?, ?, ?, ?)',
);
const insertCategory = db.prepare('INSERT INTO poi_categories VALUES (?, ?)');
const insertRtree = db.prepare('INSERT INTO poi_rtree VALUES (?, ?, ?, ?, ?)');
let featureCount = 0;
const counts = Object.fromEntries(config.categories.map((category) => [category.id, 0]));

try {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (let line of lines) {
    line = line.trim();
    if (line.codePointAt(0) === 0x1e) line = line.slice(1);
    if (!line) continue;
    const feature = JSON.parse(line);
    const properties = feature.properties ?? {};
    const tags = Object.fromEntries(
      Object.entries(properties).filter(
        ([key, value]) => !key.startsWith('@') && wantedTags.has(key) && typeof value === 'string',
      ),
    );
    const categoryIds = categoriesFor(tags);
    if (!categoryIds.length) continue;
    const center = geometryCenter(feature.geometry);
    if (!center) continue;
    const osmType = properties['@type'];
    const osmId = properties['@id'];
    if (!['node', 'way', 'relation'].includes(osmType) || !/^\d+$/.test(String(osmId))) continue;
    const name = tags.name || tags.brand || tags.operator || '';
    const result = insertPoi.run(
      osmType,
      String(osmId),
      center.lat,
      center.lng,
      name,
      JSON.stringify(categoryIds),
      JSON.stringify(tags),
    );
    if (result.changes === 0) continue;
    const id = Number(result.lastInsertRowid);
    insertRtree.run(id, center.lng, center.lng, center.lat, center.lat);
    for (const category of categoryIds) {
      insertCategory.run(id, category);
      counts[category]++;
    }
    featureCount++;
    if (featureCount % 100_000 === 0)
      console.error(`    imported ${featureCount.toLocaleString()} places`);
  }
  const coverage = parsePoly(readFileSync(coverageFile, 'utf8'));
  const elapsed = Math.max(0, Math.round(Date.now() / 1000 - Number(startedArg)));
  const putMeta = db.prepare('INSERT INTO metadata VALUES (?, ?)');
  for (const [name, value] of Object.entries({
    format_version: '1',
    source_timestamp: sourceTimestamp,
    source_url: sourceUrl,
    source_md5: sourceMd5,
    filter_sha256: config.filterDigest,
    build_started_at: new Date(Number(startedArg) * 1000).toISOString(),
    built_at: new Date().toISOString(),
    build_seconds: String(elapsed),
    feature_count: String(featureCount),
    category_counts: JSON.stringify(counts),
    coverage: JSON.stringify(coverage),
  })) {
    putMeta.run(name, value);
  }
  db.exec(`
    COMMIT;
    CREATE UNIQUE INDEX poi_categories_pair ON poi_categories (poi_id, category_id);
    ANALYZE;
    PRAGMA optimize;
  `);
  console.error(`    imported ${featureCount.toLocaleString()} places total`);
} catch (error) {
  try {
    db.exec('ROLLBACK');
  } catch {
    // The original error is the useful one.
  }
  throw error;
} finally {
  db.close();
}
