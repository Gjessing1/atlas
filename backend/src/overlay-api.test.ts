import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import {
  norwegianLayers,
  registerOverlayApi,
  tileBbox3857,
  type OverlayLayer,
} from './overlay-api.js';

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=',
  'base64',
);

function testLayers(): OverlayLayer[] {
  return [
    {
      meta: {
        id: 'depth',
        title: 'Depth',
        description: 'Test WMS layer',
        group: 'Water',
        attribution: '© Test',
        maxzoom: 15,
        defaultOpacity: 0.8,
        identify: true,
      },
      upstream: {
        kind: 'wms',
        url: 'https://upstream.example/wms',
        version: '1.3.0',
        layers: 'Dybdekart,DybdeKurve',
        identifyLayers: 'DybdePunkt',
      },
    },
    {
      meta: {
        id: 'legacy',
        title: 'Legacy',
        description: 'WMS 1.1.1 layer',
        group: 'Misc',
        attribution: '© Test',
        maxzoom: 15,
        defaultOpacity: 1,
        identify: false,
      },
      upstream: { kind: 'wms', url: 'https://legacy.example/wms', version: '1.1.1', layers: 'L' },
    },
    {
      meta: {
        id: 'ortho',
        title: 'Ortho',
        description: 'Tokened XYZ layer',
        group: 'Imagery',
        attribution: '© Test',
        maxzoom: 15,
        defaultOpacity: 1,
        identify: false,
      },
      upstream: { kind: 'xyz', template: 'https://xyz.example/${ORTHO_TOKEN}/{z}/{x}/{y}.png' },
      requiresEnv: 'ORTHO_TOKEN',
    },
  ];
}

type StubReply = { status?: number; contentType?: string; body: Buffer | string };

/** Builds the API on a temp cache dir with a recording fetch stub. */
async function build(replies: (url: URL) => StubReply, opts?: { env?: Record<string, string> }) {
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'atlas-tilecache-'));
  const requests: URL[] = [];
  const fetchImpl = (async (input: URL | RequestInfo) => {
    const url = new URL(String(input));
    requests.push(url);
    const reply = replies(url);
    return new Response(reply.body, {
      status: reply.status ?? 200,
      headers: { 'content-type': reply.contentType ?? 'image/png' },
    });
  }) as typeof fetch;
  const app = Fastify();
  registerOverlayApi(app, {
    cacheDir,
    layers: testLayers(),
    fetchImpl,
    env: opts?.env ?? {},
  });
  return { app, cacheDir, requests };
}

let cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup) await fn();
  cleanup = [];
});

function track(app: FastifyInstance, cacheDir: string) {
  cleanup.push(async () => {
    await app.close();
    await rm(cacheDir, { recursive: true, force: true });
  });
}

describe('tile bbox math', () => {
  it('maps z0 to the full mercator extent', () => {
    const [minx, miny, maxx, maxy] = tileBbox3857(0, 0, 0);
    expect(minx).toBeCloseTo(-20037508.342789244, 3);
    expect(miny).toBeCloseTo(-20037508.342789244, 3);
    expect(maxx).toBeCloseTo(20037508.342789244, 3);
    expect(maxy).toBeCloseTo(20037508.342789244, 3);
  });

  it('maps z1 x1 y0 to the north-east quadrant', () => {
    const [minx, miny, maxx, maxy] = tileBbox3857(1, 1, 0);
    expect(minx).toBeCloseTo(0, 3);
    expect(miny).toBeCloseTo(0, 3);
    expect(maxx).toBeCloseTo(20037508.342789244, 3);
    expect(maxy).toBeCloseTo(20037508.342789244, 3);
  });
});

describe('layer catalog', () => {
  it('lists layer metadata without upstream details', async () => {
    const { app, cacheDir } = await build(() => ({ body: PNG_BYTES }));
    track(app, cacheDir);
    const res = await app.inject({ url: '/api/layers' });
    expect(res.statusCode).toBe(200);
    const { layers } = res.json() as { layers: Record<string, unknown>[] };
    expect(layers.map((l) => l.id)).toEqual(['depth', 'legacy']);
    expect(JSON.stringify(layers)).not.toContain('upstream.example');
  });

  it('includes tokened layers only when their env var is set', async () => {
    const { app, cacheDir } = await build(() => ({ body: PNG_BYTES }), {
      env: { ORTHO_TOKEN: 'secret' },
    });
    track(app, cacheDir);
    const res = await app.inject({ url: '/api/layers' });
    const { layers } = res.json() as { layers: { id: string }[] };
    expect(layers.map((l) => l.id)).toContain('ortho');
    expect(JSON.stringify(layers)).not.toContain('secret');
  });

  it('ships a plausible built-in Norwegian catalog', () => {
    const ids = norwegianLayers().map((l) => l.meta.id);
    expect(ids).toContain('lake-depth');
    expect(ids).toContain('hillshade');
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('overlay tile proxy', () => {
  it('translates z/x/y to a WMS 1.3.0 GetMap and serves the image', async () => {
    const { app, cacheDir, requests } = await build(() => ({ body: PNG_BYTES }));
    track(app, cacheDir);
    const res = await app.inject({ url: '/api/overlay/depth/1/1/0.png' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['cache-control']).toContain('max-age=604800');
    expect(res.rawPayload.equals(PNG_BYTES)).toBe(true);

    expect(requests).toHaveLength(1);
    const p = requests[0]!.searchParams;
    expect(requests[0]!.origin + requests[0]!.pathname).toBe('https://upstream.example/wms');
    expect(p.get('REQUEST')).toBe('GetMap');
    expect(p.get('VERSION')).toBe('1.3.0');
    expect(p.get('CRS')).toBe('EPSG:3857');
    expect(p.get('SRS')).toBeNull();
    expect(p.get('LAYERS')).toBe('Dybdekart,DybdeKurve');
    expect(p.get('WIDTH')).toBe('256');
    expect(p.get('TRANSPARENT')).toBe('TRUE');
    const bbox = p.get('BBOX')!.split(',').map(Number);
    expect(bbox[0]).toBeCloseTo(0, 3);
    expect(bbox[3]).toBeCloseTo(20037508.342789244, 3);
  });

  it('uses SRS for WMS 1.1.1 upstreams', async () => {
    const { app, cacheDir, requests } = await build(() => ({ body: PNG_BYTES }));
    track(app, cacheDir);
    await app.inject({ url: '/api/overlay/legacy/3/4/2.png' });
    const p = requests[0]!.searchParams;
    expect(p.get('SRS')).toBe('EPSG:3857');
    expect(p.get('CRS')).toBeNull();
  });

  it('serves repeat requests from the disk cache', async () => {
    const { app, cacheDir, requests } = await build(() => ({ body: PNG_BYTES }));
    track(app, cacheDir);
    await app.inject({ url: '/api/overlay/depth/1/1/0.png' });
    const res = await app.inject({ url: '/api/overlay/depth/1/1/0.png' });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(PNG_BYTES)).toBe(true);
    expect(requests).toHaveLength(1);
  });

  it('substitutes env tokens into xyz templates', async () => {
    const { app, cacheDir, requests } = await build(() => ({ body: PNG_BYTES }), {
      env: { ORTHO_TOKEN: 'secret' },
    });
    track(app, cacheDir);
    const res = await app.inject({ url: '/api/overlay/ortho/5/10/11.png' });
    expect(res.statusCode).toBe(200);
    expect(requests[0]!.toString()).toBe('https://xyz.example/secret/5/10/11.png');
  });

  it('answers a ServiceException body with a transparent tile', async () => {
    const { app, cacheDir } = await build(() => ({
      contentType: 'application/vnd.ogc.se_xml',
      body: '<ServiceExceptionReport>out of range</ServiceExceptionReport>',
    }));
    track(app, cacheDir);
    const res = await app.inject({ url: '/api/overlay/depth/1/1/0.png' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    // Not cached for a week — the upstream may recover.
    expect(res.headers['cache-control']).toContain('max-age=60');
    expect(res.rawPayload.subarray(0, 4).equals(Buffer.from([137, 80, 78, 71]))).toBe(true);
  });

  it('502s on upstream errors and unknown layers / bad coordinates', async () => {
    const { app, cacheDir } = await build(() => ({ status: 500, body: 'boom' }));
    track(app, cacheDir);
    expect((await app.inject({ url: '/api/overlay/depth/1/1/0.png' })).statusCode).toBe(502);
    expect((await app.inject({ url: '/api/overlay/nope/1/1/0.png' })).statusCode).toBe(404);
    // z beyond the layer's maxzoom cap and x outside the row are both invalid.
    expect((await app.inject({ url: '/api/overlay/depth/19/1/0.png' })).statusCode).toBe(400);
    expect((await app.inject({ url: '/api/overlay/depth/1/9/0.png' })).statusCode).toBe(400);
  });
});

describe('identify proxy', () => {
  it('returns cleaned geojson properties', async () => {
    const { app, cacheDir, requests } = await build(() => ({
      contentType: 'application/json',
      body: JSON.stringify({
        features: [
          { properties: { dybde_m: 24, OBJECTID: 7, SHAPE_Length: 1.2, navn: 'Testvatnet' } },
        ],
      }),
    }));
    track(app, cacheDir);
    const res = await app.inject({ url: '/api/overlay/depth/identify?lat=60.1&lng=10.2&zoom=13' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ results: [{ dybde_m: '24', navn: 'Testvatnet' }] });
    const p = requests[0]!.searchParams;
    expect(p.get('REQUEST')).toBe('GetFeatureInfo');
    expect(p.get('QUERY_LAYERS')).toBe('DybdePunkt');
    expect(p.get('INFO_FORMAT')).toBe('application/json');
    expect(Number(p.get('I'))).toBeGreaterThanOrEqual(0);
    expect(Number(p.get('I'))).toBeLessThan(256);
    expect(Number(p.get('J'))).toBeGreaterThanOrEqual(0);
    expect(Number(p.get('J'))).toBeLessThan(256);
  });

  it('falls back from an exception body to GML, then text/plain', async () => {
    const gml = `<msGMLOutput><DybdePunkt_layer><DybdePunkt_feature>
      <gml:boundedBy><gml:Box>1 2 3 4</gml:Box></gml:boundedBy>
      <dybde_m>31</dybde_m><OBJECTID>4</OBJECTID>
    </DybdePunkt_feature></DybdePunkt_layer></msGMLOutput>`;
    const { app, cacheDir } = await build((url) => {
      const format = url.searchParams.get('INFO_FORMAT');
      if (format === 'application/json') {
        return { contentType: 'text/xml', body: '<ServiceExceptionReport/>' };
      }
      return { contentType: 'application/vnd.ogc.gml', body: gml };
    });
    track(app, cacheDir);
    const res = await app.inject({ url: '/api/overlay/depth/identify?lat=60.1&lng=10.2&zoom=13' });
    expect(res.json()).toEqual({ results: [{ dybde_m: '31' }] });
  });

  it('parses ESRI text/xml FeatureInfoResponse (ArcGIS servers reject json/GML)', async () => {
    const esri = `<?xml version="1.0" encoding="UTF-8"?>
      <FeatureInfoResponse xmlns="http://www.esri.com/wms">
        <FIELDS OBJECTID="56112" navn="Tyrifjorden" dybde_m="180" GlobalID="Null" Shape="Polyline" Shape.STLength()="14771.8"/>
      </FeatureInfoResponse>`;
    const { app, cacheDir } = await build((url) => {
      const format = url.searchParams.get('INFO_FORMAT');
      if (format !== 'text/xml') {
        return { contentType: 'text/xml', body: '<ServiceExceptionReport/>' };
      }
      return { contentType: 'text/xml', body: esri };
    });
    track(app, cacheDir);
    const res = await app.inject({ url: '/api/overlay/depth/identify?lat=60.1&lng=10.2&zoom=13' });
    expect(res.json()).toEqual({ results: [{ navn: 'Tyrifjorden', dybde_m: '180' }] });
  });

  it('parses MapServer text/plain as the last resort', async () => {
    const { app, cacheDir } = await build((url) => {
      const format = url.searchParams.get('INFO_FORMAT');
      if (format !== 'text/plain') return { contentType: 'text/xml', body: '<ServiceException/>' };
      return {
        contentType: 'text/plain',
        body: "GetFeatureInfo results:\nLayer 'DybdePunkt'\n  Feature 9:\n    dybde_m = '12'\n",
      };
    });
    track(app, cacheDir);
    const res = await app.inject({ url: '/api/overlay/depth/identify?lat=60.1&lng=10.2&zoom=13' });
    expect(res.json()).toEqual({ results: [{ dybde_m: '12' }] });
  });

  it('404s for non-identifiable layers and 400s bad coordinates', async () => {
    const { app, cacheDir } = await build(() => ({ body: PNG_BYTES }));
    track(app, cacheDir);
    expect(
      (await app.inject({ url: '/api/overlay/legacy/identify?lat=60&lng=10&zoom=12' })).statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ url: '/api/overlay/depth/identify?lat=abc&lng=10&zoom=12' })).statusCode,
    ).toBe(400);
  });

  it('502s when every format attempt fails to reach the upstream', async () => {
    const cacheDir = await mkdtemp(path.join(tmpdir(), 'atlas-tilecache-'));
    const app = Fastify();
    registerOverlayApi(app, {
      cacheDir,
      layers: testLayers(),
      fetchImpl: (() => Promise.reject(new Error('down'))) as unknown as typeof fetch,
      env: {},
    });
    track(app, cacheDir);
    const res = await app.inject({ url: '/api/overlay/depth/identify?lat=60&lng=10&zoom=12' });
    expect(res.statusCode).toBe(502);
  });
});
