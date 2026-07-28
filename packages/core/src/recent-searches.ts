/**
 * Recently picked search results — the model behind both apps' search box.
 *
 * The list is device-local by design (a phone's recents are not the laptop's),
 * which on Android means a `local.` setting that never syncs and on web means
 * `localStorage`. Only that persistence differs; the parse, the dedupe key and
 * the cap live here so the two boxes cannot drift apart again.
 */

import type { SearchResult } from './search.js';

/** Android's settings key. `local.` keys never sync — see AtlasStorage. */
export const RECENT_SEARCHES_SETTING = 'local.search.recent';

/** How many picks are remembered; the oldest falls off the end. */
export const MAX_RECENT_SEARCHES = 8;

/**
 * Parse the persisted list — empty when absent or malformed, because a broken
 * recents list is a convenience lost, never an error worth surfacing. Fields
 * are checked rather than cast: whatever wrote this may be an older release.
 */
export function parseRecentSearches(raw: string | null | undefined): SearchResult[] {
  if (!raw) return [];
  try {
    const list = JSON.parse(raw) as unknown;
    if (!Array.isArray(list)) return [];
    const out: SearchResult[] = [];
    for (const r of list as Partial<SearchResult>[]) {
      if (
        typeof r?.name === 'string' &&
        typeof r.position?.lat === 'number' &&
        typeof r.position.lng === 'number'
      ) {
        out.push({
          name: r.name,
          label: typeof r.label === 'string' ? r.label : '',
          position: { lat: r.position.lat, lng: r.position.lng },
          ...(typeof r.address === 'string' ? { address: r.address } : {}),
          ...(typeof r.kind === 'string' ? { kind: r.kind } : {}),
        });
      }
      if (out.length === MAX_RECENT_SEARCHES) break;
    }
    return out;
  } catch {
    return [];
  }
}

/** The persisted form of the list. */
export function serializeRecentSearches(list: readonly SearchResult[]): string {
  return JSON.stringify(list);
}

/**
 * The list with `pick` promoted to the front — deduped and capped. The key is
 * name plus position rounded to ~1 m, so re-picking the same result moves it up
 * instead of stacking, while two cafés of one chain stay separate rows.
 */
export function pushRecentSearch(
  list: readonly SearchResult[],
  pick: SearchResult,
): SearchResult[] {
  const key = (r: SearchResult) =>
    `${r.name}@${r.position.lat.toFixed(5)},${r.position.lng.toFixed(5)}`;
  const pickKey = key(pick);
  return [pick, ...list.filter((r) => key(r) !== pickKey)].slice(0, MAX_RECENT_SEARCHES);
}
