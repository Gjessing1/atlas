import type { OverpassPoiElement } from '@atlas/core';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { registerPoiApi } from './poi-api.js';

function overpass(elements: (block: number, query: string) => OverpassPoiElement[]) {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const query = new URLSearchParams(String(init?.body)).get('data') ?? '';
    const out: OverpassPoiElement[] = [];
    const blocks = query.match(/block="\d+"/g)?.length ?? 0;
    for (let block = 0; block < blocks; block++) {
      out.push(...elements(block, query), {
        type: 'atlasblock',
        id: block + 1,
        tags: { block: String(block) },
      });
    }
    return new Response(JSON.stringify({ elements: out }), { status: 200 });
  });
}

const cafe: OverpassPoiElement = {
  type: 'node',
  id: 42,
  lat: 59.905,
  lon: 10.745,
  tags: {
    amenity: 'cafe',
    name: 'Atlas coffee',
    phone: '+47 12345678',
    opening_hours: 'Mo-Fr 08:00-16:00',
    website: 'https://example.com',
    'addr:street': 'Kartgata',
    'addr:housenumber': '1',
    'addr:city': 'Oslo',
  },
};

async function app(fetchImpl: typeof fetch) {
  const server = Fastify();
  registerPoiApi(server, {
    fetchImpl,
    overpassUrls: ['https://a.test/api/interpreter'],
    minGapMs: 0,
  });
  return server;
}

describe('POI API', () => {
  it('answers tiles × categories with contact-aware places, once per pair', async () => {
    const fetchImpl = overpass(() => [cafe]);
    const server = await app(fetchImpl);
    const url = '/api/pois?tiles=14/8681/4766,14/8682/4766&categories=coffee';
    const response = await server.inject({ url });
    expect(response.statusCode).toBe(200);
    const { tiles } = response.json();
    expect(tiles).toHaveLength(2);
    expect(tiles[0]).toMatchObject({ tile: '14/8681/4766', category: 'coffee', complete: true });
    expect(tiles[0].results[0]).toMatchObject({
      id: 'node/42',
      name: 'Atlas coffee',
      category: 'Cafes',
      address: 'Kartgata 1, Oslo',
      phone: '+47 12345678',
      openingHours: 'Mo-Fr 08:00-16:00',
      website: 'https://example.com',
      osmUrl: 'https://www.openstreetmap.org/node/42',
    });
    const query = new URLSearchParams(String(fetchImpl.mock.calls[0]![1]?.body)).get('data');
    expect(query).toContain('cafe');
    expect(query).not.toContain('charging_station');
    await server.inject({ url });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await server.close();
  });

  it('still answers a bundle that sends its viewport, through the same tiles', async () => {
    const fetchImpl = overpass(() => [cafe]);
    const server = await app(fetchImpl);
    const response = await server.inject({
      url: '/api/pois?bbox=10.74,59.9,10.76,59.915&categories=coffee',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().results).toEqual([
      expect.objectContaining({ id: 'node/42', distanceM: expect.any(Number) }),
    ]);
    await server.close();
  });

  it('rejects malformed requests without an upstream call', async () => {
    const fetchImpl = vi.fn();
    const server = await app(fetchImpl);
    const status = async (url: string) => (await server.inject({ url })).statusCode;
    expect(await status('/api/pois?bbox=10,59,11,60&categories=nope')).toBe(400);
    expect(await status('/api/pois?bbox=0,50,10,60')).toBe(400);
    expect(await status('/api/pois?tiles=14/8681/4766,13/4340/2383')).toBe(400);
    expect(await status('/api/pois?tiles=5/1/1')).toBe(400);
    const many = Array.from({ length: 65 }, (_, x) => `14/${8600 + x}/4766`).join(',');
    expect(await status(`/api/pois?tiles=${many}`)).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
    await server.close();
  });

  it('says when to come back while Overpass is resting', async () => {
    const fetchImpl = vi.fn(async () => new Response('busy', { status: 429 }));
    const server = await app(fetchImpl);
    const url = '/api/pois?tiles=14/8681/4766&categories=coffee';
    expect((await server.inject({ url })).statusCode).toBe(502);
    const busy = await server.inject({ url: `${url},health` });
    expect(busy.statusCode).toBe(503);
    expect(Number(busy.headers['retry-after'])).toBeGreaterThanOrEqual(29);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await server.close();
  });
});
