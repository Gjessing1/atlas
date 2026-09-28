import type { WeatherForecast, WeatherPoint } from '@atlas/conditions';
import type { FastifyInstance } from 'fastify';
import type { StatusRegistry } from './status.js';
import {
  LruMap,
  retryAfterSeconds,
  sendBusy,
  SingleFlight,
  UpstreamBusyError,
  UpstreamGate,
  UpstreamHttpError,
  type UpstreamGateOptions,
} from './upstream.js';

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
 *  - Stay well under the 20 requests/s MET allows the whole application
 *    before it throttles with 429s (DATA-SOURCES.md → *MET Norway
 *    Locationforecast 2.0*): at most `maxConcurrent` calls at once, their starts
 *    spaced by `minGapMs`.
 *  - Rest after any failure (see `UpstreamGate`). While resting, a location
 *    with a stale forecast gets it back and one without gets 503 +
 *    `Retry-After`; nothing reaches met.no. Serving stale alone was not
 *    enough: the stale entry's `Expires` had already passed, so every request
 *    after a 429 asked again.
 *  - Concurrent callers for one location share a single in-flight request.
 *    It is never aborted: the answer is cached for whoever asks next.
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
      apparentTemp: num(d, 'apparent_air_temperature'),
      dewPoint: num(d, 'dew_point_temperature'),
      windSpeed: num(d, 'wind_speed') ?? 0,
      windGust: num(d, 'wind_speed_of_gust'),
      windFromDir: num(d, 'wind_from_direction') ?? 0,
      cloud: num(d, 'cloud_area_fraction') ?? 0,
      fog: num(d, 'fog_area_fraction'),
      humidity: num(d, 'relative_humidity') ?? 0,
      pressure: num(d, 'air_pressure_at_sea_level'),
      precip: num(precipDetails, 'precipitation_amount'),
      precipMin: num(precipDetails, 'precipitation_amount_min'),
      precipMax: num(precipDetails, 'precipitation_amount_max'),
      precipProb: num(precipDetails, 'probability_of_precipitation'),
      thunderProb: num(precipDetails, 'probability_of_thunder'),
      uvIndex: num(d, 'ultraviolet_index_clear_sky'),
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

/** A status-page line: fetch's own errors (network, timeout) all mean "unreachable". */
function failureReason(err: unknown): string {
  if (err instanceof UpstreamHttpError) return err.message;
  if (!(err instanceof Error) || err.name === 'TypeError' || err.name === 'TimeoutError') {
    return 'unreachable';
  }
  return err.message;
}

export interface WeatherApiOptions {
  /** Identifying User-Agent with contact info (METNO_USER_AGENT to override). */
  userAgent?: string;
  /** Test seam: upstream HTTP. */
  fetchImpl?: typeof fetch;
  /** Health registry: met.no is one probed source. */
  status?: StatusRegistry;
  /** Test seam: pacing and rest for the met.no gate. */
  upstream?: UpstreamGateOptions;
}

const WEATHER_PROBE = 'metno';
/** Locations held, each a ~1 km cell; least recently read goes first. */
const CACHE_CAP = 500;

export function registerWeatherApi(app: FastifyInstance, opts: WeatherApiOptions = {}): void {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const status = opts.status;
  status?.register(WEATHER_PROBE, 'MET Norway (weather)', 'Weather');
  const userAgent =
    opts.userAgent ??
    process.env.METNO_USER_AGENT ??
    'atlas-maps/1.0 git.gjessing.io/gjessing1/atlas lars@gjessing.io';
  /** Keyed by the rounded "lat,lon" actually requested, so nearby callers share a forecast. */
  const cache = new LruMap<string, CacheEntry>(CACHE_CAP);
  const flights = new SingleFlight<string, WeatherForecast>();
  // Four at once, starts 100 ms apart: at most 10 requests/s, half of what
  // MET allows. A twelve-stand board fetched cold takes about a second.
  const gate = new UpstreamGate({
    maxConcurrent: 4,
    minGapMs: 100,
    baseBackoffMs: 15_000,
    maxBackoffMs: 10 * 60_000,
    ...opts.upstream,
  });

  async function refresh(
    rLat: number,
    rLon: number,
    key: string,
    cached: CacheEntry | undefined,
  ): Promise<WeatherForecast> {
    const headers: Record<string, string> = { 'User-Agent': userAgent };
    // Revalidate cheaply: an unchanged forecast returns 304 with no body.
    if (cached?.lastModified) headers['If-Modified-Since'] = cached.lastModified;
    const res = await fetchImpl(`${METNO_URL}?lat=${rLat}&lon=${rLon}`, {
      headers,
      signal: AbortSignal.timeout(8000),
    });
    // 304: forecast unchanged. Push the next refresh to the new Expires; reuse the payload.
    if (res.status === 304 && cached) {
      cached.expiresAt = parseExpires(res.headers.get('expires'));
      return cached.forecast;
    }
    if (!res.ok) {
      throw new UpstreamHttpError(
        res.status,
        `HTTP ${res.status}`,
        retryAfterSeconds(res.headers.get('retry-after')),
      );
    }
    const lastModified = res.headers.get('last-modified');
    const forecast = normalise(rLat, rLon, lastModified, await res.json());
    // A 200 without a series is a broken answer; caching it would show "no
    // forecast" here until it expired.
    if (!forecast.series.length) throw new Error('forecast has no time series');
    cache.set(key, {
      forecast,
      lastModified,
      expiresAt: parseExpires(res.headers.get('expires')),
    });
    return forecast;
  }

  async function fetchForecast(lat: number, lon: number): Promise<WeatherForecast> {
    const rLat = roundCoord(lat);
    const rLon = roundCoord(lon);
    const key = `${rLat},${rLon}`;

    const cached = cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.forecast;
    // Resting after a failure: the stale forecast is the answer, and without
    // one the caller is told when to come back.
    const resting = gate.retryAfterS();
    if (resting) {
      if (cached) return cached.forecast;
      throw new UpstreamBusyError(resting);
    }

    return flights.run(key, async () => {
      try {
        const forecast = await gate.run(() => refresh(rLat, rLon, key, cached));
        status?.record(WEATHER_PROBE, true);
        return forecast;
      } catch (err) {
        // A caller turned away because another call failed is not a new
        // failure of met.no.
        if (!(err instanceof UpstreamBusyError)) {
          status?.record(
            WEATHER_PROBE,
            false,
            `${failureReason(err)}; backing off ${gate.retryAfterS()} s`,
          );
        }
        // A stale forecast is far better than an error.
        if (cached) return cached.forecast;
        throw err;
      }
    });
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
        if (err instanceof UpstreamBusyError) {
          return sendBusy(reply, err, 'weather is busy upstream; try again shortly');
        }
        request.log.error({ err }, 'weather upstream failed');
        return reply.code(502).send({ error: 'weather unavailable' });
      }
    },
  );
}
