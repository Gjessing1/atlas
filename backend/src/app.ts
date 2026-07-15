import { existsSync } from 'node:fs';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import {
  APP_NAME,
  photonFeatureToSearchResult,
  type PhotonFeature,
  type SearchResult,
} from '@atlas/core';
import Fastify, { type FastifyInstance } from 'fastify';

export interface AppOptions {
  /** Persistent data directory containing tiles/ and assets/ (ATLAS_DATA_DIR). */
  dataDir: string;
  /** Directory with the built web app; served same-origin when set. */
  publicDir?: string;
  /** Photon geocoder base URL (PHOTON_URL). */
  photonUrl?: string;
  logger?: boolean;
}

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false });

  app.get('/api/health', () => ({
    status: 'ok',
    app: APP_NAME,
    gitSha: process.env.GIT_SHA || 'dev',
  }));

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
        return reply.code(502).send({ error: 'search unavailable' });
      }
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
      return reply.code(502).send({ error: 'search unavailable' });
    }
  });

  // Map tiles: single-file .pmtiles archives that clients read piecewise via
  // HTTP range requests (@fastify/static answers Range with 206 slices).
  // Tiles are produced out-of-band by infrastructure/tiles/build-basemap.sh.
  const tilesDir = path.join(opts.dataDir, 'tiles');
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
      request.url.startsWith('/assets/')
    ) {
      return reply.code(404).send({ error: 'not found' });
    }
    // SPA fallback: client-side routes all resolve to the app shell.
    return reply.sendFile('index.html');
  });

  return app;
}
