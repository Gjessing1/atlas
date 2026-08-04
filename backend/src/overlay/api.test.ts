import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { layerInProfile, MAP_PROFILES } from '@atlas/core';
import { iceObservationLayerMeta } from '../ice-observations-api.js';
import { norwegianLayers, registerOverlayApi, type OverlayLayer } from './index.js';

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=',
  'base64',
);

function testLayers(): OverlayLayer[] {
  return [
    {
      meta: {
        id: 'depth',
        rev: 1,
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
        id: 'hidpi',
        rev: 1,
        title: 'HiDPI',
        description: 'renderScale WMS layer',
        group: 'Water',
        attribution: '© Test',
        maxzoom: 15,
        defaultOpacity: 0.8,
        identify: false,
      },
      upstream: {
        kind: 'wms',
        url: 'https://upstream.example/wms',
        version: '1.3.0',
        layers: 'Contours',
        renderScale: 2,
        identifyLayers: 'Dybdekart',
        identifyFields: ['navn', 'maksdyp', 'middeldyp'],
        labels: {
          url: 'https://upstream.example/arcgis/4/query',
          valueField: 'maksdyp_m',
          nameField: 'innsjonavn',
          unit: 'm',
          minzoom: 10,
          simplifyDeg: 0.0005,
        },
      },
    },
    {
      meta: {
        id: 'legacy',
        rev: 1,
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
        id: 'coded',
        rev: 1,
        title: 'Coded',
        description: 'WMS layer whose identify answers in codes',
        group: 'Misc',
        attribution: '© Test',
        maxzoom: 15,
        defaultOpacity: 1,
        identify: true,
      },
      upstream: {
        kind: 'wms',
        url: 'https://upstream.example/wms',
        version: '1.3.0',
        layers: 'Ice',
        identifyLayers: 'Ice',
        identifyFields: ['navn', 'vurdert'],
        identifyLabels: { navn: 'Lake', vurdert: 'Ice conditions' },
        identifyValues: {
          vurdert: { '1': 'Substantially weakened ice', '2': 'Often dangerous ice conditions' },
        },
      },
    },
    {
      meta: {
        id: 'filtered',
        rev: 1,
        title: 'Filtered',
        description: 'WMS layer with a user-picked variant',
        group: 'Misc',
        attribution: '© Test',
        maxzoom: 15,
        defaultOpacity: 1,
        identify: true,
        options: [
          {
            key: 'species',
            label: 'Species',
            defaultValue: 'game',
            choices: [
              { value: 'game', label: 'Game' },
              { value: 'all', label: 'All species' },
            ],
          },
        ],
      },
      upstream: {
        kind: 'wms',
        url: 'https://upstream.example/wms',
        version: '1.3.0',
        layers: 'Areas',
        identifyLayers: 'Areas',
        optionParams: {
          species: { game: { SLD_BODY: '<sld>game</sld>' }, all: { SLD_BODY: '<sld>all</sld>' } },
        },
        optionFilter: { field: 'Norsknavn', values: { species: { game: ['Elg'], all: [] } } },
      },
    },
    {
      meta: {
        id: 'ortho',
        rev: 1,
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

describe('layer catalog', () => {
  it('lists layer metadata without upstream details', async () => {
    const { app, cacheDir } = await build(() => ({ body: PNG_BYTES }));
    track(app, cacheDir);
    const res = await app.inject({ url: '/api/layers' });
    expect(res.statusCode).toBe(200);
    const { layers } = res.json() as { layers: Record<string, unknown>[] };
    expect(layers.map((l) => l.id)).toEqual(['depth', 'hidpi', 'legacy', 'coded', 'filtered']);
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
    expect(ids).toContain('terrain-slope');
    expect(ids).toContain('terrain-contours');
    expect(ids).toContain('satellite-2025');
    expect(ids).toContain('ice-weak');
    expect(ids).toContain('heritage-sites');
    expect(ids).toContain('wrecks');
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps every option-driven upstream parameter reachable from a declared choice', () => {
    // `optionParams` is keyed by option key → *choice value* → params, and a
    // value that no choice declares is unreachable: nothing ever selects it, so
    // the layer silently keeps drawing its default variant. The alien-species
    // row makes this worth a test — its chips override `LAYERS` outright, so a
    // typo there is the difference between "all records" and one risk category,
    // with a perfectly healthy-looking tile either way.
    for (const layer of norwegianLayers()) {
      if (layer.upstream.kind !== 'wms' || !layer.upstream.optionParams) continue;
      const declared = new Map(
        (layer.meta.options ?? []).map((o) => [o.key, new Set(o.choices.map((c) => c.value))]),
      );
      for (const [key, byChoice] of Object.entries(layer.upstream.optionParams)) {
        expect(declared.has(key), `${layer.meta.id}: optionParams key ${key} is not declared`).toBe(
          true,
        );
        for (const value of Object.keys(byChoice)) {
          expect(
            declared.get(key)!.has(value),
            `${layer.meta.id}: option ${key} has no choice "${value}"`,
          ).toBe(true);
        }
      }
    }
  });

  it('only annotates identify keys the layer actually shows', () => {
    // `identifyLabels`/`identifyValues` are matched against what survives
    // `identifyFields`, so a mapping for a key that was filtered out (or
    // misspelled) is dead weight that fails silently — the raw code reaches the
    // user and nothing anywhere says why.
    for (const layer of norwegianLayers()) {
      if (layer.upstream.kind !== 'wms') continue;
      const { identifyFields, identifyLabels, identifyValues } = layer.upstream;
      const shown = new Set((identifyFields ?? []).map((f) => f.toLowerCase()));
      if (shown.size === 0) continue; // no allow-list: everything passes through
      for (const key of [
        ...Object.keys(identifyLabels ?? {}),
        ...Object.keys(identifyValues ?? {}),
      ]) {
        expect(
          shown.has(key.toLowerCase()),
          `${layer.meta.id}: ${key} is not in identifyFields`,
        ).toBe(true);
      }
    }
  });

  it('offers every profile default layer in that profile', () => {
    // A profile listing a `defaultLayers` id that its `layerTags` do not
    // surface is a silent no-op: `layerInProfile` filters the tagged layer
    // out of the panel, so it can never turn on. This checks the two
    // vocabularies against the *real* catalog (a synthetic meta in the core
    // test cannot — it doesn't know a layer's actual tags). Rolling Regobs is
    // catalog-injected by its own route rather than in `norwegianLayers`; add
    // that always-present row here. Speed cameras and live DATEX traffic are
    // data/config-gated, so allow them.
    const byId = new Map(
      [...norwegianLayers().map((l) => l.meta), iceObservationLayerMeta()].map((meta) => [
        meta.id,
        meta,
      ]),
    );
    for (const profile of MAP_PROFILES) {
      for (const id of profile.defaultLayers ?? []) {
        if (id === 'speed-cameras' || id === 'traffic') continue;
        const meta = byId.get(id);
        expect(meta, `${profile.id} default layer ${id} missing from catalog`).toBeDefined();
        expect(
          layerInProfile(meta!, profile.id),
          `${profile.id} default layer ${id} is not offered in that profile`,
        ).toBe(true);
      }
    }
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

  it('renders renderScale WMS layers at 2× with a DPI hint', async () => {
    const { app, cacheDir, requests } = await build(() => ({ body: PNG_BYTES }));
    track(app, cacheDir);
    await app.inject({ url: '/api/overlay/hidpi/3/4/2.png' });
    const p = requests[0]!.searchParams;
    // Same bbox, a 2× image, and the DPI/MAP_RESOLUTION hint so the upstream
    // scales its symbology instead of just rendering smaller marks.
    expect(p.get('WIDTH')).toBe('512');
    expect(p.get('HEIGHT')).toBe('512');
    expect(p.get('DPI')).toBe('192');
    expect(p.get('MAP_RESOLUTION')).toBe('192');
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
    expect(
      (await readFile(path.join(cacheDir, 'depth', 'v1', '1', '1', '0.png'))).equals(PNG_BYTES),
    ).toBe(true);
  });

  it('sends the selected option upstream and caches each variant separately', async () => {
    const { app, cacheDir, requests } = await build(() => ({ body: PNG_BYTES }));
    track(app, cacheDir);
    // No option given: the layer's own default, not an unfiltered request.
    await app.inject({ url: '/api/overlay/filtered/1/1/0.png' });
    expect(requests[0]!.searchParams.get('SLD_BODY')).toBe('<sld>game</sld>');

    await app.inject({ url: '/api/overlay/filtered/1/1/0.png?species=all' });
    expect(requests[1]!.searchParams.get('SLD_BODY')).toBe('<sld>all</sld>');

    // The variant is part of the cache path, so switching back is a cache hit
    // rather than the *other* species' tiles served under the same URL — the
    // whole failure this signature exists to prevent.
    await app.inject({ url: '/api/overlay/filtered/1/1/0.png' });
    expect(requests).toHaveLength(2);
    expect(
      (
        await readFile(path.join(cacheDir, 'filtered', 'v1', 'species-all', '1', '1', '0.png'))
      ).equals(PNG_BYTES),
    ).toBe(true);
  });

  it('falls back to the default choice instead of trusting the query', async () => {
    const { app, cacheDir, requests } = await build(() => ({ body: PNG_BYTES }));
    track(app, cacheDir);
    const res = await app.inject({ url: '/api/overlay/filtered/1/1/0.png?species=../../etc' });
    expect(res.statusCode).toBe(200);
    // Both halves matter: the upstream gets a declared style, and nothing from
    // the query reaches the cache path.
    expect(requests[0]!.searchParams.get('SLD_BODY')).toBe('<sld>game</sld>');
    expect(
      (
        await readFile(path.join(cacheDir, 'filtered', 'v1', 'species-game', '1', '1', '0.png'))
      ).equals(PNG_BYTES),
    ).toBe(true);
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

  it('keeps only identifyFields, in listed order, and drops -1 sentinels', async () => {
    // Shaped like NVE's lake polygon: the surveyed maximum is real, the mean is
    // the -1 "not measured" marker, and the rest is bookkeeping that would
    // otherwise crowd the depth out of the client's first few rows.
    const { app, cacheDir } = await build(() => ({
      contentType: 'application/json',
      body: JSON.stringify({
        features: [
          {
            properties: {
              maksdyp: 21.5,
              nedbfAreal: 27.2,
              middeldyp: -1,
              pdf1: '2478a.pdf',
              navn: 'Verkensvannet',
              kommune: 'Asker',
            },
          },
        ],
      }),
    }));
    track(app, cacheDir);
    const res = await app.inject({ url: '/api/overlay/hidpi/identify?lat=59.8&lng=10.4&zoom=13' });
    expect(res.statusCode).toBe(200);
    const [only] = (res.json() as { results: Record<string, string>[] }).results;
    expect(only).toEqual({ navn: 'Verkensvannet', maksdyp: '21.5' });
    // Order is the configured one, not the upstream's.
    expect(Object.keys(only!)).toEqual(['navn', 'maksdyp']);
  });

  it('renames identify keys and decodes coded values for display', async () => {
    // NVE's weakened ice answers `vurdert=2`, which on a frozen lake means
    // "often dangerous ice conditions" and on its own means nothing at all.
    const { app, cacheDir } = await build(() => ({
      contentType: 'application/json',
      body: JSON.stringify({
        features: [{ properties: { vurdert: 2, navn: 'Evangervatnet', kommune: 'Voss' } }],
      }),
    }));
    track(app, cacheDir);
    const res = await app.inject({ url: '/api/overlay/coded/identify?lat=60.6&lng=6.1&zoom=13' });
    expect(res.statusCode).toBe(200);
    const [only] = (res.json() as { results: Record<string, string>[] }).results;
    expect(only).toEqual({
      Lake: 'Evangervatnet',
      'Ice conditions': 'Often dangerous ice conditions',
    });
  });

  it('drops a feature whose every attribute was filtered out', async () => {
    const { app, cacheDir } = await build(() => ({
      contentType: 'application/json',
      body: JSON.stringify({ features: [{ properties: { pdf1: 'x.pdf', middeldyp: -1 } }] }),
    }));
    track(app, cacheDir);
    const res = await app.inject({ url: '/api/overlay/hidpi/identify?lat=59.8&lng=10.4&zoom=13' });
    expect(res.json()).toEqual({ results: [] });
  });

  it('answers only for the species the layer is currently drawing', async () => {
    // ArcGIS rejects SLD_BODY on GetFeatureInfo, so the upstream keeps
    // answering for everything under the tap; the filter has to be applied
    // here or the map and the tap disagree.
    const features = [
      { properties: { Norsknavn: 'Ærfugl', Funksjon: 'yngleområde' } },
      { properties: { Norsknavn: 'Elg', Funksjon: 'beiteområde' } },
    ];
    const { app, cacheDir } = await build(() => ({
      contentType: 'application/json',
      body: JSON.stringify({ features }),
    }));
    track(app, cacheDir);
    const filtered = await app.inject({
      url: '/api/overlay/filtered/identify?lat=60&lng=11&zoom=14',
    });
    expect(filtered.json()).toEqual({
      results: [{ Norsknavn: 'Elg', Funksjon: 'beiteområde' }],
    });

    const all = await app.inject({
      url: '/api/overlay/filtered/identify?lat=60&lng=11&zoom=14&species=all',
    });
    expect((all.json() as { results: unknown[] }).results).toHaveLength(2);
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

describe('overlay labels', () => {
  /** One square lake with a depth, shaped like the ArcGIS polygon response. */
  const lake = (maksdyp_m: number | null, innsjonavn = 'Testvatnet') => ({
    attributes: { maksdyp_m, innsjonavn },
    geometry: {
      rings: [
        [
          [10.0, 59.0],
          [10.2, 59.0],
          [10.2, 59.2],
          [10.0, 59.2],
          [10.0, 59.0],
        ],
      ],
    },
  });

  it('turns polygons into labelled points at their centre', async () => {
    const { app, cacheDir, requests } = await build(() => ({
      contentType: 'application/json',
      body: JSON.stringify({ features: [lake(21.5, 'Verkensvannet')] }),
    }));
    track(app, cacheDir);
    const res = await app.inject({
      url: '/api/overlay/hidpi/labels?bbox=10.0,59.0,10.3,59.3&zoom=13',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { features: { properties: Record<string, unknown> }[] };
    expect(body.features).toHaveLength(1);
    expect(body.features[0]!.properties).toEqual({
      label: '21.5 m',
      value: 21.5,
      name: 'Verkensvannet',
    });

    // The envelope must go upstream in the service's native grid, not degrees:
    // NVE ignores inSR, so lon/lat would silently match nothing.
    const p = requests[0]!.searchParams;
    const [minX, minY] = p.get('geometry')!.split(',').map(Number);
    expect(minX).toBeGreaterThan(100_000);
    expect(minY).toBeGreaterThan(1_000_000);
    expect(p.get('outSR')).toBe('4326');
    // Simplification is in output units (degrees) — metres here would collapse
    // every ring to a point and yield no labels at all.
    expect(Number(p.get('maxAllowableOffset'))).toBeLessThan(1);
  });

  it('drops lakes whose depth is missing or the -1 sentinel', async () => {
    const { app, cacheDir } = await build(() => ({
      contentType: 'application/json',
      body: JSON.stringify({ features: [lake(-1), lake(null), lake(12)] }),
    }));
    track(app, cacheDir);
    const res = await app.inject({
      url: '/api/overlay/hidpi/labels?bbox=10.0,59.0,10.3,59.3&zoom=13',
    });
    const body = res.json() as { features: unknown[] };
    expect(body.features).toHaveLength(1);
  });

  it('returns nothing below the layer minzoom without calling upstream', async () => {
    const { app, cacheDir, requests } = await build(() => ({
      contentType: 'application/json',
      body: JSON.stringify({ features: [lake(21.5)] }),
    }));
    track(app, cacheDir);
    const res = await app.inject({
      url: '/api/overlay/hidpi/labels?bbox=10.0,59.0,10.3,59.3&zoom=8',
    });
    expect(res.json()).toEqual({ type: 'FeatureCollection', features: [] });
    expect(requests).toHaveLength(0);
  });

  it('serves a second nearby viewport from cache', async () => {
    const { app, cacheDir, requests } = await build(() => ({
      contentType: 'application/json',
      body: JSON.stringify({ features: [lake(21.5)] }),
    }));
    track(app, cacheDir);
    await app.inject({ url: '/api/overlay/hidpi/labels?bbox=10.0,59.0,10.3,59.3&zoom=13' });
    await app.inject({ url: '/api/overlay/hidpi/labels?bbox=10.01,59.01,10.29,59.29&zoom=13' });
    expect(requests).toHaveLength(1);
  });

  it('degrades to empty when the upstream fails, leaving the raster alone', async () => {
    const { app, cacheDir } = await build(() => ({ status: 500, body: 'boom' }));
    track(app, cacheDir);
    const res = await app.inject({
      url: '/api/overlay/hidpi/labels?bbox=10.0,59.0,10.3,59.3&zoom=13',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ type: 'FeatureCollection', features: [] });
  });

  it('rejects a nonsense or oversized bbox, and layers without labels', async () => {
    const { app, cacheDir } = await build(() => ({ contentType: 'application/json', body: '{}' }));
    track(app, cacheDir);
    expect(
      (await app.inject({ url: '/api/overlay/hidpi/labels?bbox=nope&zoom=13' })).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ url: '/api/overlay/hidpi/labels?bbox=0,0,90,80&zoom=13' })).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ url: '/api/overlay/depth/labels?bbox=10,59,10.3,59.3&zoom=13' }))
        .statusCode,
    ).toBe(404);
  });

  it('advertises labels in the catalog only for layers that have a source', async () => {
    const { app, cacheDir } = await build(() => ({ body: PNG_BYTES }));
    track(app, cacheDir);
    const { layers } = (await app.inject({ url: '/api/layers' })).json() as {
      layers: { id: string; labels?: unknown }[];
    };
    expect(layers.find((l) => l.id === 'hidpi')?.labels).toEqual({ minzoom: 10, unit: 'm' });
    expect(layers.find((l) => l.id === 'depth')?.labels).toBeUndefined();
    // The upstream query URL must not leak with it.
    expect(JSON.stringify(layers)).not.toContain('upstream.example');
  });
});
