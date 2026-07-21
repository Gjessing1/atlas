import {
  coordinateSearchResult,
  parseCoordinateQuery,
  type LatLng,
  type SearchResult,
} from '@atlas/core';

import type { LocalPack } from '../regions/packs';
import { getServerOrigin } from '../serverOrigin';
import { searchOffline } from './offlineSearch';

/**
 * Supplier of the current map centre, used to bias geocoder results towards
 * the viewport (web parity — SearchBox sends lat/lon the same way). Async
 * because the native map exposes its camera through promise-returning getters.
 */
export type SearchBias = () => Promise<LatLng | null>;

export interface GeoSearchOptions {
  /** Photon-formatted minLon,minLat,maxLon,maxLat route bounds. */
  bbox?: string;
  limit?: number;
}

/**
 * Geocode a query: the server's Photon proxy (/api/search) when online, the
 * downloaded packs' FTS5 databases when it can't be reached. Shared by the
 * search overlay and the route planner's stop search.
 */
export async function geoSearch(
  packs: LocalPack[],
  text: string,
  getBias?: SearchBias,
  options: GeoSearchOptions = {},
): Promise<{ results: SearchResult[]; offline: boolean }> {
  // A typed-in coordinate pair is its own result — no geocoder involved, so
  // it also works offline (and in the route planner's stop search).
  const coord = parseCoordinateQuery(text);
  if (coord) return { results: [coordinateSearchResult(coord)], offline: false };
  try {
    const params = new URLSearchParams({ q: text });
    if (options.limit !== undefined) params.set('limit', String(options.limit));
    if (options.bbox) params.set('bbox', options.bbox);
    const bias = await getBias?.().catch(() => null);
    if (bias) {
      params.set('lat', String(bias.lat));
      params.set('lon', String(bias.lng));
    }
    const res = await fetch(`${getServerOrigin()}/api/search?${params}`, {
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) throw new Error(`search: HTTP ${res.status}`);
    const { results } = (await res.json()) as { results: SearchResult[] };
    return { results, offline: false };
  } catch {
    return { results: await searchOffline(packs, text, options.limit), offline: true };
  }
}
