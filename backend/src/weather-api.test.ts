import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { registerWeatherApi } from './weather-api.js';

/** A minimal met.no `complete` payload with one hourly step. */
function metPayload(temp = 14.3) {
  return {
    properties: {
      timeseries: [
        {
          time: '2026-07-19T12:00:00Z',
          data: {
            instant: {
              details: {
                air_temperature: temp,
                wind_speed: 3.2,
                wind_speed_of_gust: 6.1,
                wind_from_direction: 245,
                cloud_area_fraction: 62.5,
                relative_humidity: 71,
                air_pressure_at_sea_level: 1009.4,
              },
            },
            next_1_hours: {
              summary: { symbol_code: 'lightrain' },
              details: { precipitation_amount: 0.4, probability_of_precipitation: 55 },
            },
          },
        },
        {
          time: '2026-07-22T12:00:00Z',
          data: {
            instant: { details: { air_temperature: 10 } },
            next_6_hours: {
              summary: { symbol_code: 'cloudy' },
              details: { precipitation_amount: 1.2 },
            },
          },
        },
      ],
    },
  };
}

type StubReply = { status?: number; headers?: Record<string, string>; json?: unknown };

let app: FastifyInstance | null = null;

async function build(replies: (url: URL, init?: RequestInit) => StubReply) {
  const requests: { url: URL; init?: RequestInit }[] = [];
  const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push({ url, init });
    const reply = replies(url, init);
    return new Response(reply.status === 304 ? null : JSON.stringify(reply.json ?? {}), {
      status: reply.status ?? 200,
      headers: reply.headers ?? {},
    });
  }) as typeof fetch;
  app = Fastify();
  registerWeatherApi(app, { fetchImpl, userAgent: 'test-agent test@example.com' });
  await app.ready();
  return { app, requests };
}

afterEach(async () => {
  await app?.close();
  app = null;
});

const futureExpires = () => new Date(Date.now() + 3600_000).toUTCString();

describe('/api/weather', () => {
  it('rejects missing or invalid coordinates', async () => {
    const { app } = await build(() => ({ json: metPayload() }));
    expect((await app.inject('/api/weather')).statusCode).toBe(400);
    expect((await app.inject('/api/weather?lat=99&lon=10')).statusCode).toBe(400);
  });

  it('normalises the met.no payload and rounds coordinates for the upstream', async () => {
    const { app, requests } = await build(() => ({
      headers: { expires: futureExpires(), 'last-modified': 'Sun, 19 Jul 2026 11:22:33 GMT' },
      json: metPayload(),
    }));
    const res = await app.inject('/api/weather?lat=59.912345&lon=10.756789');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(requests[0]!.url.searchParams.get('lat')).toBe('59.91');
    expect(requests[0]!.url.searchParams.get('lon')).toBe('10.76');
    expect((requests[0]!.init?.headers as Record<string, string>)['User-Agent']).toBe(
      'test-agent test@example.com',
    );
    expect(body.lat).toBe(59.91);
    expect(body.updatedAt).toBe('2026-07-19T11:22:33.000Z');
    expect(body.series).toHaveLength(2);
    expect(body.series[0]).toMatchObject({
      temp: 14.3,
      windSpeed: 3.2,
      windGust: 6.1,
      windFromDir: 245,
      cloud: 62.5,
      pressure: 1009.4,
      precip: 0.4,
      precipProb: 55,
      symbol: 'lightrain',
    });
    // 6-hourly tail: precip/symbol fall through to next_6_hours, gust absent.
    expect(body.series[1]).toMatchObject({ precip: 1.2, symbol: 'cloudy', windGust: null });
  });

  it('serves from cache until Expires; nearby coordinates share the entry', async () => {
    const { app, requests } = await build(() => ({
      headers: { expires: futureExpires() },
      json: metPayload(),
    }));
    await app.inject('/api/weather?lat=59.911&lon=10.759');
    await app.inject('/api/weather?lat=59.9142&lon=10.7568'); // rounds to the same 59.91,10.76
    expect(requests).toHaveLength(1);
  });

  it('revalidates with If-Modified-Since and keeps the payload on 304', async () => {
    let call = 0;
    const { app, requests } = await build(() => {
      call++;
      if (call === 1)
        return {
          headers: {
            expires: new Date(Date.now() - 1000).toUTCString(), // already expired
            'last-modified': 'Sun, 19 Jul 2026 10:00:00 GMT',
          },
          json: metPayload(21),
        };
      return { status: 304, headers: { expires: futureExpires() } };
    });
    const first = await app.inject('/api/weather?lat=59.91&lon=10.75');
    const second = await app.inject('/api/weather?lat=59.91&lon=10.75');
    expect(requests).toHaveLength(2);
    expect((requests[1]!.init?.headers as Record<string, string>)['If-Modified-Since']).toBe(
      'Sun, 19 Jul 2026 10:00:00 GMT',
    );
    expect(second.json().series[0].temp).toBe(first.json().series[0].temp);
    // The 304's Expires re-arms the cache: a third call stays local.
    await app.inject('/api/weather?lat=59.91&lon=10.75');
    expect(requests).toHaveLength(2);
  });

  it('serves stale on upstream failure (including 429) instead of erroring', async () => {
    let call = 0;
    const { app } = await build(() => {
      call++;
      if (call === 1)
        return {
          headers: { expires: new Date(Date.now() - 1000).toUTCString() },
          json: metPayload(8),
        };
      return { status: 429 };
    });
    await app.inject('/api/weather?lat=59.91&lon=10.75');
    const res = await app.inject('/api/weather?lat=59.91&lon=10.75');
    expect(res.statusCode).toBe(200);
    expect(res.json().series[0].temp).toBe(8);
  });

  it('502s on a hard failure with no cache to fall back to', async () => {
    const { app } = await build(() => ({ status: 503 }));
    const res = await app.inject('/api/weather?lat=59.91&lon=10.75');
    expect(res.statusCode).toBe(502);
  });

  it('dedupes concurrent requests for the same location', async () => {
    let resolveFetch: (() => void) | null = null;
    const gate = new Promise<void>((r) => {
      resolveFetch = r;
    });
    const requests: URL[] = [];
    const fetchImpl = (async (input: URL | RequestInfo) => {
      requests.push(new URL(String(input)));
      await gate;
      return new Response(JSON.stringify(metPayload()), {
        status: 200,
        headers: { expires: futureExpires() },
      });
    }) as typeof fetch;
    app = Fastify();
    registerWeatherApi(app, { fetchImpl, userAgent: 'test' });
    await app.ready();
    const [a, b] = [
      app.inject('/api/weather?lat=59.91&lon=10.75'),
      app.inject('/api/weather?lat=59.91&lon=10.75'),
    ];
    // Let the event loop start both handlers before releasing the upstream.
    await new Promise((r) => setTimeout(r, 10));
    resolveFetch!();
    const [ra, rb] = await Promise.all([a, b]);
    expect(requests).toHaveLength(1);
    expect(ra.statusCode).toBe(200);
    expect(rb.statusCode).toBe(200);
  });
});
