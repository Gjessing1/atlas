#!/usr/bin/env node
// Build an offline search database from an OSM extract: a SQLite file with an
// FTS5 `places` table the Android app queries when the server is unreachable.
// Principal OSM kind powers category browse; Wikipedia/Wikivoyage refs are
// enriched into `place_content` by enrich-place-content.mjs.
//
// Input: GeoJSONSeq (one feature per line) produced by `osmium export` from a
// regional .osm.pbf — see build-pack.sh, which pipes it in. Only named
// features are indexed; polygons/lines are collapsed to a representative
// point by osmium (we ask for centroids).
//
// Usage: node build-search-db.mjs <out.sqlite> [region-label] < features.geojsonseq

import { createInterface } from 'node:readline';
import { unlinkSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const [out, regionLabel = ''] = process.argv.slice(2);
if (!out) {
  console.error('usage: build-search-db.mjs <out.sqlite> [region-label] < features.geojsonseq');
  process.exit(1);
}
if (existsSync(out)) unlinkSync(out);

const db = new DatabaseSync(out);
db.exec(`
  CREATE VIRTUAL TABLE places USING fts5(
    name, label, lat UNINDEXED, lng UNINDEXED, kind UNINDEXED,
    wikipedia UNINDEXED, wikivoyage UNINDEXED,
    tokenize = 'unicode61 remove_diacritics 2'
  );
  CREATE TABLE place_content (
    place_rowid INTEGER NOT NULL,
    source TEXT NOT NULL CHECK(source IN ('wikipedia', 'wikivoyage')),
    language TEXT NOT NULL,
    title TEXT NOT NULL,
    extract TEXT NOT NULL,
    url TEXT NOT NULL,
    PRIMARY KEY (place_rowid, source)
  );
`);

// Which OSM tags make a feature worth finding by name (roughly Photon's set).
const KEYS = [
  'place',
  'natural',
  // A trailhead is more specific than its generic tourism=information tag and
  // must retain that identity for profile-aware Explore categories.
  'information',
  'tourism',
  'amenity',
  'leisure',
  'shop',
  'historic',
  'barrier',
  'waterway',
  'highway',
  'peak',
];

function centroid(geometry) {
  switch (geometry?.type) {
    case 'Point':
      return geometry.coordinates;
    case 'LineString':
      return geometry.coordinates[Math.floor(geometry.coordinates.length / 2)];
    case 'Polygon':
      return geometry.coordinates[0]?.[0];
    case 'MultiPolygon':
      return geometry.coordinates[0]?.[0]?.[0];
    default:
      return undefined;
  }
}

const insert = db.prepare(
  'INSERT INTO places (name, label, lat, lng, kind, wikipedia, wikivoyage) VALUES (?, ?, ?, ?, ?, ?, ?)',
);
let count = 0;
db.exec('BEGIN');
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  // GeoJSONSeq lines may carry a RS (0x1e) prefix.
  const text = line.charCodeAt(0) === 0x1e ? line.slice(1) : line;
  if (!text.trim()) return;
  let feature;
  try {
    feature = JSON.parse(text);
  } catch {
    return;
  }
  const props = feature.properties ?? {};
  const name = props.name;
  if (!name) return;
  const kind = KEYS.map((k) => props[k]).find(Boolean);
  if (!kind && !props.place) return;
  const point = centroid(feature.geometry);
  if (!point) return;
  const [lng, lat] = point;
  const labelParts = [kind, regionLabel].filter(Boolean);
  const principal = KEYS.find((key) => props[key]);
  const kindTag = principal ? `${principal}/${props[principal]}` : '';
  insert.run(
    String(name),
    labelParts.join(', '),
    lat,
    lng,
    kindTag,
    typeof props.wikipedia === 'string' ? props.wikipedia : '',
    typeof props.wikivoyage === 'string' ? props.wikivoyage : '',
  );
  count++;
});
rl.on('close', () => {
  db.exec('COMMIT');
  db.exec("INSERT INTO places(places) VALUES('optimize')");
  db.close();
  console.log(`${out}: indexed ${count} named places`);
});
