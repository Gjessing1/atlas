import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { registerPoiApi } from './poi-api.js';

describe('POI viewport API', () => {
  it('queries selected OSM tags and returns contact-aware POIs', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const query = new URLSearchParams(String(init?.body)).get('data') ?? '';
      expect(query).toContain('amenity');
      expect(query).toContain('cafe');
      expect(query).not.toContain('charging_station');
      return new Response(
        JSON.stringify({
          elements: [
            {
              type: 'node',
              id: 42,
              lat: 59.91,
              lon: 10.75,
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
            },
          ],
        }),
        { status: 200 },
      );
    });
    const app = Fastify();
    registerPoiApi(app, { fetchImpl });
    const response = await app.inject({
      url: '/api/pois?bbox=10.7,59.8,10.8,60&categories=coffee',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().results[0]).toMatchObject({
      id: 'node/42',
      name: 'Atlas coffee',
      category: 'Cafes',
      address: 'Kartgata 1, Oslo',
      phone: '+47 12345678',
      openingHours: 'Mo-Fr 08:00-16:00',
      website: 'https://example.com',
      osmUrl: 'https://www.openstreetmap.org/node/42',
    });
    await app.close();
  });

  it('rejects unknown categories and oversized bounds without an upstream call', async () => {
    const fetchImpl = vi.fn();
    const app = Fastify();
    registerPoiApi(app, { fetchImpl });
    expect(
      (await app.inject({ url: '/api/pois?bbox=10,59,11,60&categories=nope' })).statusCode,
    ).toBe(400);
    expect((await app.inject({ url: '/api/pois?bbox=0,50,10,60' })).statusCode).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
    await app.close();
  });
});
