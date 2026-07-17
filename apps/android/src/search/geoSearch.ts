import type { SearchResult } from '@atlas/core';

import type { LocalPack } from '../regions/packs';
import { getServerOrigin } from '../serverOrigin';
import { searchOffline } from './offlineSearch';

/**
 * Geocode a query: the server's Photon proxy (/api/search) when online, the
 * downloaded packs' FTS5 databases when it can't be reached. Shared by the
 * search overlay and the route planner's stop search.
 */
export async function geoSearch(
  packs: LocalPack[],
  text: string,
): Promise<{ results: SearchResult[]; offline: boolean }> {
  try {
    const res = await fetch(`${getServerOrigin()}/api/search?q=${encodeURIComponent(text)}`, {
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) throw new Error(`search: HTTP ${res.status}`);
    const { results } = (await res.json()) as { results: SearchResult[] };
    return { results, offline: false };
  } catch {
    return { results: await searchOffline(packs, text), offline: true };
  }
}
