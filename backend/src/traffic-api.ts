import type { LayerMeta, LatLng } from '@atlas/core';
import {
  closuresNearRoute,
  parseDatexSnapshot,
  trafficFeatureCollection,
  type DatexSnapshot,
} from '@atlas/traffic';
import type { FastifyInstance } from 'fastify';

import type { StatusRegistry } from './status.js';

const DATEX_URL =
  'https://datex-server-get-v3-1.atlas.vegvesen.no/datexapi/GetSituation/pullsnapshotdata';
const CACHE_TTL_MS = 3 * 60_000;
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
    group: 'Driving',
    attribution: '© Statens vegvesen (NLOD)',
    metadataUrl: 'https://www.vegvesen.no/fag/teknologi/nasjonal-vegdatabank/',
    minzoom: 6,
    maxzoom: 18,
    defaultOpacity: 1,
    identify: false,
    coverageNote: 'Live Norwegian traffic only; an internet connection is required.',
    profiles: ['driving'],
    vector: true,
  };
}

const routeShape = (raw: unknown): LatLng[] =>
  Array.isArray(raw)
    ? raw
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

/** Authenticated DATEX proxy, parsed cache, map features and route closures. */
export function registerTrafficApi(
  app: FastifyInstance,
  status: StatusRegistry,
  options: TrafficApiOptions = {},
): { enabled: boolean; meta?: LayerMeta } {
  const username = options.username ?? process.env.DATEX_USERNAME;
  const password = options.password ?? process.env.DATEX_PASSWORD;
  if (!username || !password) return { enabled: false };

  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());
  const cacheTtlMs = options.cacheTtlMs ?? CACHE_TTL_MS;
  let cached: { snapshot: DatexSnapshot; fetchedAt: number } | null = null;
  let inflight: Promise<DatexSnapshot> | null = null;
  status.register('datex', 'DATEX traffic', 'Routing');

  const refresh = async (): Promise<DatexSnapshot> => {
    try {
      const response = await fetchImpl(DATEX_URL, {
        headers: {
          Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
          Accept: 'application/xml, text/xml',
          'User-Agent': 'Atlas/1.0 (https://atlas.gjessing.io)',
        },
        signal: AbortSignal.timeout(90_000),
      });
      if (!response.ok) throw new Error(`DATEX HTTP ${response.status}`);
      const declaredBytes = Number(response.headers.get('content-length') ?? 0);
      if (declaredBytes > MAX_XML_BYTES) throw new Error('DATEX snapshot exceeds size limit');
      const xml = await response.text();
      if (xml.length > MAX_XML_BYTES) throw new Error('DATEX snapshot exceeds size limit');
      const parsed = parseDatexSnapshot(xml, now());
      cached = { snapshot: parsed, fetchedAt: Date.now() };
      status.record('datex', true, `${parsed.situations.length} current situations`);
      return parsed;
    } catch (error) {
      status.record('datex', false, 'unreachable');
      throw error;
    }
  };

  const startRefresh = (): Promise<DatexSnapshot> => {
    inflight ??= refresh().finally(() => {
      inflight = null;
    });
    return inflight;
  };

  const snapshot = async (): Promise<DatexSnapshot> => {
    if (!cached) return startRefresh();
    if (Date.now() - cached.fetchedAt >= cacheTtlMs) {
      // Keep serving the last snapshot while the 24 MB national feed refreshes.
      void startRefresh().catch((error) => app.log.warn({ err: error }, 'DATEX refresh failed'));
    }
    return cached.snapshot;
  };

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

  app.post<{ Body: { points?: unknown } }>('/api/traffic/closures', async (request, reply) => {
    const points = routeShape(request.body?.points);
    if (points.length < 2) return reply.code(400).send({ error: 'route points are required' });
    try {
      const current = await snapshot();
      return reply.send({ closures: closuresNearRoute(current.closures, points) });
    } catch (error) {
      request.log.error({ err: error }, 'DATEX closure lookup failed');
      return reply.code(502).send({ error: 'traffic unavailable' });
    }
  });

  // Warm without blocking server startup; the first client normally arrives later.
  void startRefresh().catch((error) => app.log.warn({ err: error }, 'initial DATEX fetch failed'));
  return { enabled: true, meta: trafficLayerMeta() };
}
