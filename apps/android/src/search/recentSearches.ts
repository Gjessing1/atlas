import type { SearchResult } from '@atlas/core';

/** Recently picked search results, device-local (`local.` settings never sync). */
export const RECENT_SEARCHES_SETTING = 'local.search.recent';
const MAX_RECENT = 8;

/** Parse the persisted list; empty when absent or malformed. */
export function parseRecentSearches(raw: string | null): SearchResult[] {
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
          ...(typeof r.kind === 'string' ? { kind: r.kind } : {}),
        });
      }
      if (out.length === MAX_RECENT) break;
    }
    return out;
  } catch {
    return [];
  }
}

/** The list with `pick` promoted to the front — deduped and capped. */
export function pushRecentSearch(list: SearchResult[], pick: SearchResult): SearchResult[] {
  const key = (r: SearchResult) =>
    `${r.name}@${r.position.lat.toFixed(5)},${r.position.lng.toFixed(5)}`;
  const pickKey = key(pick);
  return [pick, ...list.filter((r) => key(r) !== pickKey)].slice(0, MAX_RECENT);
}
