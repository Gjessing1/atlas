import { decodePolyline, type LayerMeta, type LatLng } from '@atlas/core';
import {
  closuresNearRoute,
  parseDatexSnapshot,
  parseTravelTimeCorridors,
  parseTravelTimeSnapshot,
  parseForecastRoadWeather,
  parseMeasuredRoadWeather,
  parseRoadWeatherSites,
  roadWeatherFeatureCollection,
  roadWeatherForRoute,
  trafficDelayForRoute,
  trafficFeatureCollection,
  trafficFlowFeatureCollection,
  type DatexSnapshot,
  type TravelTimeCorridor,
  type TravelTimeSnapshot,
  type RoadWeatherReading,
  type RoadWeatherSite,
} from '@atlas/traffic';
import type { FastifyInstance } from 'fastify';

import type { StatusRegistry } from './status.js';

const DATEX_BASE = 'https://datex-server-get-v3-1.atlas.vegvesen.no/datexapi';
const SITUATION_URL = `${DATEX_BASE}/GetSituation/pullsnapshotdata`;
/** The five-minute corridor measurements — 250 kB, unlike the 24 MB situations. */
const TRAVEL_TIME_URL = `${DATEX_BASE}/GetTravelTimeData/pullsnapshotdata`;
/** The corridor geometry those measurements refer to, by predefined-location id. */
const CORRIDOR_URL = `${DATEX_BASE}/GetPredefinedTravelTimeLocations/pullsnapshotdata`;
const ROAD_WEATHER_SITES_URL = `${DATEX_BASE}/GetMeasurementWeatherSiteTable/pullsnapshotdata`;
const ROAD_WEATHER_MEASURED_URL = `${DATEX_BASE}/GetMeasuredWeatherData/pullsnapshotdata`;
const ROAD_WEATHER_FORECAST_URL = `${DATEX_BASE}/GetForecastPointData/pullsnapshotdata`;
const CACHE_TTL_MS = 3 * 60_000;
/** NPRA republishes every five minutes; asking more often only costs both ends. */
const TRAVEL_TIME_TTL_MS = 60_000;
/** The corridor table changes with the road network, not with the traffic. */
const CORRIDOR_TTL_MS = 6 * 60 * 60_000;
const ROAD_WEATHER_MEASURED_TTL_MS = 3 * 60_000;
const ROAD_WEATHER_FORECAST_TTL_MS = 30 * 60_000;
const MAX_XML_BYTES = 50 * 1024 * 1024;

export interface TrafficApiOptions {
  username?: string;
  password?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  cacheTtlMs?: number;
}

/** Live traffic catalog row. It only ships when both DATEX secrets are configured. */
export function trafficLayerMeta(): LayerMeta {
  return {
    id: 'traffic',
    rev: 1,
    title: 'Traffic and road closures',
    description: 'Current road closures, roadworks and incidents from Statens vegvesen.',
    group: 'Traffic',
    attribution: '© Statens vegvesen (NLOD)',
    metadataUrl: 'https://www.vegvesen.no/fag/teknologi/nasjonal-vegdatabank/',
    minzoom: 6,
    maxzoom: 18,
    defaultOpacity: 1,
    identify: false,
    coverageNote: 'Live Norwegian traffic only; an internet connection is required.',
    vector: true,
  };
}

/**
 * The congestion overlay — a second row beside the incident one, because they
 * answer different questions from different publications: that one says what
 * has *happened* on the road, this one how it is *running*. A driver who wants
 * roadworks marked does not necessarily want the whole motorway network
 * washed in colour.
 */
export function trafficFlowLayerMeta(): LayerMeta {
  return {
    id: 'traffic-flow',
    rev: 1,
    title: 'Traffic flow',
    description:
      'Measured travel times on Statens vegvesen’s corridors — how the main roads are running now.',
    group: 'Traffic',
    attribution: '© Statens vegvesen (NLOD)',
    metadataUrl: 'https://www.vegvesen.no/fag/teknologi/nasjonal-vegdatabank/',
    // The corridors are motorway-scale (median 5.4 km) and there are only 202
    // of them, so the national view is the useful one; below z6 they are noise.
    minzoom: 6,
    maxzoom: 18,
    defaultOpacity: 1,
    identify: false,
    coverageNote:
      'Only the 202 stretches Statens vegvesen measures, in Norway; an internet connection is required.',
    vector: true,
  };
}

/** Live road-surface observations, with the forecast filling future route checks. */
export function roadWeatherLayerMeta(): LayerMeta {
  return {
    id: 'road-weather',
    rev: 1,
    title: 'Road weather',
    description: 'Measured road temperature and surface condition from Statens vegvesen.',
    group: 'Driving',
    attribution: '© Statens vegvesen (NLOD)',
    metadataUrl: 'https://www.vegvesen.no/trafikkinformasjon/reiseinformasjon/vaer-og-fore/',
    minzoom: 6,
    maxzoom: 18,
    defaultOpacity: 1,
    identify: false,
    coverageNote:
      'Selected Norwegian road-weather stations; an internet connection is required. Missing warnings do not prove a road is ice-free.',
    profiles: ['driving'],
    vector: true,
  };
}

const routeShape = (raw: unknown, encoded?: unknown): LatLng[] => {
  const decoded =
    typeof encoded === 'string' && encoded.length <= 500_000
      ? decodePolyline(encoded, 6).map(([lat, lng]) => ({ lat, lng }))
      : raw;
  return Array.isArray(decoded)
    ? decoded
        .filter(
          (point): point is LatLng =>
            typeof point === 'object' &&
            point !== null &&
            typeof (point as LatLng).lat === 'number' &&
            Number.isFinite((point as LatLng).lat) &&
            Math.abs((point as LatLng).lat) <= 90 &&
            typeof (point as LatLng).lng === 'number' &&
            Number.isFinite((point as LatLng).lng) &&
            Math.abs((point as LatLng).lng) <= 180,
        )
        .slice(0, 20_000)
    : [];
};

/** Authenticated DATEX proxy, parsed cache, map features and route closures. */
export function registerTrafficApi(
  app: FastifyInstance,
  status: StatusRegistry,
  options: TrafficApiOptions = {},
): { enabled: boolean; metas: LayerMeta[] } {
  const username = options.username ?? process.env.DATEX_USERNAME;
  const password = options.password ?? process.env.DATEX_PASSWORD;
  if (!username || !password) return { enabled: false, metas: [] };

  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());
  const cacheTtlMs = options.cacheTtlMs ?? CACHE_TTL_MS;
  status.register('datex', 'DATEX traffic', 'Routing');
  status.register('datex-traveltime', 'DATEX travel times', 'Routing');
  status.register('datex-road-weather', 'DATEX road weather', 'Routing');

  const pull = async (url: string, maxBytes = MAX_XML_BYTES): Promise<string> => {
    const response = await fetchImpl(url, {
      headers: {
        Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
        Accept: 'application/xml, text/xml',
        'User-Agent': 'Atlas/1.0 (https://atlas.gjessing.io)',
      },
      signal: AbortSignal.timeout(90_000),
    });
    if (!response.ok) throw new Error(`DATEX HTTP ${response.status}`);
    const declaredBytes = Number(response.headers.get('content-length') ?? 0);
    if (declaredBytes > maxBytes) throw new Error('DATEX snapshot exceeds size limit');
    const xml = await response.text();
    if (xml.length > maxBytes) throw new Error('DATEX snapshot exceeds size limit');
    return xml;
  };

  /**
   * One cache shape for all three publications: serve the last good parse
   * while a refresh runs, and never let two refreshes race. It matters most
   * for the 24 MB situation feed, whose parse takes seconds — a request
   * arriving mid-refresh must get the previous answer, not wait for it.
   */
  const cachedFeed = <T>(id: string, ttlMs: number, load: () => Promise<T>) => {
    let cached: { value: T; fetchedAt: number } | null = null;
    let inflight: Promise<T> | null = null;
    const refresh = (): Promise<T> => {
      inflight ??= load()
        .then((value) => {
          cached = { value, fetchedAt: Date.now() };
          return value;
        })
        .finally(() => {
          inflight = null;
        });
      return inflight;
    };
    return {
      refresh,
      async get(): Promise<T> {
        if (!cached) return refresh();
        if (Date.now() - cached.fetchedAt >= ttlMs) {
          void refresh().catch((error) => app.log.warn({ err: error, id }, 'DATEX refresh failed'));
        }
        return cached.value;
      },
    };
  };

  const situations = cachedFeed('datex', cacheTtlMs, async (): Promise<DatexSnapshot> => {
    try {
      const parsed = parseDatexSnapshot(await pull(SITUATION_URL), now());
      status.record('datex', true);
      // The count goes through setDetail, not record: `record` keeps its
      // message only for failures, so a healthy source described that way says
      // nothing at all on the status page.
      status.setDetail('datex', `${parsed.situations.length} current situations`);
      return parsed;
    } catch (error) {
      status.record('datex', false, 'unreachable');
      status.setDetail('datex', null);
      throw error;
    }
  });

  const corridors = cachedFeed(
    'datex-corridors',
    CORRIDOR_TTL_MS,
    async (): Promise<TravelTimeCorridor[]> => {
      try {
        return parseTravelTimeCorridors(await pull(CORRIDOR_URL)).corridors;
      } catch (error) {
        // Reported under the travel-time id rather than one of its own: the
        // measurements are useless without the geometry they refer to, so a
        // dead corridor table *is* this capability being down, and a second
        // status row would let it read healthy while answering nothing.
        status.record('datex-traveltime', false, 'corridor table unreachable');
        status.setDetail('datex-traveltime', null);
        throw error;
      }
    },
  );

  const travelTimes = cachedFeed(
    'datex-traveltime',
    TRAVEL_TIME_TTL_MS,
    async (): Promise<TravelTimeSnapshot> => {
      try {
        const parsed = parseTravelTimeSnapshot(await pull(TRAVEL_TIME_URL));
        const measured = parsed.measurements.filter((entry) => entry.durationS !== undefined);
        status.record('datex-traveltime', true);
        // Worth stating rather than reducing to "ok": a third of the corridors
        // routinely report nothing, so the useful health question is how many
        // are actually measuring, not whether the feed answered.
        status.setDetail(
          'datex-traveltime',
          `${measured.length} of ${parsed.measurements.length} corridors measuring`,
        );
        return parsed;
      } catch (error) {
        status.record('datex-traveltime', false, 'unreachable');
        status.setDetail('datex-traveltime', null);
        throw error;
      }
    },
  );

  const roadWeatherSites = cachedFeed(
    'datex-road-weather-sites',
    CORRIDOR_TTL_MS,
    async (): Promise<RoadWeatherSite[]> => {
      try {
        return parseRoadWeatherSites(await pull(ROAD_WEATHER_SITES_URL)).sites;
      } catch (error) {
        status.record('datex-road-weather', false, 'station table unreachable');
        status.setDetail('datex-road-weather', null);
        throw error;
      }
    },
  );
  const measuredRoadWeather = cachedFeed(
    'datex-road-weather-measured',
    ROAD_WEATHER_MEASURED_TTL_MS,
    async (): Promise<RoadWeatherReading[]> => {
      try {
        return parseMeasuredRoadWeather(await pull(ROAD_WEATHER_MEASURED_URL)).readings;
      } catch (error) {
        status.record('datex-road-weather', false, 'measurements unreachable');
        status.setDetail('datex-road-weather', null);
        throw error;
      }
    },
  );
  const forecastRoadWeather = cachedFeed(
    'datex-road-weather-forecast',
    ROAD_WEATHER_FORECAST_TTL_MS,
    async (): Promise<RoadWeatherReading[]> => {
      try {
        // 38 MB on 2026-09-14 — stations × 25 hourly rows, already three
        // quarters of the shared cap, and it grows with every new station.
        return parseForecastRoadWeather(await pull(ROAD_WEATHER_FORECAST_URL, 4 * MAX_XML_BYTES))
          .readings;
      } catch (error) {
        status.record('datex-road-weather', false, 'forecast unreachable');
        status.setDetail('datex-road-weather', null);
        throw error;
      }
    },
  );

  const roadWeather = async () => {
    try {
      const [sites, measured, forecast] = await Promise.all([
        roadWeatherSites.get(),
        measuredRoadWeather.get(),
        forecastRoadWeather.get(),
      ]);
      status.record('datex-road-weather', true);
      status.setDetail(
        'datex-road-weather',
        `${measured.length} stations measuring; ${forecast.length} hourly forecasts`,
      );
      return { sites, measured, forecast };
    } catch (error) {
      status.record('datex-road-weather', false, 'unreachable');
      status.setDetail('datex-road-weather', null);
      throw error;
    }
  };

  const snapshot = () => situations.get();

  app.get('/api/overlay/traffic/features', async (request, reply) => {
    try {
      const current = await snapshot();
      return reply
        .header('cache-control', 'public, max-age=60, stale-while-revalidate=180')
        .send(trafficFeatureCollection(current.situations));
    } catch (error) {
      request.log.error({ err: error }, 'DATEX snapshot failed');
      return reply.code(502).send({ error: 'traffic unavailable' });
    }
  });

  app.get('/api/overlay/traffic-flow/features', async (request, reply) => {
    try {
      const [table, measured] = await Promise.all([corridors.get(), travelTimes.get()]);
      return (
        reply
          // Matched to the one-minute measurement cache behind it: a client
          // asking twice inside a window gets the same answer either way, and
          // the stale window covers a slow upstream without going blank.
          .header('cache-control', 'public, max-age=60, stale-while-revalidate=120')
          .send(trafficFlowFeatureCollection(table, measured.measurements))
      );
    } catch (error) {
      request.log.error({ err: error }, 'DATEX travel-time snapshot failed');
      return reply.code(502).send({ error: 'traffic unavailable' });
    }
  });

  app.get('/api/overlay/road-weather/features', async (request, reply) => {
    try {
      const current = await roadWeather();
      return reply
        .header('cache-control', 'public, max-age=120, stale-while-revalidate=300')
        .send(
          roadWeatherFeatureCollection(current.sites, current.measured, current.forecast, now()),
        );
    } catch (error) {
      request.log.error({ err: error }, 'DATEX road-weather snapshot failed');
      return reply.code(502).send({ error: 'road weather unavailable' });
    }
  });

  app.post<{ Body: { points?: unknown; shape?: unknown } }>(
    '/api/traffic/closures',
    async (request, reply) => {
      const points = routeShape(request.body?.points, request.body?.shape);
      if (points.length < 2) return reply.code(400).send({ error: 'route points are required' });
      try {
        const current = await snapshot();
        return reply.send({ closures: closuresNearRoute(current.closures, points) });
      } catch (error) {
        request.log.error({ err: error }, 'DATEX closure lookup failed');
        return reply.code(502).send({ error: 'traffic unavailable' });
      }
    },
  );

  app.post<{ Body: { points?: unknown; shape?: unknown } }>(
    '/api/traffic/travel-times',
    async (request, reply) => {
      const points = routeShape(request.body?.points, request.body?.shape);
      if (points.length < 2) return reply.code(400).send({ error: 'route points are required' });
      try {
        const [table, measured] = await Promise.all([corridors.get(), travelTimes.get()]);
        return reply.send(trafficDelayForRoute(points, table, measured.measurements));
      } catch (error) {
        request.log.error({ err: error }, 'DATEX travel-time lookup failed');
        return reply.code(502).send({ error: 'traffic unavailable' });
      }
    },
  );

  app.post<{
    Body: { points?: unknown; shape?: unknown; durationMs?: unknown; traveledM?: unknown };
  }>('/api/traffic/road-weather', async (request, reply) => {
    const points = routeShape(request.body?.points, request.body?.shape);
    const durationMs = Number(request.body?.durationMs);
    // Metres already driven along `points`; mid-drive checks time each station from there.
    const traveledM = Number(request.body?.traveledM ?? 0);
    if (points.length < 2) return reply.code(400).send({ error: 'route points are required' });
    if (!Number.isFinite(durationMs) || durationMs < 0 || durationMs > 7 * 24 * 60 * 60_000) {
      return reply.code(400).send({ error: 'valid route duration is required' });
    }
    if (!Number.isFinite(traveledM) || traveledM < 0) {
      return reply.code(400).send({ error: 'traveled distance must not be negative' });
    }
    try {
      const current = await roadWeather();
      return reply.send(
        roadWeatherForRoute(
          points,
          durationMs,
          current.sites,
          current.measured,
          current.forecast,
          now(),
          traveledM,
        ),
      );
    } catch (error) {
      request.log.error({ err: error }, 'DATEX route weather lookup failed');
      return reply.code(502).send({ error: 'road weather unavailable' });
    }
  });

  // Warm without blocking server startup; the first client normally arrives
  // later. The corridor table is warmed too — it is the slow half of an ETA
  // correction, and fetching it lazily would put 0.6 s of parsing in front of
  // whichever route request happened to be first.
  void situations
    .refresh()
    .catch((error) => app.log.warn({ err: error }, 'initial DATEX fetch failed'));
  void corridors
    .refresh()
    .catch((error) => app.log.warn({ err: error }, 'initial DATEX corridor fetch failed'));
  void roadWeather().catch((error) =>
    app.log.warn({ err: error }, 'initial DATEX road-weather fetch failed'),
  );
  return {
    enabled: true,
    metas: [trafficLayerMeta(), trafficFlowLayerMeta(), roadWeatherLayerMeta()],
  };
}
