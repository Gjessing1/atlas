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

  it('asks for a card-sized lead photo and passes it through', async () => {
    const requested: URL[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      requested.push(url);
      if (url.hostname.includes('wikivoyage')) return new Response('{}');
      return new Response(
        JSON.stringify({
          query: {
            pages: [
              {
                title: 'Nidarosdomen',
                extract: 'The cathedral in Trondheim.',
                fullurl: 'https://no.wikipedia.org/wiki/Nidarosdomen',
                coordinates: [{ lat: 63.4267, lon: 10.3969 }],
                thumbnail: {
                  source: 'https://upload.wikimedia.org/a/b.jpg',
                  width: 640,
                  height: 747,
                },
              },
            ],
          },
        }),
      );
    });
    const app = Fastify();
    registerPlaceContentApi(app, { fetchImpl });
    const response = await app.inject({
      url: '/api/place-content?name=Nidarosdomen&lat=63.4267&lon=10.3969&lang=no',
    });
    expect(response.json().content[0].image).toEqual({
      url: 'https://upload.wikimedia.org/a/b.jpg',
      width: 640,
      height: 747,
    });
    expect(requested[0]!.searchParams.get('prop')).toContain('pageimages');
    expect(requested[0]!.searchParams.get('pithumbsize')).toBe('640');
    await app.close();
  });

  it('leaves the image out when the article has none', async () => {
    const app = Fastify();
    registerPlaceContentApi(app, {
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            query: {
              pages: [
                {
                  title: 'Trolltunga',
                  extract: 'A rock formation.',
                  fullurl: 'https://en.wikipedia.org/wiki/Trolltunga',
                  coordinates: [{ lat: 60.124, lon: 6.74 }],
                },
              ],
            },
          }),
        ),
    });
    const response = await app.inject({
      url: '/api/place-content?name=Trolltunga&lat=60.124&lon=6.74',
    });
    expect(response.json().content[0]).not.toHaveProperty('image');
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

describe('nearby place content', () => {
  const nearbyPages = {
    query: {
      pages: [
        {
          title: 'Asker stasjon',
          extract: 'The station opened in 1872.',
          fullurl: 'https://no.wikipedia.org/wiki/Asker_stasjon',
          coordinates: [{ lat: 59.8337, lon: 10.4345 }],
          thumbnail: { source: 'https://upload.example/station.jpg', width: 160, height: 90 },
        },
        {
          title: 'Asker sentrum',
          extract: 'The centre of Asker.',
          fullurl: 'https://no.wikipedia.org/wiki/Asker_sentrum',
          coordinates: [{ lat: 59.8353, lon: 10.435 }],
        },
        // No extract: a row with nothing to read is not offered.
        {
          title: 'Askerbrua',
          fullurl: 'https://no.wikipedia.org/wiki/Askerbrua',
          coordinates: [{ lat: 59.834, lon: 10.436 }],
        },
      ],
    },
  };

  it('lists described places around a point, nearest first', async () => {
    const asked: URL[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      asked.push(new URL(String(input)));
      return new Response(JSON.stringify(nearbyPages));
    });
    const app = Fastify();
    registerPlaceContentApi(app, { fetchImpl, userAgent: 'Atlas test' });
    const response = await app.inject({
      url: '/api/place-content/nearby?lat=59.8336&lon=10.4348&lang=nb&radius=1500',
    });

    expect(response.statusCode).toBe(200);
    const places = response.json().places as { title: string; distanceM: number }[];
    expect(places.map((p) => p.title)).toEqual(['Asker stasjon', 'Asker sentrum']);
    expect(places[0]!.distanceM).toBeLessThan(places[1]!.distanceM);
    // Norwegian Bokmål is `no` on Wikipedia, and the radius rides along.
    expect(asked[0]!.hostname).toBe('no.wikipedia.org');
    expect(asked[0]!.searchParams.get('ggsradius')).toBe('1500');
    expect(asked[0]!.searchParams.get('generator')).toBe('geosearch');
    await app.close();
  });

  it('falls back to English where the local Wikipedia describes nothing', async () => {
    const hosts: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      hosts.push(url.hostname);
      if (url.hostname.startsWith('no.')) return new Response(JSON.stringify({ query: {} }));
      return new Response(JSON.stringify(nearbyPages));
    });
    const app = Fastify();
    registerPlaceContentApi(app, { fetchImpl, userAgent: 'Atlas test' });
    const response = await app.inject({
      url: '/api/place-content/nearby?lat=59.8336&lon=10.4348&lang=no',
    });

    expect(hosts).toEqual(['no.wikipedia.org', 'en.wikipedia.org']);
    expect(response.json().places).toHaveLength(2);
    expect(response.json().places[0].language).toBe('en');
    await app.close();
  });

  it('rejects a request without a position', async () => {
    const app = Fastify();
    registerPlaceContentApi(app, { fetchImpl: vi.fn<typeof fetch>(), userAgent: 'Atlas test' });
    expect((await app.inject({ url: '/api/place-content/nearby?lat=91&lon=10' })).statusCode).toBe(
      400,
    );
    await app.close();
  });
});

describe('nearby photos', () => {
  it('returns credited Commons thumbnails, nearest first', async () => {
    const asked: URL[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      asked.push(new URL(String(input)));
      return new Response(
        JSON.stringify({
          query: {
            pages: [
              {
                title: 'File:Far away.jpg',
                coordinates: [{ lat: 59.84, lon: 10.44 }],
                imageinfo: [
                  {
                    thumburl: 'https://upload.example/far.jpg',
                    thumbwidth: 480,
                    thumbheight: 320,
                    descriptionurl: 'https://commons.example/far',
                    extmetadata: {
                      Artist: { value: '<a href="x">Ola Nordmann</a>' },
                      LicenseShortName: { value: 'CC BY-SA 4.0' },
                    },
                  },
                ],
              },
              {
                title: 'File:Right here.jpg',
                coordinates: [{ lat: 59.8337, lon: 10.4349 }],
                imageinfo: [
                  {
                    thumburl: 'https://upload.example/here.jpg',
                    thumbwidth: 480,
                    thumbheight: 640,
                    descriptionurl: 'https://commons.example/here',
                  },
                ],
              },
              // No usable thumbnail: dropped rather than rendered broken.
              { title: 'File:Broken.jpg', imageinfo: [{ descriptionurl: 'https://x' }] },
            ],
          },
        }),
      );
    });
    const app = Fastify();
    registerPlaceContentApi(app, { fetchImpl, userAgent: 'Atlas test' });
    const response = await app.inject({ url: '/api/place-photos?lat=59.8336&lon=10.4348' });

    expect(response.statusCode).toBe(200);
    const photos = response.json().photos as { title: string; credit?: string }[];
    expect(photos.map((p) => p.title)).toEqual(['Right here', 'Far away']);
    expect(photos[1]!.credit).toBe('Ola Nordmann · CC BY-SA 4.0');
    expect(asked[0]!.hostname).toBe('commons.wikimedia.org');
    expect(asked[0]!.searchParams.get('ggsnamespace')).toBe('6');
    await app.close();
  });

  it('answers with an empty strip when Commons is unreachable', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new Error('offline');
    });
    const app = Fastify();
    registerPlaceContentApi(app, { fetchImpl, userAgent: 'Atlas test' });
    const response = await app.inject({ url: '/api/place-photos?lat=59.8336&lon=10.4348' });
    expect(response.statusCode).toBe(200);
    expect(response.json().photos).toEqual([]);
    await app.close();
  });
});
