import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type { InaturArea } from '@atlas/core';
import { registerInaturApi, toInaturArea } from './inatur-api.js';

const OFFER = 'https://www.inatur.no/jakt/5f9a1b2c3d4e5f6a7b8c9d0e';
const ID = '5f9a1b2c3d4e5f6a7b8c9d0e';

function polygon(name: string, ring: [number, number][]) {
  return {
    type: 'Feature',
    properties: { tekst: name },
    geometry: { type: 'Polygon', coordinates: [ring] },
  };
}

async function build(stub: (url: URL) => { status?: number; body: unknown }) {
  const requests: URL[] = [];
  const fetchImpl = (async (input: URL | RequestInfo) => {
    const url = new URL(String(input));
    requests.push(url);
    const { status, body } = stub(url);
    return new Response(JSON.stringify(body), {
      status: status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  const app = Fastify();
  registerInaturApi(app, { fetchImpl });
  return { app, requests };
}

const RING: [number, number][] = [
  [10, 60],
  [10.2, 60],
  [10.2, 60.2],
  [10, 60.2],
  [10, 60],
];

describe('toInaturArea', () => {
  it('keeps interior rings (permit holes) alongside the exterior outline', () => {
    // [exterior, hole] — an un-permitted island carved out of the area.
    const hole: [number, number][] = [
      [10.05, 60.05],
      [10.15, 60.05],
      [10.15, 60.15],
      [10.05, 60.05],
    ];
    const area = toInaturArea(ID, [
      {
        type: 'Feature',
        properties: { tekst: 'Sleikebekk' },
        geometry: { type: 'Polygon', coordinates: [RING, hole] },
      },
    ]);
    expect(area).not.toBeNull();
    // Both rings survive; the hole sits inside so it never widens the bbox.
    expect(area!.rings).toHaveLength(2);
    expect(area!.rings[1]).toEqual(hole);
    expect(area!.bbox).toEqual([10, 60, 10.2, 60.2]);
    expect(area!.subAreas).toBe(1);
  });

  it('collects exterior rings and the spanning bbox from Polygon + MultiPolygon', () => {
    const area = toInaturArea(ID, [
      polygon('Vest', RING),
      {
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'MultiPolygon',
          coordinates: [
            [
              [
                [11, 61],
                [11.1, 61],
                [11.1, 61.1],
                [11, 61],
              ],
            ],
          ],
        },
      },
    ]);
    expect(area).not.toBeNull();
    expect(area!.rings).toHaveLength(2);
    expect(area!.bbox).toEqual([10, 60, 11.1, 61.1]);
    expect(area!.name).toBe('Vest');
    expect(area!.subAreas).toBe(2);
  });

  it('returns null when no feature carries a usable ring', () => {
    expect(toInaturArea(ID, [])).toBeNull();
    expect(
      toInaturArea(ID, [
        { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [10, 60] } },
      ]),
    ).toBeNull();
  });
});

describe('GET /api/inatur/resolve', () => {
  it('400s when the input carries no offer id', async () => {
    const { app } = await build(() => ({ body: {} }));
    expect((await app.inject({ url: '/api/inatur/resolve?offer=not-an-id' })).statusCode).toBe(400);
  });

  it('resolves an offer link to its boundary, querying by tilbudsid in WGS84', async () => {
    const { app, requests } = await build(() => ({
      body: { type: 'FeatureCollection', features: [polygon('Storvasslia', RING)] },
    }));
    const res = await app.inject({ url: `/api/inatur/resolve?offer=${encodeURIComponent(OFFER)}` });
    expect(res.statusCode).toBe(200);
    const area = res.json() as InaturArea;
    expect(area.offerId).toBe(ID);
    expect(area.name).toBe('Storvasslia');
    expect(area.rings[0]).toHaveLength(RING.length);
    // The id is lower-cased into the SQL literal, queried in 4326.
    expect(requests[0]!.searchParams.get('where')).toBe(`tilbudsid='${ID}'`);
    expect(requests[0]!.searchParams.get('outSR')).toBe('4326');
  });

  it('404s a well-formed id that no layer carries (after trying every layer)', async () => {
    const { app, requests } = await build(() => ({
      body: { type: 'FeatureCollection', features: [] },
    }));
    const res = await app.inject({ url: `/api/inatur/resolve?offer=${ID}` });
    expect(res.statusCode).toBe(404);
    // Falls through all five delområde layers before giving up.
    expect(requests.length).toBe(5);
  });

  it('502s when the upstream is down', async () => {
    const { app } = await build(() => ({ status: 500, body: {} }));
    expect((await app.inject({ url: `/api/inatur/resolve?offer=${ID}` })).statusCode).toBe(502);
  });
});
