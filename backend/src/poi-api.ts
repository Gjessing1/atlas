import {
  isPoiCategoryId,
  mergePoiResults,
  parsePoiTileKey,
  poiQueryCategories,
  poiPairKey,
  poiTileKey,
  poiViewportIsQueryable,
  poiViewportTiles,
  POI_MAX_TILES,
  type LngLatBbox,
  type PoiCategoryId,
  type PoiTile,
} from '@atlas/core';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { PoiPairDb } from './poi-cache.js';
import { LocalPoiSource } from './poi-local-source.js';
import { PoiSource, PoiUpstreamBusyError } from './poi-source.js';
import type { StatusRegistry } from './status.js';

/**
 * Public Overpass instances, in order. The second is only asked while the first
 * is backing off (see PoiSource). overpass-api.de refused this host's IPv4 on
 * 2026-09-19 after the storm poi-source.ts describes.
 */
const DEFAULT_OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

export interface PoiApiOptions {
  /** Keeps answers in `<dataDir>/poi-cache` across restarts; memory only without it. */
  dataDir?: string;
  /** Overrides OVERPASS_URL, a comma-separated list. */
  overpassUrls?: readonly string[];
  fetchImpl?: typeof fetch;
  userAgent?: string;
  /** PoiSource tuning, for tests. */
  minGapMs?: number;
  now?: () => number;
}

function parseBbox(value: string | undefined): LngLatBbox | null {
  const values = value?.split(',').map(Number);
  if (
    values?.length !== 4 ||
    values.some((item) => !Number.isFinite(item)) ||
    values[0]! < -180 ||
    values[2]! > 180 ||
    values[1]! < -90 ||
    values[3]! > 90 ||
    values[2]! <= values[0]! ||
    values[3]! <= values[1]!
  ) {
    return null;
  }
  return values as LngLatBbox;
}

/** One zoom level, at most POI_MAX_TILES, no duplicates; null when anything is off. */
function parseTiles(value: string): PoiTile[] | null {
  const keys = [...new Set(value.split(',').filter(Boolean))];
  if (!keys.length || keys.length > POI_MAX_TILES) return null;
  const tiles = keys.map(parsePoiTileKey);
  if (tiles.some((tile) => tile === null)) return null;
  return tiles.every((tile) => tile!.z === tiles[0]!.z) ? (tiles as PoiTile[]) : null;
}

function parseCategories(value: string | undefined): PoiCategoryId[] | null {
  if (!value) return [];
  const values = [...new Set(value.split(',').filter(Boolean))];
  return values.every(isPoiCategoryId) ? values : null;
}

/** Aborts when the client hangs up before its answer is sent. */
function clientGone(reply: FastifyReply): AbortSignal {
  const controller = new AbortController();
  reply.raw.on('close', () => {
    if (!reply.raw.writableFinished) controller.abort();
  });
  return controller.signal;
}

/** Full-tag OSM places for the category-pin layer, by (tile × category). */
export function registerPoiApi(
  app: FastifyInstance,
  options: PoiApiOptions = {},
  status?: StatusRegistry,
): () => void {
  const endpoints =
    options.overpassUrls ??
    process.env.OVERPASS_URL?.split(',')
      .map((url) => url.trim())
      .filter(Boolean) ??
    DEFAULT_OVERPASS_URLS;
  const store = options.dataDir
    ? PoiPairDb.open(options.dataDir, undefined, undefined, (error) =>
        app.log.warn({ err: error }, 'POI cache unavailable on disk; keeping answers in memory'),
      )
    : null;
  if (store) app.addHook('onClose', async () => store.close());
  const source = new PoiSource({
    store,
    endpoints: endpoints.length ? endpoints : DEFAULT_OVERPASS_URLS,
    fetchImpl: options.fetchImpl,
    userAgent: options.userAgent,
    status,
    now: options.now,
    minGapMs: options.minGapMs,
    onError: (error, endpoint) =>
      app.log.warn({ err: error, endpoint }, 'Overpass POI query failed; backing off'),
  });
  const local = options.dataDir
    ? new LocalPoiSource(options.dataDir, status, options.now, (error) =>
        app.log.warn({ err: error }, 'local POI database unavailable; using Overpass fallback'),
      )
    : null;
  if (local) app.addHook('onClose', async () => local.close());

  app.get<{ Querystring: { tiles?: string; bbox?: string; categories?: string } }>(
    '/api/pois',
    async (request, reply) => {
      const categories = parseCategories(request.query.categories);
      if (categories === null) return reply.code(400).send({ error: 'unknown category' });
      const queried = poiQueryCategories(categories);

      // Bundles up to 0.230.0 send their viewport; it goes through the same
      // tiles, cache and queue as everything else.
      let legacyBbox: LngLatBbox | null = null;
      let tiles: PoiTile[] | null;
      if (request.query.tiles !== undefined) {
        tiles = parseTiles(request.query.tiles);
      } else {
        legacyBbox = parseBbox(request.query.bbox);
        // The same geographic cap as the client keeps this from turning into
        // a continent scan.
        if (legacyBbox && !poiViewportIsQueryable(legacyBbox, 9)) {
          return reply.code(400).send({ error: 'viewport is too large; zoom in' });
        }
        // A tile about as wide as the view: ~2×2 tiles, like a phone screen.
        tiles = legacyBbox
          ? poiViewportTiles(legacyBbox, Math.log2(360 / (legacyBbox[2] - legacyBbox[0])))
          : null;
      }
      if (!tiles) return reply.code(400).send({ error: 'valid tiles or bbox are required' });

      const pairs = tiles.flatMap((tile) => queried.map((category) => ({ tile, category })));
      try {
        const signal = clientGone(reply);
        const partition = local?.partition(pairs) ?? { local: [], remote: pairs };
        const [localAnswers, remoteAnswers] = await Promise.all([
          partition.local.length
            ? Promise.resolve(local!.get(partition.local, signal))
            : Promise.resolve([]),
          partition.remote.length ? source.get(partition.remote, signal) : Promise.resolve([]),
        ]);
        // Preserve the request order. Callers normally key answers by tile and
        // category, but legacy bundles relied on stable order as well.
        const byPair = new Map(
          [...localAnswers, ...remoteAnswers].map((answer) => [
            poiPairKey(answer.tile, answer.category),
            answer,
          ]),
        );
        const answers = pairs.map((pair) =>
          byPair.get(poiPairKey(poiTileKey(pair.tile), pair.category))!,
        );
        reply.header('Cache-Control', 'private, max-age=300');
        if (legacyBbox) {
          return {
            results: mergePoiResults(
              answers.map((answer) => answer.results),
              legacyBbox,
            ),
          };
        }
        return { tiles: answers };
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          return reply.code(499).send();
        }
        if (error instanceof PoiUpstreamBusyError) {
          reply.header('Retry-After', String(error.retryAfterS));
          return reply.code(503).send({ error: 'points of interest are busy; try again shortly' });
        }
        request.log.error({ err: error, tiles: tiles.map(poiTileKey) }, 'POI query failed');
        return reply.code(502).send({ error: 'points of interest are unavailable' });
      }
    },
  );
  return () => local?.refreshStatus();
}
