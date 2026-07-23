import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { registerExploreApi } from './explore-api.js';
import { StatusRegistry } from './status.js';

describe('explore API', () => {
  let upstream = Fastify();

  afterEach(async () => {
    await upstream.close();
    upstream = Fastify();
  });

  it('filters Photon by the category tags and ranks nearby results', async () => {
    const tags: string[] = [];
    upstream.get<{ Querystring: { osm_tag?: string } }>('/reverse', (request) => {
      tags.push(request.query.osm_tag ?? '');
      return {
        features: [
          {
            geometry: { coordinates: [10.7501, 59.9101] },
            properties: {
              name: request.query.osm_tag,
              osm_key: 'amenity',
              osm_value: 'restaurant',
            },
          },
        ],
      };
    });
    const address = await upstream.listen({ port: 0, host: '127.0.0.1' });
    const app = Fastify();
    registerExploreApi(app, address, new StatusRegistry());
    const response = await app.inject({
      url: '/api/explore?category=food&lat=59.91&lon=10.75&radius=1000',
    });
    expect(response.statusCode).toBe(200);
    expect(tags.sort()).toEqual(['amenity:fast_food', 'amenity:food_court', 'amenity:restaurant']);
    expect(response.json().results).toHaveLength(3);
    await app.close();
  });

  it('rejects unknown categories', async () => {
    const app = Fastify();
    registerExploreApi(app, 'http://127.0.0.1:1', new StatusRegistry());
    expect((await app.inject({ url: '/api/explore?category=nope&lat=59&lon=10' })).statusCode).toBe(
      400,
    );
    await app.close();
  });
});
