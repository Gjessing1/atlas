import type { ElevationResponse } from '@atlas/core';
import type { FastifyInstance } from 'fastify';
import type { StatusRegistry } from './status.js';

/**
 * GET /api/elevation?lat=..&lon=.. — terrain height at a single point from
 * Kartverket's Høydedata point service (national elevation model). A cheap way
 * to enrich a dropped pin / saved place with an altitude, no raster pipeline.
 *
 * The upstream answers in ETRS89 geographic (koordsys 4258 ≈ WGS84 for our
 * purposes). Points outside Norway / off the model come back with a null
 * height — reported as `elevationM: null`, not an error, so the caller shows
 * "no elevation here" rather than a failure.
 */

const HOYDEDATA_URL = 'https://ws.geonorge.no/hoydedata/v1/punkt';

/** Upstream shape: `punkter[].z` is the height in metres (null off-coverage). */
interface HoydedataResponse {
  punkter?: { z?: number | null; datakilde?: string | null }[];
}

const PROBE = 'hoydedata';

export interface ElevationApiOptions {
  /** Test seam: upstream HTTP. */
  fetchImpl?: typeof fetch;
  /** Identifying UA (Geonorge asks for one, like met.no). */
  userAgent?: string;
  /** Health registry: Høydedata is one probed source. */
  status?: StatusRegistry;
}

/** ~1 m grid: round the query so nearby taps share a cached height. */
const roundCoord = (n: number): number => Math.round(n * 1e5) / 1e5;

export function registerElevationApi(app: FastifyInstance, opts: ElevationApiOptions = {}): void {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const status = opts.status;
  status?.register(PROBE, 'Høydedata (elevation)', 'Terrain');
  const userAgent =
    opts.userAgent ??
    process.env.GEONORGE_USER_AGENT ??
    'atlas-maps/1.0 git.gjessing.io/gjessing1/atlas lars@gjessing.io';

  // Terrain height doesn't change: cache resolved points for the process
  // lifetime, capped so a scripted client can't grow it without bound.
  const cache = new Map<string, ElevationResponse>();
  const CACHE_CAP = 500;

  app.get<{ Querystring: { lat?: string; lon?: string } }>(
    '/api/elevation',
    async (request, reply) => {
      const lat = Number(request.query.lat);
      const lon = Number(request.query.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        return reply.code(400).send({ error: 'lat and lon are required' });
      }
      const rLat = roundCoord(lat);
      const rLon = roundCoord(lon);
      const key = `${rLat},${rLon}`;
      const hit = cache.get(key);
      if (hit) return hit;

      const url = new URL(HOYDEDATA_URL);
      url.searchParams.set('nord', String(rLat));
      url.searchParams.set('ost', String(rLon));
      url.searchParams.set('koordsys', '4258');

      let res: Response;
      try {
        res = await fetchImpl(url, {
          headers: { 'User-Agent': userAgent },
          signal: AbortSignal.timeout(8000),
        });
      } catch (err) {
        request.log.error({ err }, 'hoydedata unreachable');
        status?.record(PROBE, false, 'unreachable');
        return reply.code(502).send({ error: 'elevation unavailable' });
      }
      if (!res.ok) {
        request.log.error({ status: res.status }, 'hoydedata error');
        status?.record(PROBE, false, `HTTP ${res.status}`);
        return reply.code(502).send({ error: 'elevation unavailable' });
      }
      status?.record(PROBE, true);

      const body = (await res.json()) as HoydedataResponse;
      const point = body.punkter?.[0];
      const z = point?.z;
      const result: ElevationResponse = {
        elevationM: typeof z === 'number' ? Math.round(z * 10) / 10 : null,
        ...(point?.datakilde ? { source: point.datakilde } : {}),
      };
      // Only cache real coverage — a null now may be a transient upstream gap,
      // and re-asking later is cheap.
      if (result.elevationM !== null) {
        if (cache.size >= CACHE_CAP) cache.clear();
        cache.set(key, result);
      }
      return result;
    },
  );
}
