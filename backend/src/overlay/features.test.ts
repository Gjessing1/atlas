import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { registerOverlayApi, type OverlayLayer } from './index.js';

/** One arcgis-vector layer plus one WMS layer (to prove /features 404s on it). */
function layers(): OverlayLayer[] {
  return [
    {
      meta: {
        id: 'fields',
        rev: 3,
        title: 'Fields',
        description: 'Vector test layer',
        group: 'Hunting',
        attribution: '© Test',
        maxzoom: 18,
        defaultOpacity: 0.9,
        identify: false,
        vector: true,
      },
      upstream: {
        kind: 'arcgis-vector',
        url: 'https://upstream.example/MapServer/4/query',
        outFields: 'Feltnavn,Art',
        simplifyDeg: 0.0001,
      },
    },
    {
      meta: {
        id: 'depth',
        rev: 1,
        title: 'Depth',
        description: 'WMS layer',
        group: 'Water',
        attribution: '© Test',
        maxzoom: 15,
        defaultOpacity: 0.8,
        identify: false,
      },
      upstream: { kind: 'wms', url: 'https://upstream.example/wms', version: '1.3.0', layers: 'L' },
    },
  ];
}

function polygonFeature(name: string) {
  return {
    type: 'Feature',
    properties: { Feltnavn: name, Art: 'Elg' },
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [10, 60],
          [10.1, 60],
          [10.1, 60.1],
          [10, 60],
        ],
      ],
    },
  };
}

type Stub = (url: URL) => { status?: number; body: unknown };

async function build(stub: Stub) {
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'atlas-features-'));
  const requests: URL[] = [];
  const fetchImpl = (async (input: URL | RequestInfo) => {
    const url = new URL(String(input));
    requests.push(url);
    const { status, body } = stub(url);
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status: status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  const app = Fastify();
  registerOverlayApi(app, { cacheDir, layers: layers(), fetchImpl });
  return { app, cacheDir, requests };
}

let cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup) await fn();
  cleanup = [];
});
function track(app: Awaited<ReturnType<typeof build>>['app'], cacheDir: string) {
  cleanup.push(async () => {
    await app.close();
    await rm(cacheDir, { recursive: true, force: true });
  });
}

describe('arcgis-vector features route', () => {
  it('serves the upstream GeoJSON, simplified and in WGS84', async () => {
    const { app, cacheDir, requests } = await build(() => ({
      body: { type: 'FeatureCollection', features: [polygonFeature('Storrostadalen')] },
    }));
    track(app, cacheDir);
    const res = await app.inject({ url: '/api/overlay/fields/features' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { type: string; features: unknown[] };
    expect(body.type).toBe('FeatureCollection');
    expect(body.features).toHaveLength(1);
    const q = requests[0]!.searchParams;
    expect(q.get('f')).toBe('geojson');
    expect(q.get('outSR')).toBe('4326');
    expect(q.get('maxAllowableOffset')).toBe('0.0001');
    expect(q.get('outFields')).toBe('Feltnavn,Art');
  });

  it('caches the collection — a second request does not hit the upstream', async () => {
    const { app, cacheDir, requests } = await build(() => ({
      body: { type: 'FeatureCollection', features: [polygonFeature('A')] },
    }));
    track(app, cacheDir);
    await app.inject({ url: '/api/overlay/fields/features' });
    const before = requests.length;
    const res = await app.inject({ url: '/api/overlay/fields/features' });
    expect(res.statusCode).toBe(200);
    expect(requests.length).toBe(before);
  });

  it('pages until the upstream stops flagging more', async () => {
    const { app, cacheDir, requests } = await build((url) => {
      const size = Number(url.searchParams.get('resultRecordCount'));
      const offset = Number(url.searchParams.get('resultOffset'));
      if (offset === 0) {
        // A full page, flagged as truncated → the route must ask for more.
        const features = Array.from({ length: size }, (_, i) => polygonFeature(`p${i}`));
        return { body: { type: 'FeatureCollection', features, exceededTransferLimit: true } };
      }
      return { body: { type: 'FeatureCollection', features: [polygonFeature('last')] } };
    });
    track(app, cacheDir);
    const res = await app.inject({ url: '/api/overlay/fields/features' });
    const body = res.json() as { features: unknown[] };
    const size = Number(requests[0]!.searchParams.get('resultRecordCount'));
    expect(body.features).toHaveLength(size + 1);
    expect(requests.length).toBe(2);
    expect(requests[1]!.searchParams.get('resultOffset')).toBe(String(size));
  });

  it('404s for a layer that is not arcgis-vector', async () => {
    const { app, cacheDir } = await build(() => ({ body: {} }));
    track(app, cacheDir);
    expect((await app.inject({ url: '/api/overlay/depth/features' })).statusCode).toBe(404);
  });

  it('has no raster tiles — the tile route refuses a vector layer', async () => {
    const { app, cacheDir } = await build(() => ({ body: {} }));
    track(app, cacheDir);
    expect((await app.inject({ url: '/api/overlay/fields/1/1/0.png' })).statusCode).toBe(404);
  });

  it('502s when the upstream fails and nothing is cached', async () => {
    const { app, cacheDir } = await build(() => ({ status: 503, body: 'down' }));
    track(app, cacheDir);
    expect((await app.inject({ url: '/api/overlay/fields/features' })).statusCode).toBe(502);
  });
});
