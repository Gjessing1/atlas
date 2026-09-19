import {
  isPoiCategoryId,
  overpassPoiQuery,
  overpassPoiResults,
  poiViewportIsQueryable,
  type LngLatBbox,
  type OverpassPoiElement,
  type PoiCategoryId,
  type PoiResult,
} from '@atlas/core';
import type { FastifyInstance } from 'fastify';
import type { StatusRegistry } from './status.js';

const DEFAULT_OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const CACHE_TTL_MS = 5 * 60_000;
const MAX_CACHE_ENTRIES = 80;

export interface PoiApiOptions {
  overpassUrl?: string;
  fetchImpl?: typeof fetch;
  userAgent?: string;
}

interface CacheEntry {
  expires: number;
  results: PoiResult[];
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

function parseCategories(value: string | undefined): PoiCategoryId[] | null {
  if (!value) return [];
  const values = [...new Set(value.split(',').filter(Boolean))];
  return values.every(isPoiCategoryId) ? values : null;
}

/** Full-tag, viewport-bounded OSM places for the category-pin layer. */
export function registerPoiApi(
  app: FastifyInstance,
  options: PoiApiOptions = {},
  status?: StatusRegistry,
): void {
  const fetchImpl = options.fetchImpl ?? fetch;
  const overpassUrl = options.overpassUrl ?? process.env.OVERPASS_URL ?? DEFAULT_OVERPASS_URL;
  const userAgent = options.userAgent ?? 'Atlas/1.0 (self-hosted mapping app)';
  const cache = new Map<string, CacheEntry>();

  app.get<{ Querystring: { bbox?: string; categories?: string } }>(
    '/api/pois',
    async (request, reply) => {
      const bbox = parseBbox(request.query.bbox);
      const categories = parseCategories(request.query.categories);
      if (!bbox || categories === null) {
        return reply.code(400).send({ error: 'valid bbox and categories are required' });
      }
      // The backend cannot know the client zoom, but the same geographic cap
      // closes direct calls that try to turn this into a continent scan.
      if (!poiViewportIsQueryable(bbox, 9)) {
        return reply.code(400).send({ error: 'viewport is too large; zoom in' });
      }

      // Keep the requested bounds exact so a cached response never leaks a pin
      // from just outside a later, nearly identical viewport.
      const cacheKey = `${bbox.join(',')}|${categories.join(',')}`;
      const cached = cache.get(cacheKey);
      if (cached && cached.expires > Date.now()) {
        reply.header('Cache-Control', 'private, max-age=60');
        return { results: cached.results };
      }

      const center = {
        lat: (bbox[1] + bbox[3]) / 2,
        lng: (bbox[0] + bbox[2]) / 2,
      };
      try {
        const body = new URLSearchParams({ data: overpassPoiQuery(bbox, categories) });
        const response = await fetchImpl(overpassUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
            'User-Agent': userAgent,
          },
          body,
          signal: AbortSignal.timeout(20_000),
        });
        if (!response.ok) throw new Error(`Overpass HTTP ${response.status}`);
        const json = (await response.json()) as { elements?: OverpassPoiElement[] };
        const results = overpassPoiResults(json.elements ?? [], center, categories).filter(
          (result) =>
            result.position.lng >= bbox[0] &&
            result.position.lng <= bbox[2] &&
            result.position.lat >= bbox[1] &&
            result.position.lat <= bbox[3],
        );
        cache.set(cacheKey, { results, expires: Date.now() + CACHE_TTL_MS });
        status?.record('overpass', true);
        while (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
        reply.header('Cache-Control', 'private, max-age=60');
        return { results };
      } catch (error) {
        status?.record('overpass', false, 'POI query unavailable');
        request.log.error({ err: error }, 'POI viewport query failed');
        return reply.code(502).send({ error: 'points of interest are unavailable' });
      }
    },
  );
}
