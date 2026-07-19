import { existsSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import {
  APP_NAME,
  photonFeatureToSearchResult,
  type PhotonFeature,
  type SearchResult,
  type SystemStatus,
} from '@atlas/core';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerElevationApi, type ElevationApiOptions } from './elevation-api.js';
import { registerOverlayApi, type OverlayApiOptions } from './overlay-api.js';
import { registerPacksApi } from './packs-api.js';
import { StatusRegistry } from './status.js';
import { registerTilesApi, type TilesApiOptions } from './tiles-api.js';
import { registerUpdatesApi } from './updates-api.js';
import { registerWeatherApi, type WeatherApiOptions } from './weather-api.js';
import { createPgStores } from './pg.js';
import { registerSyncApi } from './sync-api.js';
import { createMemoryStores, type Stores } from './stores.js';

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
  /**
   * Upstream world tile source for /api/tiles (WORLD_TILES_URL): a
   * `{z}/{x}/{y}` URL template or a TileJSON URL. Defaults to OpenFreeMap's
   * planet TileJSON. See tiles-api.ts.
   */
  worldTilesUrl?: string;
  /** Test seams for the world tile proxy. */
  tilesApi?: Pick<TilesApiOptions, 'localTiles' | 'fetchImpl'>;
  /** Test seams for the overlay layer catalog + WMS proxy. */
  overlayApi?: Pick<OverlayApiOptions, 'layers' | 'fetchImpl' | 'env'>;
  /** Test seams for the met.no weather proxy. */
  weatherApi?: WeatherApiOptions;
  /** Test seams for the Høydedata elevation proxy. */
  elevationApi?: Pick<ElevationApiOptions, 'fetchImpl' | 'userAgent'>;
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
  status.register('valhalla', 'Valhalla (routing)', 'Routing');

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
  if (stores) {
    if (!opts.jwtSecret) throw new Error('JWT_SECRET is required when the sync database is set');
    await registerSyncApi(app, stores, opts.jwtSecret);
    status.register('postgres', 'PostgreSQL (sync)', 'Sync');
  }
  const syncStores = stores;

  app.get('/api/health', () => ({
    status: 'ok',
    app: APP_NAME,
    gitSha: process.env.GIT_SHA || 'dev',
    sync: stores !== null,
  }));

  // Basemap freshness is read from the PMTiles archives on disk, not probed.
  status.register('basemap', 'Basemap tiles', 'Map data');

  // GET /api/status — per-upstream health for the settings/status page.
  // Probe outcomes come from real traffic; freshness/liveness are read here.
  app.get('/api/status', async (): Promise<SystemStatus> => {
    const detail = await basemapDetail(path.join(opts.dataDir, 'tiles'));
    status.setDetail('basemap', detail ?? 'no local archive — using world tiles');
    // A present, readable archive counts as ok; its absence isn't a failure
    // (the world-tile upstream covers everything), so leave that unknown.
    if (detail) status.record('basemap', true);
    if (syncStores) {
      try {
        await syncStores.ping();
        status.record('postgres', true);
      } catch (err) {
        app.log.error({ err }, 'postgres ping failed');
        status.record('postgres', false, 'unreachable');
      }
    }
    return {
      app: APP_NAME,
      gitSha: process.env.GIT_SHA || 'dev',
      generatedAt: Date.now(),
      overall: status.overall(),
      sources: status.toStatus(),
    };
  });

  // Geocoding: thin proxy over the self-hosted Photon service so the client
  // never talks to it directly (single origin, no CORS, URL stays private).
  const photonUrl = opts.photonUrl ?? process.env.PHOTON_URL ?? 'http://127.0.0.1:2322';
  app.get<{
    Querystring: { q?: string; limit?: string; lat?: string; lon?: string };
  }>('/api/search', async (request, reply) => {
    const { q, limit, lat, lon } = request.query;
    if (!q?.trim()) {
      return reply.code(400).send({ error: 'missing query parameter: q' });
    }
    const url = new URL('/api', photonUrl);
    url.searchParams.set('q', q.trim());
    url.searchParams.set('limit', String(Math.min(Number(limit) || 8, 20)));
    // Optional location bias: prefer results near the user's viewport.
    if (lat && lon) {
      url.searchParams.set('lat', lat);
      url.searchParams.set('lon', lon);
    }
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) {
        request.log.error({ status: res.status }, 'photon error');
        status.record('photon', false, `HTTP ${res.status}`);
        return reply.code(502).send({ error: 'search unavailable' });
      }
      status.record('photon', true);
      const geojson = (await res.json()) as { features?: PhotonFeature[] };
      // Photon often returns several OSM objects for one real-world place
      // (peak + trail + viewpoint all named alike); collapse to one per label.
      const seen = new Set<string>();
      const results = (geojson.features ?? [])
        .map(photonFeatureToSearchResult)
        .filter((r): r is SearchResult => {
          if (r === null) return false;
          const key = `${r.name}|${r.label}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      return { results };
    } catch (err) {
      request.log.error({ err }, 'photon unreachable');
      status.record('photon', false, 'unreachable');
      return reply.code(502).send({ error: 'search unavailable' });
    }
  });

  // Routing: thin proxy over the self-hosted Valhalla service (same rationale
  // as the Photon proxy — single origin, service URL stays private). The
  // request body is a Valhalla /route payload built by @atlas/routing; the
  // same engine runs embedded on Android, so online and offline routes agree.
  const valhallaUrl = opts.valhallaUrl ?? process.env.VALHALLA_URL ?? 'http://127.0.0.1:8002';
  app.post('/api/route', async (request, reply) => {
    try {
      const res = await fetch(new URL('/route', valhallaUrl), {
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
  });

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
  registerOverlayApi(app, {
    cacheDir: process.env.TILECACHE_DIR ?? path.join(opts.dataDir, 'tilecache'),
    status,
    ...opts.overlayApi,
  });

  // Weather: met.no Locationforecast proxy (ToS discipline lives in
  // weather-api.ts — identifying UA, Expires caching, stale-on-failure).
  registerWeatherApi(app, { status, ...opts.weatherApi });

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
  await registerPacksApi(app, opts.dataDir);
  registerUpdatesApi(app, opts.dataDir);

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
      request.url.startsWith('/app/')
    ) {
      return reply.code(404).send({ error: 'not found' });
    }
    // SPA fallback: client-side routes all resolve to the app shell.
    return reply.sendFile('index.html');
  });

  return app;
}
