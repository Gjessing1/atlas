import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { registerPlaceContentApi } from './place-content-api.js';

describe('place content API', () => {
  it('returns matching, attributed summaries from both Wikimedia projects', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const project = new URL(String(input)).hostname.includes('wikivoyage')
        ? 'Wikivoyage'
        : 'Wikipedia';
      return new Response(
        JSON.stringify({
          query: {
            pages: [
              {
                title: 'Preikestolen',
                extract: `${project} describes the cliff.`,
                fullurl: `https://example.test/${project}`,
                coordinates: [{ lat: 58.9864, lon: 6.1904 }],
              },
            ],
          },
        }),
      );
    });
    const app = Fastify();
    registerPlaceContentApi(app, { fetchImpl, userAgent: 'Atlas test' });
    const response = await app.inject({
      url: '/api/place-content?name=Preikestolen&lat=58.9864&lon=6.1904&lang=no',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().content).toEqual([
      {
        source: 'wikipedia',
        title: 'Preikestolen',
        extract: 'Wikipedia describes the cliff.',
        url: 'https://example.test/Wikipedia',
        language: 'no',
      },
      {
        source: 'wikivoyage',
        title: 'Preikestolen',
        extract: 'Wikivoyage describes the cliff.',
        url: 'https://example.test/Wikivoyage',
        language: 'no',
      },
    ]);
    await app.close();
  });

  it('treats missing upstream articles as an empty normal response', async () => {
    const app = Fastify();
    registerPlaceContentApi(app, { fetchImpl: async () => new Response('{}') });
    const response = await app.inject({
      url: '/api/place-content?name=Nowhere&lat=60&lon=10',
    });
    expect(response.json()).toEqual({ content: [] });
    await app.close();
  });

  it('falls back to English when the device language has no matching article', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (!url.hostname.startsWith('en.')) return new Response('{}');
      return new Response(
        JSON.stringify({
          query: {
            pages: [
              {
                title: 'Trolltunga',
                extract: 'A rock formation above Ringedalsvatnet.',
                fullurl: 'https://en.wikipedia.org/wiki/Trolltunga',
                coordinates: [{ lat: 60.124, lon: 6.74 }],
              },
            ],
          },
        }),
      );
    });
    const app = Fastify();
    registerPlaceContentApi(app, { fetchImpl });
    const response = await app.inject({
      url: '/api/place-content?name=Trolltunga&lat=60.124&lon=6.74&lang=de',
    });

    expect(response.json().content).toHaveLength(2);
    expect(response.json().content[0].language).toBe('en');
    await app.close();
  });
});
