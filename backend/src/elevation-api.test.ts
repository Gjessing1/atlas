import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { registerElevationApi } from './elevation-api.js';

type StubReply = { status?: number; json?: unknown };

let app: FastifyInstance | null = null;

async function build(replies: (url: URL) => StubReply) {
  const requests: URL[] = [];
  const fetchImpl = (async (input: URL | RequestInfo) => {
    const url = new URL(String(input));
    requests.push(url);
    const reply = replies(url);
    return new Response(JSON.stringify(reply.json ?? {}), { status: reply.status ?? 200 });
  }) as typeof fetch;
  app = Fastify();
  registerElevationApi(app, { fetchImpl, userAgent: 'test-agent test@example.com' });
  await app.ready();
  return { app, requests };
}

afterEach(async () => {
  await app?.close();
  app = null;
});

describe('/api/elevation', () => {
  it('rejects missing or non-numeric coordinates', async () => {
    const { app } = await build(() => ({ json: {} }));
    expect((await app.inject('/api/elevation')).statusCode).toBe(400);
    expect((await app.inject('/api/elevation?lat=foo&lon=10')).statusCode).toBe(400);
  });

  it('returns the height, rounds the query coords, and sends a UA', async () => {
    const { app, requests } = await build(() => ({
      json: { punkter: [{ z: 342.16, datakilde: 'Nasjonal høydemodell' }] },
    }));
    const res = await app.inject('/api/elevation?lat=59.912345&lon=10.756789');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ elevationM: 342.2, source: 'Nasjonal høydemodell' });
    expect(requests[0]!.searchParams.get('nord')).toBe('59.91235');
    expect(requests[0]!.searchParams.get('ost')).toBe('10.75679');
    expect(requests[0]!.searchParams.get('koordsys')).toBe('4258');
  });

  it('reports null elevation outside coverage without erroring', async () => {
    const { app } = await build(() => ({ json: { punkter: [{ z: null }] } }));
    const res = await app.inject('/api/elevation?lat=0&lon=0');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ elevationM: null });
  });

  it('caches a resolved point so a repeat tap skips the upstream', async () => {
    const { app, requests } = await build(() => ({ json: { punkter: [{ z: 100 }] } }));
    await app.inject('/api/elevation?lat=60&lon=11');
    await app.inject('/api/elevation?lat=60&lon=11');
    expect(requests).toHaveLength(1);
  });

  it('maps an upstream failure to 502', async () => {
    const { app } = await build(() => ({ status: 500 }));
    const res = await app.inject('/api/elevation?lat=60&lon=11');
    expect(res.statusCode).toBe(502);
  });
});

describe('/api/elevation/profile', () => {
  it('batches coordinates, preserves order, and returns terrain metadata', async () => {
    const { app, requests } = await build((url) => {
      const points = JSON.parse(url.searchParams.get('punkter') ?? '[]') as number[][];
      return {
        json: {
          punkter: points.map(([lng, lat]) => ({
            z: lat! + lng!,
            terreng: 'Skog',
            datakilde: 'DTM',
          })),
        },
      };
    });
    const points = Array.from({ length: 51 }, (_, i) => ({ lat: 59 + i / 100, lng: 10 }));
    const res = await app.inject({
      method: 'POST',
      url: '/api/elevation/profile',
      payload: { points },
    });
    expect(res.statusCode).toBe(200);
    expect(requests).toHaveLength(2);
    expect(res.json().samples).toHaveLength(51);
    expect(res.json().samples[0]).toEqual({
      elevationM: 69,
      terrain: 'Skog',
      source: 'DTM',
    });
    expect(res.json().samples[50].elevationM).toBe(69.5);
  });

  it('rejects malformed and oversized profiles', async () => {
    const { app } = await build(() => ({ json: {} }));
    expect(
      (await app.inject({ method: 'POST', url: '/api/elevation/profile', payload: { points: [] } }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/elevation/profile',
          payload: { points: Array.from({ length: 401 }, () => ({ lat: 60, lng: 10 })) },
        })
      ).statusCode,
    ).toBe(400);
  });
});
