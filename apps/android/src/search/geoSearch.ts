import {
  coordinateSearchResult,
  parseCoordinateQuery,
  type LatLng,
  type SearchResult,
} from '@atlas/core';
import { fetchTransitStops, mergeTransitSearchResults } from '@atlas/transit';

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
  /** Rank Entur/NSR stops ahead of general addresses. Online-only by design. */
  transit?: boolean;
  signal?: AbortSignal;
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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);
  const abort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener('abort', abort, { once: true });
  try {
    const params = new URLSearchParams({ q: text });
    if (options.limit !== undefined) params.set('limit', String(options.limit));
    if (options.bbox) params.set('bbox', options.bbox);
    const bias = await getBias?.().catch(() => null);
    if (bias) {
      params.set('lat', String(bias.lat));
      params.set('lon', String(bias.lng));
    }
    const origin = getServerOrigin();
    const signal = controller.signal;
    const general = async (): Promise<SearchResult[]> => {
      const res = await fetch(`${origin}/api/search?${params}`, { signal });
      if (!res.ok) throw new Error(`search: HTTP ${res.status}`);
      return ((await res.json()) as { results: SearchResult[] }).results;
    };
    if (!options.transit) return { results: await general(), offline: false };

    const [stops, addresses] = await Promise.allSettled([
      fetchTransitStops(text, {
        baseUrl: origin,
        signal,
        bias,
        limit: options.limit,
      }),
      general(),
    ]);
    if (stops.status === 'rejected' && addresses.status === 'rejected') {
      throw new Error('online search unavailable');
    }
    return {
      results: mergeTransitSearchResults(
        stops.status === 'fulfilled' ? stops.value : [],
        addresses.status === 'fulfilled' ? addresses.value : [],
        options.limit,
      ),
      offline: false,
    };
  } catch {
    if (options.signal?.aborted) throw options.signal.reason;
    return { results: await searchOffline(packs, text, options.limit), offline: true };
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abort);
  }
}
