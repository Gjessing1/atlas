import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { POI_CATEGORIES } from '@atlas/core';
import { afterEach, describe, expect, it } from 'vitest';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Europe POI producer', () => {
  it('derives every filter from POI_CATEGORIES and imports point/area centres', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'atlas-poi-producer-'));
    roots.push(root);
    const filter = path.join(root, 'filter.txt');
    const config = path.join(root, 'config.json');
    const generated = spawnSync(
      process.execPath,
      [path.join(repo, 'infrastructure/poi/generate-config.mjs'), filter, config],
      { cwd: repo, encoding: 'utf8' },
    );
    expect(generated.status, generated.stderr).toBe(0);
    const expressions = new Set(readFileSync(filter, 'utf8').trim().split('\n'));
    for (const category of POI_CATEGORIES) {
      for (const selector of category.selectors) {
        const expected = selector.values?.length
          ? selector.values.map((value) => `nwr/${selector.key}=${value}`)
          : [`nwr/${selector.key}`];
        expected.forEach((item) => expect(expressions.has(item), item).toBe(true));
      }
    }

    const poly = path.join(root, 'europe.poly');
    writeFileSync(poly, 'europe\neurope\n 0 50\n 20 50\n 20 70\n 0 70\n 0 50\nEND\nEND\n');
    const dbFile = path.join(root, 'europe.sqlite');
    const records = [
      {
        type: 'Feature',
        properties: {
          '@type': 'node',
          '@id': 42,
          amenity: 'cafe',
          name: 'Atlas coffee',
          unrelated: 'discard me',
        },
        geometry: { type: 'Point', coordinates: [10.75, 59.91] },
      },
      {
        type: 'Feature',
        properties: { '@type': 'way', '@id': 43, shop: 'hardware', name: 'Atlas tools' },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [10, 59],
              [12, 59],
              [12, 61],
              [10, 61],
              [10, 59],
            ],
          ],
        },
      },
    ]
      .map((record) => `\u001e${JSON.stringify(record)}`)
      .join('\n');
    const imported = spawnSync(
      process.execPath,
      [
        path.join(repo, 'infrastructure/poi/build-poi-db.mjs'),
        dbFile,
        config,
        '2026-09-06T20:21:35Z',
        'https://example.test/europe.osm.pbf',
        'abc123',
        poly,
        String(Math.floor(Date.now() / 1000)),
      ],
      { cwd: repo, encoding: 'utf8', input: records },
    );
    expect(imported.status, imported.stderr).toBe(0);
    const db = new DatabaseSync(dbFile, { readOnly: true });
    expect(
      db.prepare('SELECT osm_type, osm_id, lat, lng, name, tags FROM pois ORDER BY id').all(),
    ).toEqual([
      {
        osm_type: 'node',
        osm_id: '42',
        lat: 59.91,
        lng: 10.75,
        name: 'Atlas coffee',
        tags: JSON.stringify({ amenity: 'cafe', name: 'Atlas coffee' }),
      },
      {
        osm_type: 'way',
        osm_id: '43',
        lat: 60,
        lng: 11,
        name: 'Atlas tools',
        tags: JSON.stringify({ shop: 'hardware', name: 'Atlas tools' }),
      },
    ]);
    expect(db.prepare('SELECT category_id FROM poi_categories ORDER BY poi_id').all()).toEqual([
      { category_id: 'coffee' },
      { category_id: 'shops' },
    ]);
    expect(db.prepare("SELECT value FROM metadata WHERE name='filter_sha256'").get()).toEqual({
      value: generated.stdout.trim(),
    });
    expect(db.prepare("SELECT value FROM metadata WHERE name='build_started_at'").get()).toEqual({
      value: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
    db.close();
  });

  it('stages atomically under bounded resources and installs the two-month refresh', () => {
    const builder = readFileSync(path.join(repo, 'infrastructure/poi/build-pois.sh'), 'utf8');
    const installer = readFileSync(
      path.join(repo, 'infrastructure/poi/install-refresh-cron.sh'),
      'utf8',
    );
    expect(builder).toContain('POI_DIR="${ATLAS_POI_DIR:-$DATA_DIR/poi}"');
    expect(builder).toContain('LIMITS=(--memory 6g --memory-swap 6g --cpus 2)');
    expect(builder).toContain('flock -n 8');
    expect(builder).toContain('flock -n 9');
    expect(builder.indexOf('smoke-poi-db.mjs')).toBeLessThan(
      builder.indexOf('mv -f "$CANDIDATE" "$CURRENT"'),
    );
    expect(installer).toContain('0 3 1 */2 *');
    expect(installer).toContain('/usr/bin/logger -t atlas-poi-refresh');
  });
});
