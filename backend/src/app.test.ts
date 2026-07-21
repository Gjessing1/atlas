import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { SystemStatus } from '@atlas/core';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';

let dataDir: string;
let app: FastifyInstance;
let photonStub: FastifyInstance;
let valhallaStub: FastifyInstance;
let lastPhotonQuery: Record<string, string | undefined> = {};

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'atlas-test-'));
  await mkdir(path.join(dataDir, 'tiles'), { recursive: true });
  await mkdir(path.join(dataDir, 'assets', 'styles'), { recursive: true });
  await writeFile(path.join(dataDir, 'tiles', 'test.pmtiles'), 'PMTiles-fixture-content');
  await writeFile(path.join(dataDir, 'tiles', 'notatile.txt'), 'nope');
  await writeFile(path.join(dataDir, 'assets', 'styles', 'test.json'), '{"version":8}');

  photonStub = Fastify();
  photonStub.get<{
    Querystring: { q?: string; limit?: string; lat?: string; lon?: string; bbox?: string };
  }>('/api', (request) => {
    lastPhotonQuery = { ...request.query };
    return {
      type: 'FeatureCollection',
      features: [
        {
          geometry: { type: 'Point', coordinates: [10.75, 59.91] },
          properties: { name: 'Oslo', country: 'Norway', osm_key: 'place', osm_value: 'city' },
        },
        // Same name+label at a slightly different position: must be deduplicated.
        {
          geometry: { type: 'Point', coordinates: [10.76, 59.92] },
          properties: {
            name: 'Oslo',
            country: 'Norway',
            osm_key: 'place',
            osm_value: 'municipality',
          },
        },
        { geometry: null, properties: { name: 'broken' } },
      ],
    };
  });
  // Reverse lookups answer with whatever is nearest; the marker coordinate
  // 0,0 stands in for "nothing there" (open sea).
  photonStub.get<{ Querystring: { lat?: string; lon?: string } }>('/reverse', (request) => ({
    type: 'FeatureCollection',
    features:
      request.query.lat === '0' && request.query.lon === '0'
        ? []
        : [
            {
              geometry: { type: 'Point', coordinates: [10.75, 59.91] },
              properties: {
                name: 'Jernbanetorget',
                city: 'Oslo',
                osm_key: 'highway',
                osm_value: 'bus_stop',
              },
            },
          ],
  }));
  const photonAddress = await photonStub.listen({ port: 0, host: '127.0.0.1' });

  valhallaStub = Fastify();
  valhallaStub.post<{ Body: { locations?: unknown[] } }>('/route', (request, reply) => {
    if (!Array.isArray(request.body.locations) || request.body.locations.length < 2) {
      // Valhalla's error shape: {error_code, error, status_code, status}.
      return reply
        .code(400)
        .send({ error_code: 120, error: 'Insufficiently specified required parameter locations' });
    }
    return {
      trip: {
        units: 'kilometers',
        summary: { length: 1.2345, time: 90 },
        legs: [{ shape: 'gjs~aBw|d`\\entA_ibE', maneuvers: [] }],
      },
    };
  });
  valhallaStub.post<{ Body: { shape?: unknown[] } }>('/trace_attributes', (request, reply) => {
    if (!Array.isArray(request.body.shape) || request.body.shape.length < 2) {
      return reply.code(400).send({ error_code: 114, error: 'Insufficient shape provided' });
    }
    return { edges: [{ begin_shape_index: 0, end_shape_index: 1, speed_limit: 80 }] };
  });
  const valhallaAddress = await valhallaStub.listen({ port: 0, host: '127.0.0.1' });

  app = await buildApp({ dataDir, photonUrl: photonAddress, valhallaUrl: valhallaAddress });
});

afterAll(async () => {
  await app.close();
  await photonStub.close();
  await valhallaStub.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe('health', () => {
  it('responds ok', async () => {
    const res = await app.inject({ url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', app: 'Atlas' });
  });
});

describe('tile serving', () => {
  it('serves whole .pmtiles files', async () => {
    const res = await app.inject({ url: '/tiles/test.pmtiles' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.body).toBe('PMTiles-fixture-content');
  });

  it('answers range requests with 206 partial content', async () => {
    const res = await app.inject({
      url: '/tiles/test.pmtiles',
      headers: { range: 'bytes=0-6' },
    });
    expect(res.statusCode).toBe(206);
    expect(res.headers['content-range']).toBe('bytes 0-6/23');
    expect(res.body).toBe('PMTiles');
  });

  it('answers mid-file ranges', async () => {
    const res = await app.inject({
      url: '/tiles/test.pmtiles',
      headers: { range: 'bytes=8-14' },
    });
    expect(res.statusCode).toBe(206);
    expect(res.body).toBe('fixture');
  });

  it('404s unknown tiles', async () => {
    const res = await app.inject({ url: '/tiles/missing.pmtiles' });
    expect(res.statusCode).toBe(404);
  });

  it('only exposes .pmtiles files', async () => {
    const res = await app.inject({ url: '/tiles/notatile.txt' });
    expect(res.statusCode).toBe(404);
  });
});

describe('search proxy', () => {
  it('maps photon features to search results, dropping unusable ones', async () => {
    const res = await app.inject({ url: '/api/search?q=oslo' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      results: [
        {
          name: 'Oslo',
          label: 'Norway',
          position: { lat: 59.91, lng: 10.75 },
          kind: 'place/city',
        },
      ],
    });
  });

  it('400s without a query', async () => {
    const res = await app.inject({ url: '/api/search' });
    expect(res.statusCode).toBe(400);
  });

  it('forwards a validated route bounding box and caps the result count', async () => {
    const res = await app.inject({
      url: '/api/search?q=fuel&limit=99&bbox=10,59,11,60',
    });
    expect(res.statusCode).toBe(200);
    expect(lastPhotonQuery.bbox).toBe('10,59,11,60');
    expect(lastPhotonQuery.limit).toBe('20');
  });

  it('rejects malformed route bounding boxes', async () => {
    expect((await app.inject({ url: '/api/search?q=fuel&bbox=10,59,9,60' })).statusCode).toBe(400);
    expect((await app.inject({ url: '/api/search?q=fuel&bbox=10,91,11,92' })).statusCode).toBe(400);
  });

  it('502s when photon is unreachable', async () => {
    const downApp = await buildApp({ dataDir, photonUrl: 'http://127.0.0.1:1' });
    const res = await downApp.inject({ url: '/api/search?q=oslo' });
    expect(res.statusCode).toBe(502);
    await downApp.close();
  });
});

describe('reverse geocoding', () => {
  it('names the place at a coordinate', async () => {
    const res = await app.inject({ url: '/api/search/reverse?lat=59.91&lon=10.75' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      result: {
        name: 'Jernbanetorget',
        label: 'Oslo',
        position: { lat: 59.91, lng: 10.75 },
        kind: 'highway/bus_stop',
      },
    });
  });

  it('answers null when nothing is there, rather than erroring', async () => {
    const res = await app.inject({ url: '/api/search/reverse?lat=0&lon=0' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ result: null });
  });

  it('400s on missing or out-of-range coordinates', async () => {
    for (const url of [
      '/api/search/reverse',
      '/api/search/reverse?lat=59.91',
      '/api/search/reverse?lat=abc&lon=10.75',
      '/api/search/reverse?lat=91&lon=10.75',
      '/api/search/reverse?lat=59.91&lon=181',
    ]) {
      expect((await app.inject({ url })).statusCode, url).toBe(400);
    }
  });

  it('502s when photon is unreachable', async () => {
    const downApp = await buildApp({ dataDir, photonUrl: 'http://127.0.0.1:1' });
    const res = await downApp.inject({ url: '/api/search/reverse?lat=59.91&lon=10.75' });
    expect(res.statusCode).toBe(502);
    await downApp.close();
  });
});

describe('route proxy', () => {
  it('forwards route requests to valhalla', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/route',
      payload: {
        costing: 'auto',
        locations: [
          { lat: 59.91, lon: 10.75 },
          { lat: 59.92, lon: 10.76 },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { trip: { summary: { length: number } } };
    expect(body.trip.summary.length).toBe(1.2345);
  });

  it('maps valhalla 4xx errors to 400 with a message', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/route', payload: { locations: [] } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      message: 'Insufficiently specified required parameter locations',
    });
  });

  it('502s when valhalla is unreachable', async () => {
    const downApp = await buildApp({ dataDir, valhallaUrl: 'http://127.0.0.1:1' });
    const res = await downApp.inject({
      method: 'POST',
      url: '/api/route',
      payload: { profile: 'car', points: [] },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ message: 'routing unavailable' });
    await downApp.close();
  });
});

describe('route attributes proxy', () => {
  it('forwards enrichment requests to valhalla trace_attributes', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/route/attributes',
      payload: {
        costing: 'auto',
        shape_match: 'edge_walk',
        shape: [
          { lat: 59.91, lon: 10.75 },
          { lat: 59.92, lon: 10.76 },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { edges: { speed_limit: number }[] };
    expect(body.edges[0]!.speed_limit).toBe(80);
  });

  it('maps a bad shape to 400 with valhalla’s message', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/route/attributes',
      payload: { shape: [] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ message: 'Insufficient shape provided' });
  });
});

describe('asset serving', () => {
  it('serves style JSON', async () => {
    const res = await app.inject({ url: '/assets/styles/test.json' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ version: 8 });
  });
});

describe('status page', () => {
  it('reports per-upstream health driven by real traffic', async () => {
    // Exercise the proxies so their probes flip from unknown to ok.
    await app.inject({ url: '/api/search?q=oslo' });
    await app.inject({
      method: 'POST',
      url: '/api/route',
      payload: {
        costing: 'auto',
        locations: [
          { lat: 59.91, lon: 10.75 },
          { lat: 59.92, lon: 10.76 },
        ],
      },
    });

    const res = await app.inject({ url: '/api/status' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as SystemStatus;
    expect(body.app).toBe('Atlas');
    expect(typeof body.generatedAt).toBe('number');

    const byId = new Map(body.sources.map((s) => [s.id, s]));
    expect(byId.get('photon')?.health).toBe('ok');
    expect(byId.get('valhalla')?.health).toBe('ok');
    // A weather call never happened → still unknown, not a failure.
    expect(byId.get('metno')?.health).toBe('unknown');
    // The test dataDir has test.pmtiles, so the basemap reads fresh.
    const basemap = byId.get('basemap');
    expect(basemap?.health).toBe('ok');
    expect(basemap?.detail).toMatch(/map data from \d{4}-\d{2}-\d{2}/);
    // No DATABASE_URL in this app → sync source absent entirely.
    expect(byId.has('postgres')).toBe(false);
    expect(body.overall).toBe('ok');
  });

  it('marks an upstream degraded after it starts failing', async () => {
    const downApp = await buildApp({ dataDir, valhallaUrl: 'http://127.0.0.1:1' });
    await downApp.inject({
      method: 'POST',
      url: '/api/route',
      payload: {
        costing: 'auto',
        locations: [
          { lat: 59.91, lon: 10.75 },
          { lat: 59.92, lon: 10.76 },
        ],
      },
    });
    const res = await downApp.inject({ url: '/api/status' });
    const body = res.json() as SystemStatus;
    const valhalla = body.sources.find((s) => s.id === 'valhalla');
    expect(valhalla?.health).toBe('down'); // never succeeded this run
    expect(valhalla?.message).toBe('unreachable');
    expect(body.overall).toBe('down');
    await downApp.close();
  });
});
