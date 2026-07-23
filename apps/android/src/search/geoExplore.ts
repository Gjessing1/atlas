import type { ExploreCategoryId, LatLng, SearchResult } from '@atlas/core';

import type { LocalPack } from '../regions/packs';
import { getServerOrigin } from '../serverOrigin';
import { exploreOffline } from './offlineExplore';

/** Browse nearby POIs online, with the downloaded pack index as the fallback. */
export async function geoExplore(
  packs: LocalPack[],
  category: ExploreCategoryId,
  center: LatLng,
  radiusM: number,
): Promise<{ results: SearchResult[]; offline: boolean }> {
  try {
    const params = new URLSearchParams({
      category,
      lat: String(center.lat),
      lon: String(center.lng),
      radius: String(radiusM),
    });
    const response = await fetch(`${getServerOrigin()}/api/explore?${params}`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`explore: HTTP ${response.status}`);
    return {
      results: ((await response.json()) as { results: SearchResult[] }).results,
      offline: false,
    };
  } catch {
    return { results: await exploreOffline(packs, category, center, radiusM), offline: true };
  }
}
