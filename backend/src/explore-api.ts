import {
  exploreCategory,
  isExploreCategory,
  photonFeatureToSearchResult,
  rankExploreResults,
  type PhotonFeature,
  type SearchResult,
} from '@atlas/core';
import type { FastifyInstance } from 'fastify';
import type { StatusRegistry } from './status.js';

/** Category-filtered Photon browsing around the current map view. */
export function registerExploreApi(
  app: FastifyInstance,
  photonUrl: string,
  status: StatusRegistry,
): void {
  app.get<{
    Querystring: { category?: string; lat?: string; lon?: string; radius?: string };
  }>('/api/explore', async (request, reply) => {
    const { category: rawCategory } = request.query;
    const lat = Number(request.query.lat);
    const lon = Number(request.query.lon);
    const radiusM = Math.min(50_000, Math.max(200, Number(request.query.radius) || 5_000));
    if (
      !isExploreCategory(rawCategory) ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      Math.abs(lat) > 90 ||
      Math.abs(lon) > 180
    ) {
      return reply.code(400).send({ error: 'valid category, lat and lon are required' });
    }

    const results: SearchResult[] = [];
    let succeeded = 0;
    await Promise.all(
      exploreCategory(rawCategory).osmTags.map(async (tag) => {
        const [key, value] = tag.split('/');
        const url = new URL('/reverse', photonUrl);
        url.searchParams.set('lat', String(lat));
        url.searchParams.set('lon', String(lon));
        url.searchParams.set('radius', String(radiusM / 1_000));
        url.searchParams.set('limit', '12');
        url.searchParams.set('osm_tag', `${key}:${value}`);
        try {
          const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
          if (!response.ok) return;
          const geojson = (await response.json()) as { features?: PhotonFeature[] };
          results.push(
            ...(geojson.features ?? [])
              .map(photonFeatureToSearchResult)
              .filter((result): result is SearchResult => result !== null),
          );
          succeeded++;
        } catch {
          // One tag can be missing from an import style while the category's
          // other tags still provide a useful browse list.
        }
      }),
    );
    if (succeeded === 0) {
      status.record('photon', false, 'explore unavailable');
      return reply.code(502).send({ error: 'explore unavailable' });
    }
    status.record('photon', true);
    return { results: rankExploreResults(results, { lat, lng: lon }, radiusM) };
  });
}
