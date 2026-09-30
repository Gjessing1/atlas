import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { norwegianLayers } from './catalog.js';
import { nvdbPoint } from './features.js';
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
    // The real catalog row, so the test exercises the shipped source config.
    norwegianLayers().find((l) => l.meta.id === 'public-toilets')!,
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

describe('point-feed features route (public toilets)', () => {
  /** An NVDB Toalettanlegg as v4 returns it: srid=4326 WKT is *lat* first. */
  const nvdbToilet = (id: number, wkt: string | null, located = 'POINT Z (61.7553 6.7998 37)') => ({
    id,
    egenskaper: [
      { navn: 'Universelt utformet', verdi: 'Ja' },
      { navn: 'Vinterstengt', verdi: 'Ja' },
      { navn: 'Vinterstengt, fra dato', verdi: '10-15' },
      { navn: 'Vinterstengt, til dato', verdi: '03-15' },
      ...(wkt ? [{ navn: 'Geometri, punkt', verdi: wkt }] : []),
    ],
    ...(wkt ? { geometri: { wkt, srid: 4326 } } : {}),
    lokasjon: {
      geometri: { wkt: located },
      adresser: [{ navn: 'Oldedalsvegen' }],
      vegsystemreferanser: [{ vegsystem: { vegkategori: 'F', fase: 'V', nummer: 5724 } }],
    },
  });
  const osloToilet = (navn: string, sluttdato: number) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [10.7, 59.95] },
    properties: { navn, objekttype: 'Toalett', toalettype: 1, sluttdato },
  });

  it('merges both registers into one normalised point collection', async () => {
    const { app, cacheDir, requests } = await build((url) =>
      url.hostname === 'nvdbapiles.atlas.vegvesen.no'
        ? {
            body: {
              objekter: [
                nvdbToilet(1, 'POINT Z (61.75542451 6.79971101 -999999)'),
                // No geometry of its own: placed by the road network only.
                nvdbToilet(2, null, 'POINT Z (60.5 8.2 400)'),
              ],
              metadata: { returnert: 2, neste: { start: 'x' } },
            },
          }
        : {
            body: {
              type: 'FeatureCollection',
              features: [
                osloToilet('Sognsvann', 2556057600000),
                osloToilet('Ulsrudvann', 1732752000000),
              ],
            },
          },
    );
    track(app, cacheDir);
    const res = await app.inject({ url: '/api/overlay/public-toilets/features' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      features: { geometry: { coordinates: number[] }; properties: Record<string, unknown> }[];
    };
    // NVDB first (catalog order), closed Ulsrudvann dropped.
    expect(body.features.map((f) => f.geometry.coordinates)).toEqual([
      [6.79971101, 61.75542451],
      [8.2, 60.5],
      [10.7, 59.95],
    ]);
    expect(body.features[0]!.properties).toEqual({
      source: 'nvdb',
      accessible: 'yes',
      winter: 'Closed 15 Oct – 15 Mar',
      road: 'Fv5724 (Oldedalsvegen)',
    });
    expect(body.features[2]!.properties).toEqual({
      source: 'oslo',
      name: 'Sognsvann',
      accessible: 'yes',
    });
    const nvdb = requests.find((u) => u.hostname === 'nvdbapiles.atlas.vegvesen.no')!;
    expect(nvdb.pathname).toBe('/vegobjekter/api/v4/vegobjekter/243');
    expect(nvdb.searchParams.get('srid')).toBe('4326');
    // A short page ends it even though NVDB always offers a `neste` cursor.
    expect(requests.filter((u) => u.hostname === 'nvdbapiles.atlas.vegvesen.no')).toHaveLength(1);
  });

  it('fails the whole pull when one register fails, rather than serve half', async () => {
    const { app, cacheDir } = await build((url) =>
      url.hostname === 'nvdbapiles.atlas.vegvesen.no'
        ? { status: 500, body: 'down' }
        : {
            body: { type: 'FeatureCollection', features: [osloToilet('Sognsvann', 2556057600000)] },
          },
    );
    track(app, cacheDir);
    expect((await app.inject({ url: '/api/overlay/public-toilets/features' })).statusCode).toBe(
      502,
    );
  });

  it('reads NVDB WKT latitude-first, and refuses a point outside Norway', () => {
    expect(nvdbPoint('POINT Z (59.9 10.7 12)')).toEqual([10.7, 59.9]);
    expect(nvdbPoint('POINT (69.65 18.95)')).toEqual([18.95, 69.65]);
    // Swapped axes land in the Gulf of Guinea; that must never be drawn.
    expect(nvdbPoint('POINT Z (10.7 59.9 12)')).toBeNull();
    expect(nvdbPoint('LINESTRING (1 2, 3 4)')).toBeNull();
    expect(nvdbPoint(undefined)).toBeNull();
  });
});
