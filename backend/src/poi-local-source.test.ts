import { mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { poiTilesForBbox, type PoiTilePair } from '@atlas/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalPoiSource } from './poi-local-source.js';
import { StatusRegistry } from './status.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(name: string, target = 'europe.sqlite', format = '1'): string {
  const root = roots.at(-1)!;
  const dir = path.join(root, 'poi');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, target);
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE metadata (name TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE pois (
      id INTEGER PRIMARY KEY, osm_type TEXT NOT NULL, osm_id TEXT NOT NULL,
      lat REAL NOT NULL, lng REAL NOT NULL, name TEXT NOT NULL, tags TEXT NOT NULL
    );
    CREATE TABLE poi_categories (
      poi_id INTEGER NOT NULL, category_id TEXT NOT NULL,
      PRIMARY KEY (poi_id, category_id)
    );
    CREATE VIRTUAL TABLE poi_rtree USING rtree(id, min_lng, max_lng, min_lat, max_lat);
  `);
  const meta = db.prepare('INSERT INTO metadata VALUES (?, ?)');
  meta.run('format_version', format);
  meta.run('source_timestamp', '2026-09-06T20:21:35Z');
  meta.run('feature_count', '1');
  meta.run(
    'coverage',
    JSON.stringify({
      outers: [
        [
          [0, 50],
          [20, 50],
          [20, 70],
          [0, 70],
          [0, 50],
        ],
      ],
      holes: [],
    }),
  );
  db.prepare('INSERT INTO pois VALUES (1, ?, ?, ?, ?, ?, ?)').run(
    'node',
    '42',
    59.905,
    10.745,
    name,
    JSON.stringify({
      amenity: 'cafe',
      name,
      phone: '+47 12345678',
      'addr:street': 'Kartgata',
      'addr:housenumber': '1',
      'addr:city': 'Oslo',
    }),
  );
  db.prepare('INSERT INTO poi_categories VALUES (1, ?)').run('coffee');
  db.prepare('INSERT INTO poi_rtree VALUES (1, 10.745, 10.745, 59.905, 59.905)').run();
  db.close();
  return file;
}

function setup(): { root: string; pair: PoiTilePair } {
  const root = mkdtempSync(path.join(tmpdir(), 'atlas-pois-'));
  roots.push(root);
  const tile = poiTilesForBbox([10.745, 59.905, 10.745001, 59.905001], 14)[0]!;
  return { root, pair: { tile, category: 'coffee' } };
}

describe('LocalPoiSource', () => {
  it('answers a tile from the R-tree with the public API result shape', () => {
    const { root, pair } = setup();
    fixture('Atlas coffee');
    const source = new LocalPoiSource(root);
    expect(source.covers(pair.tile)).toBe(true);
    expect(source.get([pair])).toEqual([
      expect.objectContaining({
        category: 'coffee',
        complete: true,
        results: [
          expect.objectContaining({
            id: 'node/42',
            name: 'Atlas coffee',
            address: 'Kartgata 1, Oslo',
            phone: '+47 12345678',
          }),
        ],
      }),
    ]);
    source.close();
  });

  it('reopens an atomically replaced build and rejects a broken replacement', () => {
    const { root, pair } = setup();
    const live = fixture('First');
    const onError = vi.fn();
    const source = new LocalPoiSource(root, undefined, Date.now, onError);
    expect(source.get([pair])[0]!.results[0]!.name).toBe('First');

    renameSync(fixture('Second', 'candidate.sqlite'), live);
    expect(source.get([pair])[0]!.results[0]!.name).toBe('Second');

    renameSync(fixture('Broken', 'candidate.sqlite', '999'), live);
    expect(source.get([pair])[0]!.results[0]!.name).toBe('Second');
    expect(onError).toHaveBeenCalledOnce();
    source.close();
  });

  it('reports provenance and warns after ten weeks', () => {
    const { root } = setup();
    fixture('Atlas coffee');
    const now = Date.parse('2026-11-20T00:00:00Z');
    const status = new StatusRegistry(() => now);
    const source = new LocalPoiSource(root, status, () => now);
    source.refreshStatus();
    expect(status.toStatus().find((item) => item.id === 'pois')).toMatchObject({
      health: 'degraded',
      detail: expect.stringContaining('OSM data from 2026-09-06 · 1 places'),
      warning: expect.stringContaining('days old'),
    });
    source.close();
  });

  it('partitions outside-Europe tiles to the fallback', () => {
    const { root, pair } = setup();
    fixture('Atlas coffee');
    const outside = poiTilesForBbox([-75, 40, -74.9, 40.1], 9)[0]!;
    const source = new LocalPoiSource(root);
    expect(source.partition([pair, { tile: outside, category: 'coffee' }])).toMatchObject({
      local: [pair],
      remote: [{ tile: outside, category: 'coffee' }],
    });
    source.close();
  });
});
