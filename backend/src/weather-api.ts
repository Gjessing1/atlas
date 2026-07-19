import type { WeatherForecast, WeatherPoint } from '@atlas/conditions';
import type { FastifyInstance } from 'fastify';

/**
 * GET /api/weather?lat=..&lon=.. — point forecast from MET Norway
 * Locationforecast 2.0 (api.met.no, the engine behind Yr), proxied so clients
 * never call the upstream directly (single origin, and MET's terms are
 * enforced in exactly one place).
 *
 * MET's terms of service, implemented here (mandatory, not polish):
 *  - Identifying `User-Agent` with contact info — generic agents are blocked.
 *  - Coordinates rounded to 2 decimals (~1 km): MET rejects >4 decimals, and
 *    the rounded pair is the cache key, so nearby requests share a forecast.
 *  - Honour the `Expires` response header; never refetch before it. On
 *    expiry, revalidate with `If-Modified-Since` so an unchanged forecast
 *    comes back 304 with no payload.
 *  - Back off on 429 and serve the stale entry; serve stale on any upstream
 *    failure rather than hammering a struggling service.
 *  - Concurrent callers for one location share a single in-flight request.
 */

const METNO_URL = 'https://api.met.no/weatherapi/locationforecast/2.0/complete';

/** We pull the `complete` product for wind direction/gusts, cloud, pressure — the conditions
 * engine's inputs — rather than the `compact` subset. */
interface MetTimeseries {
  time: string;
  data: {
    instant: { details: Record<string, number> };
    next_1_hours?: { summary?: { symbol_code?: string }; details?: Record<string, number> };
    next_6_hours?: { summary?: { symbol_code?: string }; details?: Record<string, number> };
  };
}

interface CacheEntry {
  forecast: WeatherForecast;
  /** Upstream `Last-Modified`, forwarded as `If-Modified-Since` on revalidation. */
  lastModified: string | null;
  /** Epoch ms from the upstream `Expires` header; don't refetch before this. */
  expiresAt: number;
}

/** MET wants ≤4 decimals; 2 (~1 km) is plenty for a point forecast and caches far better. */
function roundCoord(n: number): number {
  return Math.round(n * 100) / 100;
}

function num(obj: Record<string, unknown> | undefined, key: string): number | null {
  const v = obj?.[key];
  return typeof v === 'number' ? v : null;
}

function normalise(
  lat: number,
  lon: number,
  lastModified: string | null,
  json: unknown,
): WeatherForecast {
  const props = (json as { properties?: { timeseries?: MetTimeseries[] } }).properties;
  const series: WeatherPoint[] = (props?.timeseries ?? []).map((step) => {
    const d = step.data.instant.details;
    const hourly = step.data.next_1_hours;
    const sixly = step.data.next_6_hours;
    const precipDetails = hourly?.details ?? sixly?.details;
    return {
      time: step.time,
      temp: num(d, 'air_temperature') ?? 0,
      windSpeed: num(d, 'wind_speed') ?? 0,
      windGust: num(d, 'wind_speed_of_gust'),
      windFromDir: num(d, 'wind_from_direction') ?? 0,
      cloud: num(d, 'cloud_area_fraction') ?? 0,
      humidity: num(d, 'relative_humidity') ?? 0,
      pressure: num(d, 'air_pressure_at_sea_level'),
      precip: num(precipDetails, 'precipitation_amount'),
      precipProb: num(precipDetails, 'probability_of_precipitation'),
      symbol: hourly?.summary?.symbol_code ?? sixly?.summary?.symbol_code ?? '',
    };
  });
  // Normalise the upstream Last-Modified (an HTTP-date) to ISO-8601 per the shared type.
  const updatedAt = lastModified ? new Date(lastModified).toISOString() : new Date().toISOString();
  return { lat, lon, updatedAt, series };
}

/** Expires header → epoch ms. Falls back to a 30-min TTL if absent/unparseable (MET refreshes ~hourly). */
function parseExpires(header: string | null): number {
  const t = header ? Date.parse(header) : NaN;
  return Number.isNaN(t) ? Date.now() + 30 * 60 * 1000 : t;
}

export interface WeatherApiOptions {
  /** Identifying User-Agent with contact info (METNO_USER_AGENT to override). */
  userAgent?: string;
  /** Test seam: upstream HTTP. */
  fetchImpl?: typeof fetch;
}

export function registerWeatherApi(app: FastifyInstance, opts: WeatherApiOptions = {}): void {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const userAgent =
    opts.userAgent ??
    process.env.METNO_USER_AGENT ??
    'atlas-maps/1.0 git.gjessing.io/gjessing1/atlas lars@gjessing.io';

  /** Keyed by the rounded "lat,lon" actually requested, so nearby callers share a forecast. */
  const cache = new Map<string, CacheEntry>();
  const inflight = new Map<string, Promise<WeatherForecast>>();

  async function fetchForecast(lat: number, lon: number): Promise<WeatherForecast> {
    const rLat = roundCoord(lat);
    const rLon = roundCoord(lon);
    const key = `${rLat},${rLon}`;

    const cached = cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.forecast;

    const existing = inflight.get(key);
    if (existing) return existing;

    const task = (async (): Promise<WeatherForecast> => {
      const headers: Record<string, string> = { 'User-Agent': userAgent };
      // Revalidate cheaply: an unchanged forecast returns 304 with no body.
      if (cached?.lastModified) headers['If-Modified-Since'] = cached.lastModified;

      let res: Response;
      try {
        res = await fetchImpl(`${METNO_URL}?lat=${rLat}&lon=${rLon}`, {
          headers,
          signal: AbortSignal.timeout(8000),
        });
      } catch (err) {
        if (cached) return cached.forecast; // network blip → serve stale rather than fail
        throw err;
      }

      // 304: forecast unchanged. Push the next refresh to the new Expires; reuse the payload.
      if (res.status === 304 && cached) {
        cached.expiresAt = parseExpires(res.headers.get('expires'));
        return cached.forecast;
      }
      if (!res.ok) {
        // 429 and 5xx alike: the stale forecast is far better than an error,
        // and its unchanged expiresAt keeps us from hammering the upstream.
        if (cached) return cached.forecast;
        throw new Error(`met.no: ${res.status}`);
      }

      const lastModified = res.headers.get('last-modified');
      const forecast = normalise(rLat, rLon, lastModified, await res.json());
      cache.set(key, {
        forecast,
        lastModified,
        expiresAt: parseExpires(res.headers.get('expires')),
      });
      return forecast;
    })().finally(() => inflight.delete(key));

    inflight.set(key, task);
    return task;
  }

  app.get<{ Querystring: { lat?: string; lon?: string } }>(
    '/api/weather',
    async (request, reply) => {
      const lat = Number(request.query.lat);
      const lon = Number(request.query.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90) {
        return reply.code(400).send({ error: 'valid lat and lon required' });
      }
      try {
        const forecast = await fetchForecast(lat, lon);
        // Short browser cache so panning between nearby points doesn't refetch
        // every selection; the real caching happens server-side per Expires.
        reply.header('cache-control', 'public, max-age=900');
        return forecast;
      } catch (err) {
        request.log.error({ err }, 'weather upstream failed');
        return reply.code(502).send({ error: 'weather unavailable' });
      }
    },
  );
}
