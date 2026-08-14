import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';

/**
 * The NVDB endpoints against a real dataset file — the same SQLite shape
 * build-nvdb.mjs writes, in a temp dataDir. Uses the nvdb.test.ts route
 * convention: a north-going line on 10°E, vertices 0.001° (~111 m) apart.
 */

let dirs: string[] = [];
let apps: FastifyInstance[] = [];

afterEach(async () => {
  for (const app of apps) await app.close();
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  apps = [];
  dirs = [];
});

async function tempDataDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'atlas-nvdb-'));
  dirs.push(dir);
  return dir;
}

function latAt(idx: number): number {
  return 60 + idx * 0.001;
}

function lineGeom(fromIdx: number, toIdx: number): string {
  const step = fromIdx <= toIdx ? 1 : -1;
  const pts: [number, number][] = [];
  for (let i = fromIdx; step > 0 ? i <= toIdx : i >= toIdx; i += step) {
    pts.push([latAt(i), 10]);
  }
  return JSON.stringify(pts);
}

function createSpeedTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE speed_segment (id INTEGER PRIMARY KEY, limit_kph INTEGER NOT NULL, geom TEXT NOT NULL);
    CREATE VIRTUAL TABLE speed_rtree USING rtree(id, min_lng, max_lng, min_lat, max_lat);
  `);
}

function createCameraTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE camera_point (id INTEGER PRIMARY KEY, name TEXT, bearing_deg REAL, lat REAL NOT NULL, lng REAL NOT NULL);
    CREATE VIRTUAL TABLE camera_point_rtree USING rtree(id, min_lng, max_lng, min_lat, max_lat);
    CREATE TABLE camera_section (id INTEGER PRIMARY KEY, name TEXT, geom TEXT NOT NULL);
    CREATE VIRTUAL TABLE camera_section_rtree USING rtree(id, min_lng, max_lng, min_lat, max_lat);
  `);
}

function createLaneTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE lane_segment (id INTEGER PRIMARY KEY, field_codes TEXT NOT NULL, geom TEXT NOT NULL);
    CREATE VIRTUAL TABLE lane_rtree USING rtree(id, min_lng, max_lng, min_lat, max_lat);
  `);
}

async function bootApp(dataDir: string): Promise<FastifyInstance> {
  const app = await buildApp({ dataDir });
  apps.push(app);
  return app;
}

const routeBody = (n: number) => ({
  points: Array.from({ length: n }, (_, i) => ({ lat: latAt(i), lng: 10 })),
});

describe('/api/route/nvdb-lanes', () => {
  it('matches a dedicated lane to the maneuver approaching it', async () => {
    const dataDir = await tempDataDir();
    await mkdir(path.join(dataDir, 'nvdb'), { recursive: true });
    const db = new DatabaseSync(path.join(dataDir, 'nvdb', 'nvdb.sqlite'));
    createSpeedTables(db);
    createLaneTables(db);
    db.prepare('INSERT INTO lane_segment VALUES (1, ?, ?)').run('1#1H1#2', lineGeom(4, 7));
    db.prepare('INSERT INTO lane_rtree VALUES (1, 10, 10, ?, ?)').run(latAt(4), latAt(7));
    db.close();

    const app = await bootApp(dataDir);
    const res = await app.inject({
      method: 'POST',
      url: '/api/route/nvdb-lanes',
      payload: {
        ...routeBody(10),
        instructions: [
          { sign: 0, interval: [0, 0] },
          { sign: 2, interval: [7, 8] },
          { sign: 4, interval: [9, 9] },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      overrides: [
        {
          instructionIndex: 1,
          lanes: [
            { directions: ['straight'], state: 'invalid' },
            { directions: ['right'], state: 'active', recommendedDirection: 'right' },
          ],
        },
      ],
    });
  });

  it('answers empty for an older dataset and malformed maneuver payloads', async () => {
    const dataDir = await tempDataDir();
    await mkdir(path.join(dataDir, 'nvdb'), { recursive: true });
    const db = new DatabaseSync(path.join(dataDir, 'nvdb', 'nvdb.sqlite'));
    createSpeedTables(db);
    db.close();
    const app = await bootApp(dataDir);
    const res = await app.inject({
      method: 'POST',
      url: '/api/route/nvdb-lanes',
      payload: { ...routeBody(10), instructions: ['bad'] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ overrides: [] });
  });
});

describe('/api/route/nvdb-cameras', () => {
  it('answers empty without a dataset file', async () => {
    const app = await bootApp(await tempDataDir());
    const res = await app.inject({
      method: 'POST',
      url: '/api/route/nvdb-cameras',
      payload: routeBody(20),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ cameras: { points: [], sections: [] } });
  });

  it('answers empty for a dataset built before the camera tables existed', async () => {
    const dataDir = await tempDataDir();
    await mkdir(path.join(dataDir, 'nvdb'), { recursive: true });
    const db = new DatabaseSync(path.join(dataDir, 'nvdb', 'nvdb.sqlite'));
    createSpeedTables(db);
    db.prepare('INSERT INTO speed_segment (id, limit_kph, geom) VALUES (1, 80, ?)').run(
      lineGeom(0, 19),
    );
    db.prepare('INSERT INTO speed_rtree VALUES (1, 9.999, 10.001, ?, ?)').run(latAt(0), latAt(19));
    db.close();

    const app = await bootApp(dataDir);
    const cams = await app.inject({
      method: 'POST',
      url: '/api/route/nvdb-cameras',
      payload: routeBody(20),
    });
    expect(cams.json()).toEqual({ cameras: { points: [], sections: [] } });
    // …while the speed half of the same file still answers.
    const limits = await app.inject({
      method: 'POST',
      url: '/api/route/nvdb-limits',
      payload: routeBody(20),
    });
    expect(limits.json().overrides).toHaveLength(1);
    expect(limits.json().overrides[0].limitKph).toBe(80);
  });

  it('matches point cameras and sections onto the posted route shape', async () => {
    const dataDir = await tempDataDir();
    await mkdir(path.join(dataDir, 'nvdb'), { recursive: true });
    const db = new DatabaseSync(path.join(dataDir, 'nvdb', 'nvdb.sqlite'));
    createSpeedTables(db);
    createCameraTables(db);
    // A northbound point camera on the route, a southbound one (other
    // carriageway), and one far away.
    const insPoint = db.prepare('INSERT INTO camera_point VALUES (?, ?, ?, ?, ?)');
    insPoint.run(1, 'northbound', 0, latAt(10), 10);
    insPoint.run(2, 'southbound', 180, latAt(12), 10);
    insPoint.run(3, 'elsewhere', 0, 59, 9);
    const insPointBox = db.prepare('INSERT INTO camera_point_rtree VALUES (?, ?, ?, ?, ?)');
    insPointBox.run(1, 10, 10, latAt(10), latAt(10));
    insPointBox.run(2, 10, 10, latAt(12), latAt(12));
    insPointBox.run(3, 9, 9, 59, 59);
    // An average-speed section over vertices 20..50, in travel (northbound) order.
    db.prepare('INSERT INTO camera_section VALUES (1, ?, ?)').run('S-ATK', lineGeom(20, 50));
    db.prepare('INSERT INTO camera_section_rtree VALUES (1, 10, 10, ?, ?)').run(
      latAt(20),
      latAt(50),
    );
    db.close();

    const app = await bootApp(dataDir);
    const res = await app.inject({
      method: 'POST',
      url: '/api/route/nvdb-cameras',
      payload: routeBody(60),
    });
    expect(res.statusCode).toBe(200);
    const { cameras } = res.json();
    expect(cameras.points.map((p: { name: string }) => p.name)).toEqual(['northbound']);
    expect(cameras.points[0].atM).toBeGreaterThan(1000);
    expect(cameras.points[0].atM).toBeLessThan(1230);
    expect(cameras.sections).toHaveLength(1);
    expect(cameras.sections[0].name).toBe('S-ATK');
    expect(cameras.sections[0].endM - cameras.sections[0].startM).toBeGreaterThan(3200);
  });

  it('answers empty for malformed bodies rather than erroring', async () => {
    const app = await bootApp(await tempDataDir());
    const res = await app.inject({
      method: 'POST',
      url: '/api/route/nvdb-cameras',
      payload: { points: 'nonsense' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ cameras: { points: [], sections: [] } });
  });
});

describe('speed-camera map layer', () => {
  it('lists the vector layer and serves the whole dataset as GeoJSON', async () => {
    const dataDir = await tempDataDir();
    await mkdir(path.join(dataDir, 'nvdb'), { recursive: true });
    const db = new DatabaseSync(path.join(dataDir, 'nvdb', 'nvdb.sqlite'));
    createSpeedTables(db);
    createCameraTables(db);
    db.prepare('INSERT INTO camera_point VALUES (1, ?, 0, ?, 10)').run('Fossen', latAt(10));
    db.prepare('INSERT INTO camera_point_rtree VALUES (1, 10, 10, ?, ?)').run(latAt(10), latAt(10));
    db.prepare('INSERT INTO camera_section VALUES (1, ?, ?)').run('S-ATK', lineGeom(20, 50));
    db.prepare('INSERT INTO camera_section_rtree VALUES (1, 10, 10, ?, ?)').run(
      latAt(20),
      latAt(50),
    );
    db.close();

    const app = await bootApp(dataDir);
    const catalog = await app.inject({ method: 'GET', url: '/api/layers' });
    const meta = catalog
      .json()
      .layers.find((l: { id: string }) => l.id === 'speed-cameras') as Record<string, unknown>;
    expect(meta).toBeDefined();
    expect(meta['vector']).toBe(true);
    expect(meta['profiles']).toEqual(['driving']);

    const res = await app.inject({ method: 'GET', url: '/api/overlay/speed-cameras/features' });
    expect(res.statusCode).toBe(200);
    const fc = res.json();
    expect(fc.type).toBe('FeatureCollection');
    const kinds = fc.features.map((f: { properties: { kind: string } }) => f.properties.kind);
    expect(kinds.sort()).toEqual(['point', 'section']);
    const point = fc.features.find(
      (f: { properties: { kind: string } }) => f.properties.kind === 'point',
    );
    expect(point.properties.name).toBe('Fossen');
    expect(point.geometry.coordinates).toEqual([10, latAt(10)]);
    const section = fc.features.find(
      (f: { properties: { kind: string } }) => f.properties.kind === 'section',
    );
    expect(section.geometry.type).toBe('LineString');
    expect(section.geometry.coordinates).toHaveLength(31);
  });

  it('hides the layer and answers an empty collection without camera tables', async () => {
    const dataDir = await tempDataDir();
    await mkdir(path.join(dataDir, 'nvdb'), { recursive: true });
    const db = new DatabaseSync(path.join(dataDir, 'nvdb', 'nvdb.sqlite'));
    createSpeedTables(db);
    db.close();

    const app = await bootApp(dataDir);
    const catalog = await app.inject({ method: 'GET', url: '/api/layers' });
    const ids = catalog.json().layers.map((l: { id: string }) => l.id);
    expect(ids).not.toContain('speed-cameras');
    // The route still answers (a cached client may hold the old catalog) —
    // empty is the normal NVDB answer, never an error.
    const res = await app.inject({ method: 'GET', url: '/api/overlay/speed-cameras/features' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ type: 'FeatureCollection', features: [] });
  });
});
