import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { norwegianLayers, type PointFeedUpstream } from './catalog.js';
import { fetchPointFeed, nvdbPoint, type ContentDates } from './features.js';
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

  /**
   * Bergen's My Maps export, trimmed: one pin with a `<Point>`, one placed
   * only by spreadsheet columns, one not placed at all. `photo` stands in for
   * the image URL Google re-signs on every export.
   */
  const bergenKml = (photo = 'a', price = '10') => `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document>
  <Folder><name>Public toilets</name>
    <Placemark><name>Gartnerboligen</name>
      <description><![CDATA[<img src="https://mymaps.example/${photo}"/>]]></description>
      <ExtendedData>
        <Data name="Price (NOK)"><value>${price}</value></Data>
        <Data name="tid_hverdag"><value>08-21</value></Data>
        <Data name="tid_lordag"><value>08-21</value></Data>
        <Data name="tid_sondag"><value>08-21</value></Data>
        <Data name="gx_media_links"><value>https://mymaps.example/${photo}</value></Data>
      </ExtendedData>
      <Point><coordinates>5.3270388,60.3829056,0</coordinates></Point>
    </Placemark>
    <Placemark><name>Citizen Service Centre</name>
      <ExtendedData>
        <Data name="latitude"><value>60.3913793</value></Data>
        <Data name="longitude"><value>5.3290558</value></Data>
      </ExtendedData>
    </Placemark>
    <Placemark><name>Fløyen</name></Placemark>
  </Folder>
</Document></kml>`;
  const stavangerGeoJson = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [5.730182, 58.970154] },
        properties: {
          plassering: 'Strandkaien',
          pris: '5',
          aapningstider_hverdag: 'Døgnåpent',
          aapningstider_loerdag: 'Døgnåpent',
          aapningstider_soendag: 'Døgnåpent',
          rullestol: 'JA',
          stellerom: 'JA',
        },
      },
    ],
  };

  /** Every register answering, with `override` replacing one host's answer. */
  const registers =
    (override: Partial<Record<string, ReturnType<Stub>>> = {}, kml = bergenKml()): Stub =>
    (url) =>
      override[url.hostname] ??
      (url.hostname === 'nvdbapiles.atlas.vegvesen.no'
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
        : url.hostname === 'www.google.com'
          ? { body: kml }
          : url.hostname === 'opencom.no'
            ? url.pathname.startsWith('/api/')
              ? { body: { result: { last_modified: '2024-07-09T09:46:18.733815' } } }
              : { body: stavangerGeoJson }
            : {
                body: {
                  type: 'FeatureCollection',
                  features: [
                    osloToilet('Sognsvann', 2556057600000),
                    osloToilet('Ulsrudvann', 1732752000000),
                  ],
                },
              });

  type Body = {
    features: { geometry: { coordinates: number[] }; properties: Record<string, unknown> }[];
  };

  it('merges every register into one normalised point collection', async () => {
    const { app, cacheDir, requests } = await build(registers());
    track(app, cacheDir);
    const res = await app.inject({ url: '/api/overlay/public-toilets/features' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Body;
    // Catalog order; closed Ulsrudvann and unplaced Fløyen dropped.
    expect(body.features.map((f) => f.geometry.coordinates)).toEqual([
      [6.79971101, 61.75542451],
      [8.2, 60.5],
      [10.7, 59.95],
      [5.3270388, 60.3829056],
      [5.3290558, 60.3913793],
      [5.730182, 58.970154],
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
    // Bergen has no published date: the first sighting is the catalog's.
    expect(body.features[3]!.properties).toEqual({
      source: 'bergen',
      name: 'Gartnerboligen',
      hours: 'Daily 08:00–21:00',
      price: '10 kr',
      asOf: '2026-09-30',
    });
    // Stavanger's date is the publisher's own upload date.
    expect(body.features[5]!.properties).toEqual({
      source: 'stavanger',
      name: 'Strandkaien',
      operator: 'Stavanger kommune',
      accessible: 'yes',
      hours: 'Open 24 hours',
      price: '5 kr',
      babyChange: true,
      asOf: '2024-07-09',
    });
    const nvdb = requests.find((u) => u.hostname === 'nvdbapiles.atlas.vegvesen.no')!;
    expect(nvdb.pathname).toBe('/vegobjekter/api/v4/vegobjekter/243');
    expect(nvdb.searchParams.get('srid')).toBe('4326');
    // A short page ends it even though NVDB always offers a `neste` cursor.
    expect(requests.filter((u) => u.hostname === 'nvdbapiles.atlas.vegvesen.no')).toHaveLength(1);
  });

  it('fails the whole pull when one register fails, rather than serve half', async () => {
    for (const host of ['nvdbapiles.atlas.vegvesen.no', 'www.google.com', 'opencom.no']) {
      const { app, cacheDir } = await build(registers({ [host]: { status: 500, body: 'down' } }));
      track(app, cacheDir);
      const res = await app.inject({ url: '/api/overlay/public-toilets/features' });
      expect(res.statusCode, host).toBe(502);
    }
  });

  it('moves a content-dated list’s date only when its toilets change', async () => {
    const up = norwegianLayers().find((l) => l.meta.id === 'public-toilets')!
      .upstream as PointFeedUpstream;
    let saved: Record<string, { fingerprint: string; since: string }> = {};
    const store: ContentDates = {
      read: async () => structuredClone(saved),
      write: async (state) => {
        saved = state;
      },
    };
    const pull = async (kml: string, today: string, dates: ContentDates | null = store) => {
      const fetchImpl = (async (input: URL | RequestInfo) => {
        const { status, body } = registers({}, kml)(new URL(String(input)));
        return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
          status: status ?? 200,
        });
      }) as typeof fetch;
      const { collection } = await fetchPointFeed(
        up,
        fetchImpl,
        dates ? { store: dates, today } : undefined,
      );
      return collection.features.find((f) => f.properties?.['source'] === 'bergen')!.properties![
        'asOf'
      ];
    };
    expect(await pull(bergenKml('a'), '2026-10-01')).toBe('2026-09-30');
    // A re-signed photo URL is not a change to the list.
    expect(await pull(bergenKml('b'), '2027-03-01')).toBe('2026-09-30');
    // A new price is.
    expect(await pull(bergenKml('b', '15'), '2027-06-01')).toBe('2027-06-01');
    expect(await pull(bergenKml('c', '15'), '2028-06-01')).toBe('2027-06-01');
    // No store (the health probe): no date rather than a made-up one.
    expect(await pull(bergenKml('c', '15'), '2028-06-01', null)).toBeUndefined();
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
