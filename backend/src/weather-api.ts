import {
  WEATHER_MAP_LAYER_SPECS,
  type WeatherForecast,
  type WeatherMapFrame,
  type WeatherMapFrameKind,
  type WeatherMapLayer,
  type WeatherMapLayerId,
  type WeatherMapsResponse,
  type WeatherPoint,
} from '@atlas/conditions';
import type { FastifyInstance } from 'fastify';
import type { StatusRegistry } from './status.js';

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
const YR_MAPS_URL = 'https://prod.yr-maps.met.no/api';

const MAP_SOURCES = {
  precipitation: [
    ['precipitation-amount', 'forecast'],
    ['precipitation-nowcast', 'nowcast'],
    ['precipitation-observations', 'observation'],
  ],
  temperature: [['air-temperature', 'forecast']],
  wind: [['wind', 'forecast']],
  clouds: [['cloud-area-fraction', 'forecast']],
  'sea-temperature': [['sea-temperature', 'forecast']],
} as const satisfies Record<WeatherMapLayerId, readonly (readonly [string, WeatherMapFrameKind])[]>;

interface YrMapDataset {
  bounds: [number, number, number, number];
  minzoom: number;
  maxzoom: number;
  times: { time: string; tiles: { webp?: string; png?: string } }[];
}

interface WeatherMapCatalog {
  response: WeatherMapsResponse;
  /** Public layer/frame id -> validated upstream tile template. */
  tiles: Map<string, string>;
}

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

export interface WeatherApiOptions {
  /** Identifying User-Agent with contact info (METNO_USER_AGENT to override). */
  userAgent?: string;
  /** Test seam: upstream HTTP. */
  fetchImpl?: typeof fetch;
  /** Health registry: met.no is one probed source. */
  status?: StatusRegistry;
  /** Test seam for selecting the live three-day map window. */
  now?: () => number;
}

const WEATHER_PROBE = 'metno';
const WEATHER_MAPS_PROBE = 'yr-maps';

function safeDataset(value: unknown): YrMapDataset | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<YrMapDataset>;
  if (
    !Array.isArray(raw.bounds) ||
    raw.bounds.length !== 4 ||
    !raw.bounds.every((n) => typeof n === 'number') ||
    typeof raw.minzoom !== 'number' ||
    typeof raw.maxzoom !== 'number' ||
    !Array.isArray(raw.times)
  )
    return null;
  return {
    bounds: raw.bounds as [number, number, number, number],
    minzoom: raw.minzoom,
    maxzoom: raw.maxzoom,
    times: raw.times.filter(
      (entry): entry is YrMapDataset['times'][number] =>
        !!entry &&
        typeof entry.time === 'string' &&
        !!entry.tiles &&
        (typeof entry.tiles.webp === 'string' || typeof entry.tiles.png === 'string'),
    ),
  };
}

function safeTileTemplate(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.origin !== new URL(YR_MAPS_URL).origin) return null;
    if (!raw.includes('{z}') || !raw.includes('{x}') || !raw.includes('{y}')) return null;
    return raw;
  } catch {
    return null;
  }
}

function compactTime(ms: number): string {
  return new Date(ms)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace('.000', '')
    .replace('T', '-')
    .replace('Z', '');
}

export function registerWeatherApi(app: FastifyInstance, opts: WeatherApiOptions = {}): void {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const status = opts.status;
  status?.register(WEATHER_PROBE, 'MET Norway (weather)', 'Weather');
  status?.register(WEATHER_MAPS_PROBE, 'MET Norway (weather maps)', 'Weather');
  const userAgent =
    opts.userAgent ??
    process.env.METNO_USER_AGENT ??
    'atlas-maps/1.0 git.gjessing.io/gjessing1/atlas lars@gjessing.io';
  const now = opts.now ?? Date.now;

  let mapsCache: { catalog: WeatherMapCatalog; expiresAt: number } | null = null;
  let mapsInflight: Promise<WeatherMapCatalog> | null = null;

  async function fetchMapDataset(name: string): Promise<YrMapDataset | null> {
    const res = await fetchImpl(`${YR_MAPS_URL}/${name}/available.json`, {
      headers: { 'User-Agent': userAgent },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    return safeDataset(await res.json());
  }

  async function buildMapCatalog(): Promise<WeatherMapCatalog> {
    const names = [
      ...new Set(
        Object.values(MAP_SOURCES)
          .flat()
          .map(([name]) => name),
      ),
    ];
    const results = await Promise.allSettled(names.map((name) => fetchMapDataset(name)));
    const datasets = new Map<string, YrMapDataset>();
    results.forEach((result, index) => {
      if (result.status === 'fulfilled' && result.value) datasets.set(names[index]!, result.value);
    });

    const start = now() - 2 * 60 * 60 * 1000;
    const end = now() + 72 * 60 * 60 * 1000;
    const tiles = new Map<string, string>();
    const layers: WeatherMapLayer[] = [];

    for (const spec of WEATHER_MAP_LAYER_SPECS) {
      const sources = MAP_SOURCES[spec.id];
      const representative = sources.map(([name]) => datasets.get(name)).find(Boolean);
      if (!representative) continue;

      // Later sources deliberately replace the same validity time: radar beats
      // nowcast, which beats the coarser forecast at "now".
      const byTime = new Map<
        string,
        { time: string; kind: WeatherMapFrameKind; upstream: string }
      >();
      for (const [name, kind] of sources) {
        const dataset = datasets.get(name);
        if (!dataset) continue;
        for (const entry of dataset.times) {
          const ms = Date.parse(entry.time);
          if (!Number.isFinite(ms) || ms < start || ms > end) continue;
          const upstream = safeTileTemplate(entry.tiles.webp ?? entry.tiles.png);
          if (upstream) byTime.set(entry.time, { time: entry.time, kind, upstream });
        }
      }

      const frames: WeatherMapFrame[] = [...byTime.values()]
        .sort((a, b) => Date.parse(a.time) - Date.parse(b.time))
        .map(({ time, kind, upstream }) => {
          const id = `${kind}-${compactTime(Date.parse(time))}`;
          tiles.set(`${spec.id}/${id}`, upstream);
          return {
            id,
            time,
            kind,
            tilePath: `/api/weather/maps/${spec.id}/${id}/{z}/{x}/{y}.webp`,
          };
        });
      if (frames.length === 0) continue;
      layers.push({
        ...spec,
        bounds: representative.bounds,
        minzoom: representative.minzoom,
        maxzoom: representative.maxzoom,
        frames,
      });
    }

    if (layers.length === 0) throw new Error('yr-maps returned no usable datasets');
    return {
      response: {
        layers,
        attribution: 'Weather maps © MET Norway, CC BY 4.0',
        lightning: {
          available: false,
          reason:
            'Live lightning is open data, but its supported Frost endpoint requires a client ID.',
        },
      },
      tiles,
    };
  }

  async function mapCatalog(): Promise<WeatherMapCatalog> {
    if (mapsCache && mapsCache.expiresAt > now()) return mapsCache.catalog;
    if (mapsInflight) return mapsInflight;
    mapsInflight = buildMapCatalog()
      .then((catalog) => {
        mapsCache = { catalog, expiresAt: now() + 10 * 60 * 1000 };
        status?.record(WEATHER_MAPS_PROBE, true);
        return catalog;
      })
      .catch((err) => {
        status?.record(WEATHER_MAPS_PROBE, false, 'unreachable');
        if (mapsCache) return mapsCache.catalog;
        throw err;
      })
      .finally(() => {
        mapsInflight = null;
      });
    return mapsInflight;
  }

  /**
   * Keyed by the rounded "lat,lon" actually requested, so nearby callers share a
   * forecast. Capped so a scripted client panning the globe can't grow it without
   * bound (same policy as the elevation proxy).
   */
  const cache = new Map<string, CacheEntry>();
  const CACHE_CAP = 500;
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
        status?.record(WEATHER_PROBE, false, 'unreachable');
        if (cached) return cached.forecast; // network blip → serve stale rather than fail
        throw err;
      }

      // 304: forecast unchanged. Push the next refresh to the new Expires; reuse the payload.
      if (res.status === 304 && cached) {
        cached.expiresAt = parseExpires(res.headers.get('expires'));
        status?.record(WEATHER_PROBE, true);
        return cached.forecast;
      }
      if (!res.ok) {
        // 429 and 5xx alike: the stale forecast is far better than an error,
        // and its unchanged expiresAt keeps us from hammering the upstream.
        status?.record(WEATHER_PROBE, false, `HTTP ${res.status}`);
        if (cached) return cached.forecast;
        throw new Error(`met.no: ${res.status}`);
      }

      const lastModified = res.headers.get('last-modified');
      const forecast = normalise(rLat, rLon, lastModified, await res.json());
      if (cache.size >= CACHE_CAP && !cache.has(key)) cache.clear();
      cache.set(key, {
        forecast,
        lastModified,
        expiresAt: parseExpires(res.headers.get('expires')),
      });
      status?.record(WEATHER_PROBE, true);
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

  app.get('/api/weather/maps', async (request, reply) => {
    try {
      const catalog = await mapCatalog();
      reply.header('cache-control', 'public, max-age=300');
      return catalog.response;
    } catch (err) {
      request.log.error({ err }, 'weather maps upstream failed');
      return reply.code(502).send({ error: 'weather maps unavailable' });
    }
  });

  app.get<{
    Params: { layer: string; frame: string; z: string; x: string; y: string };
  }>('/api/weather/maps/:layer/:frame/:z/:x/:y.webp', async (request, reply) => {
    const { layer, frame } = request.params;
    const z = Number(request.params.z);
    const x = Number(request.params.x);
    const y = Number(request.params.y);
    if (
      !Number.isInteger(z) ||
      !Number.isInteger(x) ||
      !Number.isInteger(y) ||
      z < 0 ||
      x < 0 ||
      y < 0 ||
      x >= 2 ** z ||
      y >= 2 ** z
    )
      return reply.code(400).send({ error: 'invalid tile coordinate' });

    try {
      const catalog = await mapCatalog();
      const meta = catalog.response.layers.find((candidate) => candidate.id === layer);
      const template = catalog.tiles.get(`${layer}/${frame}`);
      if (!meta || !template || z < meta.minzoom || z > meta.maxzoom)
        return reply.code(404).send({ error: 'weather map frame not found' });
      const upstream = template
        .replace('{z}', String(z))
        .replace('{x}', String(x))
        .replace('{y}', String(y));
      const res = await fetchImpl(upstream, {
        headers: { 'User-Agent': userAgent, Accept: 'image/webp,image/png' },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return reply.code(res.status === 404 ? 404 : 502).send();
      reply.header('content-type', res.headers.get('content-type') ?? 'image/webp');
      reply.header('cache-control', res.headers.get('cache-control') ?? 'public, max-age=900');
      return reply.send(Buffer.from(await res.arrayBuffer()));
    } catch (err) {
      request.log.error({ err }, 'weather map tile upstream failed');
      return reply.code(502).send();
    }
  });
}
