import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';

let dataDir: string;
let app: FastifyInstance;
let photonStub: FastifyInstance;
let valhallaStub: FastifyInstance;

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'atlas-test-'));
  await mkdir(path.join(dataDir, 'tiles'), { recursive: true });
  await mkdir(path.join(dataDir, 'assets', 'styles'), { recursive: true });
  await writeFile(path.join(dataDir, 'tiles', 'test.pmtiles'), 'PMTiles-fixture-content');
  await writeFile(path.join(dataDir, 'tiles', 'notatile.txt'), 'nope');
  await writeFile(path.join(dataDir, 'assets', 'styles', 'test.json'), '{"version":8}');

  photonStub = Fastify();
  photonStub.get('/api', () => ({
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

  it('502s when photon is unreachable', async () => {
    const downApp = await buildApp({ dataDir, photonUrl: 'http://127.0.0.1:1' });
    const res = await downApp.inject({ url: '/api/search?q=oslo' });
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

describe('asset serving', () => {
  it('serves style JSON', async () => {
    const res = await app.inject({ url: '/assets/styles/test.json' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ version: 8 });
  });
});
