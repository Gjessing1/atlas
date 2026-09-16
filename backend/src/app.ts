import { existsSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import {
  APP_NAME,
  parseAddressQuery,
  photonFeatureToSearchResult,
  photonSearchResults,
  type LatLng,
  type PhotonFeature,
  type SystemStatus,
} from '@atlas/core';
import { conflateCameras, nvdbLaneOverrides, nvdbSpeedOverrides } from '@atlas/routing';
import type { RouteInstruction } from '@atlas/routing';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { registerAppLinks } from './applinks.js';
import { registerElevationApi, type ElevationApiOptions } from './elevation-api.js';
import { registerDiagnosticsApi } from './diagnostics-api.js';
import { registerExploreApi } from './explore-api.js';
import {
  registerOverlayApi,
  speedCameraLayerMeta,
  type OverlayApiOptions,
} from './overlay/index.js';
import { NvdbStore } from './nvdb-db.js';
import { registerPacksApi } from './packs-api.js';
import { registerPlaceContentApi, type PlaceContentApiOptions } from './place-content-api.js';
import {
  createCensusReporter,
  registerPotentialApi,
  type PotentialApiOptions,
} from './potential/index.js';
import { derivedLayerMetas } from './potential/catalog.js';
import { allProbes, ProbeRunner, type ProbeRunnerOptions } from './probes.js';
import type { RegionJobOptions } from './region-jobs.js';
import { createRoutingRevisionReporter, ROUTING_STATUS_ID } from './routing-revision.js';
import { StatusRegistry } from './status.js';
import { registerTilesApi, type TilesApiOptions } from './tiles-api.js';
import { registerTerrainApi, type TerrainApiOptions } from './terrain-api.js';
import { registerUpdatesApi } from './updates-api.js';
import { registerInaturApi, type InaturApiOptions } from './inatur-api.js';
import {
  iceObservationLayerMeta,
  registerIceObservationsApi,
  type IceObservationsApiOptions,
} from './ice-observations-api.js';
import {
  registerSatellitesApi,
  satellitesLayerMeta,
  starlinkLayerMeta,
  type SatellitesApiOptions,
} from './satellites-api.js';
import {
  registerTransitApi,
  transitVehicleLayerMeta,
  type TransitApiOptions,
} from './transit-api.js';
import { registerTrafficApi, type TrafficApiOptions } from './traffic-api.js';
import { registerWeatherApi, type WeatherApiOptions } from './weather-api.js';
import { createPgStores } from './pg.js';
import {
  parseRegistrationMode,
  registerSyncApi,
  resolveRegistrationMode,
  type SyncApiOptions,
} from './sync-api.js';
import { createMemoryStores, type Stores } from './stores.js';

/**
 * Wall-clock ceiling for one /api/search, however many times the address
 * ladder has to loosen the query. One request keeps its own 5 s timeout, so
 * the ordinary path is unchanged; only a query that keeps coming back empty
 * can spend more, and never more than this.
 */
const SEARCH_BUDGET_MS = 8000;

export interface AppOptions {
  /** Persistent data directory containing tiles/ and assets/ (ATLAS_DATA_DIR). */
  dataDir: string;
  /** Directory with the built web app; served same-origin when set. */
  publicDir?: string;
  /** Photon geocoder base URL (PHOTON_URL). */
  photonUrl?: string;
  /** Valhalla routing engine base URL (VALHALLA_URL). */
  valhallaUrl?: string;
  /**
   * Sync database (DATABASE_URL). A postgres:// URL, or the literal 'memory'
   * for throwaway in-process stores (dev/e2e). Unset = no accounts, no sync —
   * the app runs anonymous local-only (backend services stay optional).
   */
  databaseUrl?: string;
  /** Secret for signing JWTs (JWT_SECRET); required when databaseUrl is set. */
  jwtSecret?: string;
  /** Account creation policy + auth rate-limit seam (REGISTRATION, REGISTRATION_INVITE_CODE). */
  syncApi?: SyncApiOptions;
  /**
   * Requests per IP per minute for the generous global limit. Tiles, assets and
   * packs are exempt (a single map pan is dozens of tile requests). 0 disables.
   */
  globalRateLimit?: number;
  /**
   * Upstream world tile source for /api/tiles (WORLD_TILES_URL): a
   * `{z}/{x}/{y}` URL template or a TileJSON URL. Defaults to OpenFreeMap's
   * planet TileJSON. See tiles-api.ts.
   */
  worldTilesUrl?: string;
  /** Test seams for the world tile proxy. */
  tilesApi?: Pick<TilesApiOptions, 'localTiles' | 'fetchImpl'>;
  /** Test/deployment seams for the proxied Terrarium DEM. */
  terrainApi?: TerrainApiOptions;
  /** Test seams for the overlay layer catalog + WMS proxy. */
  overlayApi?: Pick<OverlayApiOptions, 'layers' | 'fetchImpl' | 'env'>;
  /** Test seams for the met.no weather proxy. */
  weatherApi?: WeatherApiOptions;
  /** Test seams for the Entur public-transport proxy. */
  transitApi?: TransitApiOptions;
  /** Test seams for the authenticated NPRA DATEX traffic proxy. */
  trafficApi?: TrafficApiOptions;
  /** Test seams for the iNatur permit-boundary resolver. */
  inaturApi?: InaturApiOptions;
  /** Test seams for the public NVE Regobs ice-observation feed. */
  iceObservationsApi?: IceObservationsApiOptions;
  satellitesApi?: SatellitesApiOptions;
  /** Test seams for the Høydedata elevation proxy. */
  elevationApi?: Pick<ElevationApiOptions, 'fetchImpl' | 'userAgent'>;
  /** Test seam for Wikimedia place summaries. */
  placeContentApi?: PlaceContentApiOptions;
  /** Test/deployment seams for custom offline-region extraction. */
  regionJobs?: RegionJobOptions;
  /** Test seams for the derived-potential engine. */
  potentialApi?: Partial<PotentialApiOptions>;
  /**
   * Active upstream probes. `enabled` defaults to off under test —
   * a background sweep against real government services is not something a unit
   * test should trigger by existing.
   */
  probes?: ProbeRunnerOptions & { enabled?: boolean };
  /** Test seam: inject stores directly instead of via databaseUrl. */
  stores?: Stores;
  logger?: boolean;
}

/**
 * Freshness line for the local PMTiles basemap archives: newest mtime as a
 * date plus a count. Null when no archive exists (dev / world-tiles-only).
 */
async function basemapDetail(tilesDir: string): Promise<string | null> {
  let names: string[];
  try {
    names = (await readdir(tilesDir)).filter((n) => n.endsWith('.pmtiles'));
  } catch {
    return null; // no tiles dir at all
  }
  if (names.length === 0) return null;
  let newest = 0;
  for (const name of names) {
    try {
      newest = Math.max(newest, (await stat(path.join(tilesDir, name))).mtimeMs);
    } catch {
      // archive vanished between readdir and stat — ignore
    }
  }
  if (newest === 0) return null;
  const date = new Date(newest).toISOString().slice(0, 10);
  const count = names.length === 1 ? '1 archive' : `${names.length} archives`;
  return `map data from ${date} · ${count}`;
}

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false });

  // Per-upstream health, populated by real proxy traffic (see status.ts). The
  // catalog sources register themselves inside registerOverlayApi/Weather.
  const status = new StatusRegistry();
  status.register('photon', 'Photon (search)', 'Search');
  status.register(ROUTING_STATUS_ID, 'Valhalla (routing)', 'Routing');

  // Rate limiting, registered before any route so per-route `config.rateLimit`
  // (see sync-api.ts) is honoured. The global ceiling is deliberately loose —
  // it exists to bound a runaway client, not to shape normal traffic — and the
  // high-volume map paths are exempt entirely.
  const globalRateLimit = opts.globalRateLimit ?? Number(process.env.RATE_LIMIT_PER_MINUTE || 600);
  if (globalRateLimit > 0) {
    await app.register(fastifyRateLimit, {
      global: true,
      max: globalRateLimit,
      timeWindow: '1 minute',
      allowList: (request) =>
        request.url.startsWith('/api/tiles/') ||
        request.url.startsWith('/api/terrain/') ||
        request.url.startsWith('/api/overlay/') ||
        // Derived tiles only: /api/potential/prepare has its own tighter limit,
        // because it queues work rather than reading a file.
        (request.url.startsWith('/api/potential/') && request.url.includes('.png')) ||
        request.url.startsWith('/tiles/') ||
        request.url.startsWith('/assets/') ||
        request.url.startsWith('/packs/') ||
        request.url.startsWith('/region-jobs/files/'),
    });
  } else {
    // Still register (unlimited) so per-route limits keep working when the
    // global ceiling is switched off.
    await app.register(fastifyRateLimit, { global: false });
  }

  // Accounts + sync are optional: only live when a database is configured.
  let stores = opts.stores ?? null;
  if (!stores && opts.databaseUrl) {
    if (opts.databaseUrl === 'memory') {
      stores = createMemoryStores();
    } else {
      const pgStores = await createPgStores(opts.databaseUrl);
      app.addHook('onClose', () => pgStores.close());
      stores = pgStores;
    }
  }
  const syncApiOptions: SyncApiOptions = {
    registration: parseRegistrationMode(process.env.REGISTRATION),
    inviteCode: process.env.REGISTRATION_INVITE_CODE,
    ...opts.syncApi,
  };
  if (stores) {
    if (!opts.jwtSecret) throw new Error('JWT_SECRET is required when the sync database is set');
    await registerSyncApi(app, stores, opts.jwtSecret, syncApiOptions);
    status.register('postgres', 'PostgreSQL (sync)', 'Sync');
  }
  const syncStores = stores;

  app.get('/api/health', () => ({
    status: 'ok',
    app: APP_NAME,
    gitSha: process.env.GIT_SHA || 'dev',
    sync: stores !== null,
    // Lets the client show the right sign-up affordance (invite field, or none
    // at all) instead of offering a button the server will always refuse.
    registration: stores === null ? 'closed' : resolveRegistrationMode(syncApiOptions),
  }));
  registerDiagnosticsApi(app, opts.dataDir);

  // Basemap freshness is read from the PMTiles archives on disk, not probed.
  status.register('basemap', 'Basemap tiles', 'Map data');

  // Active upstream probes. The runner can only be built after the
  // overlay catalog is registered — that is what knows which layers this instance
  // actually serves — so the status routes below close over this holder rather
  // than over a value that does not exist yet.
  const probes: { runner?: ProbeRunner } = {};

  // The derived cells are our own artefacts, so their census is a local check
  // like the basemap's — but it watches something the upstream probes cannot
  // see: a cell built during an outage keeps that gap for good.
  const reportCells = createCensusReporter(opts.dataDir);

  // ...and the same blind spot one level up: the routing container is deployed
  // by hand, so a change to infrastructure/valhalla can be live in this repo and
  // in this backend while the router still answers off the image it started
  // from. Nothing else reports that — every route succeeds — so it is read from
  // the revision the two images stamp (see routing-revision.ts).
  const reportRoutingRevision = createRoutingRevisionReporter(opts.dataDir);

  /** Local, free checks: basemap freshness, the derived cells, a Postgres ping. */
  const refreshLocalStatus = async (): Promise<void> => {
    const detail = await basemapDetail(path.join(opts.dataDir, 'tiles'));
    status.setDetail('basemap', detail ?? 'no local archive — using world tiles');
    // A present, readable archive counts as ok; its absence isn't a failure
    // (the world-tile upstream covers everything), so leave that unknown.
    if (detail) status.record('basemap', true);
    await reportCells(status);
    await reportRoutingRevision(status);
    if (syncStores) {
      try {
        await syncStores.ping();
        status.record('postgres', true);
      } catch (err) {
        app.log.error({ err }, 'postgres ping failed');
        status.record('postgres', false, 'unreachable');
      }
    }
  };

  const snapshot = (): SystemStatus => ({
    app: APP_NAME,
    gitSha: process.env.GIT_SHA || 'dev',
    generatedAt: Date.now(),
    overall: status.overall(),
    sources: status.toStatus(),
    lastSweep: probes.runner?.snapshot.lastSweep ?? null,
    probing: probes.runner?.snapshot.probing ?? false,
  });

  // GET /api/status — per-upstream health for the settings/status page. Reading
  // it never probes an upstream: it reports what real traffic and the periodic
  // sweep have already established, so opening the page is free.
  app.get('/api/status', async (): Promise<SystemStatus> => {
    await refreshLocalStatus();
    return snapshot();
  });

  // POST /api/status/check — "Check now" on the status page: re-probe every
  // upstream and answer with the fresh snapshot. Rate-limited hard, because
  // this is the one route where a user's button press spends someone else's
  // bandwidth; concurrent presses also share a single sweep (see ProbeRunner).
  app.post(
    '/api/status/check',
    { config: { rateLimit: { max: 4, timeWindow: '5 minutes' } } },
    async (): Promise<SystemStatus> => {
      await Promise.all([refreshLocalStatus(), probes.runner?.run(true) ?? Promise.resolve()]);
      return snapshot();
    },
  );

  // Geocoding: thin proxy over the self-hosted Photon service so the client
  // never talks to it directly (single origin, no CORS, URL stays private).
  const photonUrl = opts.photonUrl ?? process.env.PHOTON_URL ?? 'http://127.0.0.1:2322';
  registerExploreApi(app, photonUrl, status);
  registerPlaceContentApi(app, opts.placeContentApi);
  app.get<{
    Querystring: { q?: string; limit?: string; lat?: string; lon?: string; bbox?: string };
  }>('/api/search', async (request, reply) => {
    const { q, limit, lat, lon, bbox } = request.query;
    if (!q?.trim()) {
      return reply.code(400).send({ error: 'missing query parameter: q' });
    }
    const address = parseAddressQuery(q);
    const url = new URL('/api', photonUrl);
    // `q` is set per attempt below — everything else is the same every time.
    url.searchParams.set('limit', String(Math.min(Number(limit) || 8, 20)));
    // Optional location bias: prefer results near the user's viewport.
    if (lat && lon) {
      url.searchParams.set('lat', lat);
      url.searchParams.set('lon', lon);
    }
    // Search-along-route first narrows Photon to the padded route bounds, then
    // applies the precise polyline corridor in the client. Canonicalise the
    // box here rather than forwarding arbitrary query syntax upstream.
    if (bbox !== undefined) {
      const values = bbox.split(',').map(Number);
      const [minLng, minLat, maxLng, maxLat] = values;
      if (
        values.length !== 4 ||
        values.some((value) => !Number.isFinite(value)) ||
        minLng! < -180 ||
        maxLng! > 180 ||
        minLat! < -90 ||
        maxLat! > 90 ||
        minLng! >= maxLng! ||
        minLat! >= maxLat!
      ) {
        return reply.code(400).send({ error: 'invalid query parameter: bbox' });
      }
      url.searchParams.set('bbox', values.join(','));
    }
    try {
      // A pasted postal address is the most natural thing a user types and the
      // case that failed hardest: the postcode makes Photon rank a whole street
      // above the house, and a house number OSM has never heard of empties the
      // result set entirely. So a query that found *nothing* is asked again,
      // one constraint looser each time. This costs nothing on the common path
      // — a query with results never reaches the second attempt — and the whole
      // ladder shares one budget, so three tries cannot add up to three times
      // the single-request worst case.
      const started = Date.now();
      let features: PhotonFeature[] = [];
      for (const attempt of [address.query, ...address.fallbacks]) {
        const remaining = SEARCH_BUDGET_MS - (Date.now() - started);
        if (remaining < 500) break;
        url.searchParams.set('q', attempt);
        const res = await fetch(url, { signal: AbortSignal.timeout(Math.min(5000, remaining)) });
        if (!res.ok) {
          request.log.error({ status: res.status }, 'photon error');
          status.record('photon', false, `HTTP ${res.status}`);
          return reply.code(502).send({ error: 'search unavailable' });
        }
        status.record('photon', true);
        const geojson = (await res.json()) as { features?: PhotonFeature[] };
        features = geojson.features ?? [];
        if (features.length > 0) break;
      }
      return { results: photonSearchResults(features, address) };
    } catch (err) {
      request.log.error({ err }, 'photon unreachable');
      status.record('photon', false, 'unreachable');
      return reply.code(502).send({ error: 'search unavailable' });
    }
  });

  // Reverse geocoding: what is at this coordinate? Used to label map-clicked
  // route stops with a place name instead of raw decimals.
  app.get<{ Querystring: { lat?: string; lon?: string } }>(
    '/api/search/reverse',
    async (request, reply) => {
      const lat = Number(request.query.lat);
      const lon = Number(request.query.lon);
      if (
        !Number.isFinite(lat) ||
        !Number.isFinite(lon) ||
        Math.abs(lat) > 90 ||
        Math.abs(lon) > 180
      ) {
        return reply.code(400).send({ error: 'lat and lon are required' });
      }
      const url = new URL('/reverse', photonUrl);
      url.searchParams.set('lat', String(lat));
      url.searchParams.set('lon', String(lon));
      url.searchParams.set('limit', '1');
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) {
          request.log.error({ status: res.status }, 'photon reverse error');
          status.record('photon', false, `HTTP ${res.status}`);
          return reply.code(502).send({ error: 'search unavailable' });
        }
        status.record('photon', true);
        const geojson = (await res.json()) as { features?: PhotonFeature[] };
        const result = (geojson.features ?? []).map(photonFeatureToSearchResult).find(Boolean);
        // No match is a normal answer here (open sea, wilderness), not an error.
        return { result: result ?? null };
      } catch (err) {
        request.log.error({ err }, 'photon unreachable');
        status.record('photon', false, 'unreachable');
        return reply.code(502).send({ error: 'search unavailable' });
      }
    },
  );

  // Routing: thin proxy over the self-hosted Valhalla service (same rationale
  // as the Photon proxy — single origin, service URL stays private). The
  // request body is a Valhalla /route payload built by @atlas/routing; the
  // same engine runs embedded on Android, so online and offline routes agree.
  const valhallaUrl = opts.valhallaUrl ?? process.env.VALHALLA_URL ?? 'http://127.0.0.1:8002';

  /** Proxy one Valhalla action, mapping its errors onto ours and recording health. */
  const proxyValhalla = async (
    path: '/route' | '/trace_attributes',
    request: FastifyRequest,
    reply: FastifyReply,
  ) => {
    try {
      const res = await fetch(new URL(path, valhallaUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request.body ?? {}),
        // Long leash: cross-country queries can take a few seconds.
        signal: AbortSignal.timeout(30_000),
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        // Pass Valhalla's message through ("No suitable edges near location",
        // …) but collapse the status: 4xx = bad request, anything else =
        // upstream. Valhalla errors look like {error_code, error, status_code}.
        const message =
          json !== null && typeof json === 'object' && 'error' in json
            ? String((json as { error: unknown }).error)
            : 'routing failed';
        const code = res.status >= 400 && res.status < 500 ? 400 : 502;
        // A 4xx is a bad route request (no edges near a point), not the engine
        // being down — only a 5xx counts against Valhalla's health.
        if (code === 502) {
          request.log.error({ status: res.status, message }, 'valhalla error');
          status.record('valhalla', false, `HTTP ${res.status}`);
        } else {
          status.record('valhalla', true);
        }
        return reply.code(code).send({ message });
      }
      status.record('valhalla', true);
      return json;
    } catch (err) {
      request.log.error({ err }, 'valhalla unreachable');
      status.record('valhalla', false, 'unreachable');
      return reply.code(502).send({ message: 'routing unavailable' });
    }
  };

  app.post('/api/route', (request, reply) => proxyValhalla('/route', request, reply));

  // Route enrichment: per-edge speed limits, tunnel flags and road classes for
  // a chosen route's shape (@atlas/routing's enrichRoute). Same engine, same
  // tiles as /api/route — the attributes are already there, /route just
  // doesn't report them.
  app.post('/api/route/attributes', (request, reply) =>
    proxyValhalla('/trace_attributes', request, reply),
  );

  // NVDB speed limits: the authoritative Norwegian source, layered over the
  // tile limits @atlas/routing already returns. Given a route
  // shape, the backend matches it against the shipped NVDB dataset and returns
  // the distance ranges where NVDB overrides the limit. Not a proxy — the data
  // is a static SQLite side-table, never a live NVDB call (offline-artefact
  // rule); the same conflation runs on-device against a pack's own copy.
  // The dataset is optional: like Postgres, an absent NVDB file is a healthy
  // config (routes keep their OSM/tile limits), not a failure — so only surface
  // it as a status source when it actually loaded, rather than recording a
  // permanent "down" that would drag the health rollup down on every instance
  // shipping without the Norwegian side-table.
  const nvdb = NvdbStore.open(opts.dataDir);
  if (nvdb) {
    status.register('nvdb', 'NVDB road data', 'Routing');
    status.record('nvdb', true);
    app.addHook('onClose', () => nvdb.close());
  }
  /** The request body's route shape, as validated points (possibly empty). */
  const routeShape = (raw: unknown): LatLng[] =>
    Array.isArray(raw)
      ? raw.filter(
          (p): p is LatLng =>
            typeof p === 'object' &&
            p !== null &&
            typeof (p as LatLng).lat === 'number' &&
            typeof (p as LatLng).lng === 'number',
        )
      : [];
  const shapeBounds = (points: LatLng[]): { sw: LatLng; ne: LatLng } => {
    let minLat = Infinity;
    let maxLat = -Infinity;
    let minLng = Infinity;
    let maxLng = -Infinity;
    for (const p of points) {
      if (p.lat < minLat) minLat = p.lat;
      if (p.lat > maxLat) maxLat = p.lat;
      if (p.lng < minLng) minLng = p.lng;
      if (p.lng > maxLng) maxLng = p.lng;
    }
    return { sw: { lat: minLat, lng: minLng }, ne: { lat: maxLat, lng: maxLng } };
  };
  app.post<{ Body: { points?: unknown } }>('/api/route/nvdb-limits', (request, reply) => {
    const points = routeShape(request.body?.points);
    if (!nvdb || points.length < 2) return reply.send({ overrides: [] });
    const { sw, ne } = shapeBounds(points);
    const segments = nvdb.querySpeedSegments(sw, ne);
    return reply.send({ overrides: nvdbSpeedOverrides(points, segments) });
  });

  // NVDB 616 dedicated turn lanes. Only maneuver geometry/sign fields cross
  // the wire; the shared matcher returns ordinary RouteLane rows keyed by
  // instruction index, so web and offline Android render the exact same data.
  app.post<{ Body: { points?: unknown; instructions?: unknown } }>(
    '/api/route/nvdb-lanes',
    (request, reply) => {
      const points = routeShape(request.body?.points);
      const raw = Array.isArray(request.body?.instructions) ? request.body.instructions : [];
      const parsed = raw.map((value): RouteInstruction | null => {
        if (typeof value !== 'object' || value === null) return null;
        const item = value as { sign?: unknown; interval?: unknown; exitAngleDeg?: unknown };
        if (
          typeof item.sign !== 'number' ||
          !Array.isArray(item.interval) ||
          item.interval.length !== 2 ||
          typeof item.interval[0] !== 'number' ||
          typeof item.interval[1] !== 'number'
        ) {
          return null;
        }
        return {
          text: '',
          distanceM: 0,
          timeMs: 0,
          sign: item.sign,
          interval: [item.interval[0], item.interval[1]],
          ...(typeof item.exitAngleDeg === 'number' ? { exitAngleDeg: item.exitAngleDeg } : {}),
        };
      });
      if (
        !nvdb?.hasLaneData ||
        points.length < 2 ||
        parsed.length === 0 ||
        parsed.some((instruction) => instruction === null)
      ) {
        return reply.send({ overrides: [] });
      }
      const instructions = parsed as RouteInstruction[];
      const { sw, ne } = shapeBounds(points);
      return reply.send({
        overrides: nvdbLaneOverrides({ points, instructions }, nvdb.queryLaneSegments(sw, ne)),
      });
    },
  );

  // ATK speed cameras from the same dataset: given a route
  // shape, return the point cameras it passes (direction-filtered) and the
  // average-speed sections it drives end to end. Empty is the normal answer
  // for a dataset without camera tables (an older build) or a route outside
  // Norway — never an error, so navigation degrades to exactly the pre-camera
  // behaviour.
  app.post<{ Body: { points?: unknown } }>('/api/route/nvdb-cameras', (request, reply) => {
    const points = routeShape(request.body?.points);
    if (!nvdb || points.length < 2) {
      return reply.send({ cameras: { points: [], sections: [] } });
    }
    const { sw, ne } = shapeBounds(points);
    const cameras = conflateCameras(points, {
      points: nvdb.queryCameraPoints(sw, ne),
      sections: nvdb.queryCameraSections(sw, ne),
    });
    return reply.send({ cameras });
  });

  // The same cameras as a map layer (LayerMeta.vector, catalog id
  // `speed-cameras`): the whole country in one GeoJSON response — 446 points
  // and 73 sections, small enough that viewport tiling would only add moving
  // parts. Empty without the dataset, like every other NVDB answer; the
  // catalog only lists the layer when the camera tables exist, so nothing
  // links here in that case.
  const WORLD = { sw: { lat: -90, lng: -180 }, ne: { lat: 90, lng: 180 } };
  /** ~1.1 m — plenty for a map dot, and it nearly halves the payload. */
  const round5 = (n: number): number => Math.round(n * 1e5) / 1e5;
  app.get('/api/overlay/speed-cameras/features', (_request, reply) => {
    const features: object[] = [];
    if (nvdb?.hasCameraData) {
      for (const p of nvdb.queryCameraPoints(WORLD.sw, WORLD.ne)) {
        features.push({
          type: 'Feature',
          properties: {
            kind: 'point',
            name: p.name,
            // Whole degrees: it orients an arrow at most, and the raw
            // veglenke-derived value carries meaningless double precision.
            bearingDeg: p.bearingDeg === null ? null : Math.round(p.bearingDeg),
          },
          geometry: { type: 'Point', coordinates: [round5(p.lng), round5(p.lat)] },
        });
      }
      for (const s of nvdb.queryCameraSections(WORLD.sw, WORLD.ne)) {
        features.push({
          type: 'Feature',
          properties: { kind: 'section', name: s.name },
          geometry: {
            type: 'LineString',
            coordinates: s.points.map((p) => [round5(p.lng), round5(p.lat)]),
          },
        });
      }
    }
    // Static per dataset build; the catalog `rev` in the URL busts this when
    // the layer's shape ever changes.
    void reply.header('cache-control', 'public, max-age=3600');
    return reply.send({ type: 'FeatureCollection', features });
  });

  // Authenticated NPRA DATEX II snapshot: cached server-side, exposed as a
  // vector overlay and as route-matched closure points. Credentials never
  // leave this one registered-egress backend.
  const traffic = registerTrafficApi(app, status, opts.trafficApi);

  // Map tiles, two ways:
  // - /api/tiles/<area>/{z}/{x}/{y}.pbf — merged endpoint the map style uses:
  //   local archive tiles where available, streamed from an upstream world
  //   source everywhere else (tiles-api.ts).
  // - /tiles/*.pmtiles — the raw archives via HTTP range requests
  //   (@fastify/static answers Range with 206 slices), still used by tooling
  //   and older clients.
  // Archives are produced out-of-band by infrastructure/tiles/build-basemap.sh.
  const tilesDir = path.join(opts.dataDir, 'tiles');
  registerTilesApi(app, {
    tilesDir,
    worldTilesUrl: opts.worldTilesUrl ?? process.env.WORLD_TILES_URL,
    ...opts.tilesApi,
  });
  registerTerrainApi(app, status, opts.terrainApi);
  if (existsSync(tilesDir)) {
    await app.register(fastifyStatic, {
      root: tilesDir,
      prefix: '/tiles/',
      decorateReply: false,
      allowedPath: (pathname) => pathname.endsWith('.pmtiles'),
      // Tiles rebuild on a schedule; let clients revalidate hourly.
      maxAge: '1h',
    });
  }

  // Overlay layer catalog + WMS tile/identify proxy. The tile cache lives on
  // its own disposable path — wiping it only costs re-fetches.
  const overlayLayers = registerOverlayApi(app, {
    cacheDir: process.env.TILECACHE_DIR ?? path.join(opts.dataDir, 'tilecache'),
    status,
    // Extra catalog rows with no WMS upstream behind them: the camera layer is
    // data-gated, not config-gated (it appears exactly when the NVDB dataset on
    // this instance carries the camera tables), and the derived surfaces are
    // served by the derive service registered below.
    extraMeta: [
      ...(nvdb?.hasCameraData ? [speedCameraLayerMeta()] : []),
      ...traffic.metas,
      transitVehicleLayerMeta(),
      iceObservationLayerMeta(),
      satellitesLayerMeta(),
      starlinkLayerMeta(),
      ...derivedLayerMetas(),
    ],
    ...opts.overlayApi,
  });

  // Rolling Regobs markers: a viewport-scoped vector feed, kept separate from
  // the static weakened-ice WMS so a mapped hazard can never masquerade as a
  // current field observation.
  registerIceObservationsApi(app, { status, ...opts.iceObservationsApi });

  // Orbital elements, cached on this instance's behalf. The only layer whose
  // positions the *client* computes: the backend is a compliant proxy in front
  // of CelesTrak and nothing more, which is also what keeps the layer working
  // on a device that has been offline for days.
  registerSatellitesApi(app, { status, dataDir: opts.dataDir, ...opts.satellitesApi });

  // Derived potential surfaces: the fixed-z11-cell derive
  // service — input adapters, the persisted job queue, and the revalidating tile
  // route. The engine's arithmetic lives in @atlas/potential; this is the
  // adapter that fetches, caches and serves. Cells are durable (they are the
  // product); the cached upstream input responses share the disposable tile
  // cache, because losing them only costs a re-fetch.
  await registerPotentialApi(app, {
    dataDir: opts.dataDir,
    cacheDir: process.env.TILECACHE_DIR ?? path.join(opts.dataDir, 'tilecache'),
    status,
    // "Best spots in view" walks each spot in from the nearest road, which is a
    // pedestrian route like any other — the same engine the planner uses, so an
    // instance without routing loses the walk time and keeps the spots.
    valhallaUrl,
    ...opts.potentialApi,
  });

  // The N7 sweep: one cheap request per upstream every few hours, over the
  // layers this instance actually serves plus the Fish & Hunt engine's inputs.
  // met.no is deliberately absent — its ToS asks for no synthetic polling, and
  // the weather proxy's own traffic reports it (see probes.ts).
  const probeRunner = new ProbeRunner(
    allProbes(overlayLayers, opts.overlayApi?.env ?? process.env),
    status,
    app.log,
    opts.probes ?? {},
  );
  probes.runner = probeRunner;
  if (opts.probes?.enabled ?? process.env.NODE_ENV !== 'test') {
    probeRunner.start();
    app.addHook('onClose', () => probeRunner.stop());
  }

  // Weather: met.no Locationforecast proxy (ToS discipline lives in
  // weather-api.ts — identifying UA, Expires caching, stale-on-failure).
  registerWeatherApi(app, { status, ...opts.weatherApi });

  // Public transport: Entur journey planner proxy (transit-api.ts — mandatory
  // ET-Client-Name header, Norway-only coverage check, Atlas trip model out).
  registerTransitApi(app, { status, ...opts.transitApi });

  // iNatur permit-boundary resolver: paste an offer link, get its exact area
  // (inatur-api.ts — 24-hex id parsing, Open-Inatur ArcGIS fan-out).
  registerInaturApi(app, { status, ...opts.inaturApi });

  // Point elevation: Kartverket Høydedata proxy (enriches tapped points /
  // saved places with a terrain height — no raster pipeline).
  registerElevationApi(app, { status, ...opts.elevationApi });

  // Map assets (style JSON, glyphs, sprites) fetched by
  // infrastructure/tiles/fetch-map-assets.sh into the data dir.
  const assetsDir = path.join(opts.dataDir, 'assets');
  if (existsSync(assetsDir)) {
    await app.register(fastifyStatic, {
      root: assetsDir,
      prefix: '/assets/',
      decorateReply: false,
      maxAge: '1d',
    });
  }

  // Offline region packs + Android app self-update (Phase 6).
  await registerPacksApi(app, opts.dataDir, opts.regionJobs);
  registerUpdatesApi(app, opts.dataDir);

  // Android App Links: lets a shared Atlas link open the app rather than a
  // browser tab. Registered before the SPA fallback, which would otherwise
  // answer the verifier with the app shell.
  registerAppLinks(app, process.env.ANDROID_CERT_SHA256);

  // In production the built web app is copied to backend/public (see backend/Dockerfile)
  // and served same-origin. In dev, Vite serves the web app and proxies here.
  if (opts.publicDir) {
    await app.register(fastifyStatic, { root: opts.publicDir });
  }
  app.setNotFoundHandler((request, reply) => {
    if (
      !opts.publicDir ||
      request.url.startsWith('/api/') ||
      request.url.startsWith('/tiles/') ||
      request.url.startsWith('/assets/') ||
      request.url.startsWith('/packs/') ||
      request.url.startsWith('/region-jobs/') ||
      request.url.startsWith('/app/')
    ) {
      return reply.code(404).send({ error: 'not found' });
    }
    // SPA fallback: client-side routes all resolve to the app shell.
    return reply.sendFile('index.html');
  });

  return app;
}
