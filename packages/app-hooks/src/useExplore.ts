/**
 * "Explore this area" — the category-first POI browse, shared by web and
 * Android.
 *
 * The two panels were a near line-for-line duplicate: same categories, same
 * statuses, same copy, differing only in markup and in how a query reaches the
 * index (web fetches `/api/explore`; Android tries the same and falls back to
 * the downloaded packs). So the state machine and the *copy* live here — the
 * copy especially, because two hand-maintained copies of "Looking nearby…" is
 * exactly how one client ends up saying something the other does not.
 *
 * Browsing for a stop *on a planned route* is a different question and lives in
 * {@link useRouteStops}; this one only ever asks about the current map view.
 */

import type { ExploreCategoryId, LatLng, SearchResult } from '@atlas/core';
import { useCallback, useEffect, useRef, useState } from 'react';

/** The map view a browse asks about. */
export interface ExploreArea {
  center: LatLng;
  /** Half-diagonal of the visible map, clamped — see `clampExploreRadiusM`. */
  radiusM: number;
}

export interface ExploreQuery {
  category: ExploreCategoryId;
  center: LatLng;
  radiusM: number;
  /** Aborted when the query is superseded; implementations should honour it. */
  signal: AbortSignal;
}

export interface ExploreHits {
  results: SearchResult[];
  /** True when the answer came from downloaded data rather than the server. */
  offline: boolean;
}

/** Find nearby places — the platform seam (web proxy / packs-with-fallback). */
export type ExploreFetchFn = (query: ExploreQuery) => Promise<ExploreHits>;

/** Copy, in one place, so the two clients say the same thing. */
export const EXPLORE_TITLE = 'Explore this area';
export const EXPLORE_SUBTITLE = 'Top places in the current map view';
export const EXPLORE_SUBTITLE_OFFLINE = 'From downloaded regions';
export const EXPLORE_LOADING = 'Looking nearby…';
export const EXPLORE_ERROR = 'Explore is unavailable.';
export const EXPLORE_EMPTY = 'No places in this category are indexed here.';
export const EXPLORE_REFRESH = 'Refresh map view';

export interface ExploreState {
  category: ExploreCategoryId;
  setCategory: (category: ExploreCategoryId) => void;
  results: SearchResult[];
  loading: boolean;
  error: boolean;
  offline: boolean;
  /** Sub-heading: names the source, so offline answers are never mistaken. */
  subtitle: string;
  /** The one status line: looking / unavailable / how many. */
  status: string;
  /** Whether to show {@link EXPLORE_EMPTY} — settled, empty, and not an error. */
  showEmpty: boolean;
  /** Re-run against wherever the map is now. */
  refresh: () => void;
}

export function useExplore({
  getArea,
  fetchNearby,
  active = true,
  initialCategory = 'food',
}: {
  /** The current map view; null while the map has not reported one yet. */
  getArea: () => ExploreArea | null | Promise<ExploreArea | null>;
  fetchNearby: ExploreFetchFn;
  /** False while the panel is mounted but closed (Android keeps its sheet). */
  active?: boolean;
  initialCategory?: ExploreCategoryId;
}): ExploreState {
  const [category, setCategory] = useState<ExploreCategoryId>(initialCategory);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [offline, setOffline] = useState(false);
  const [generation, setGeneration] = useState(0);
  // Read when a browse runs, not depended on: both are rebuilt every render by
  // callers that close over the live map, and depending on them would refetch
  // on every camera frame. The map view is read *at fetch time*, which is
  // exactly what "Refresh map view" means.
  const getAreaRef = useRef(getArea);
  getAreaRef.current = getArea;
  const fetchRef = useRef(fetchNearby);
  fetchRef.current = fetchNearby;

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    setLoading(true);
    setError(false);
    void (async () => {
      try {
        const area = await getAreaRef.current();
        if (controller.signal.aborted) return;
        // No view yet — the map is still coming up. Stay in the looking state
        // rather than claim "0 places": nothing has been asked.
        if (!area) return;
        const hits = await fetchRef.current({
          category,
          center: area.center,
          radiusM: area.radiusM,
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setResults(hits.results);
        setOffline(hits.offline);
        setLoading(false);
      } catch {
        if (controller.signal.aborted) return;
        setResults([]);
        setError(true);
        setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [active, category, generation]);

  const refresh = useCallback(() => setGeneration((value) => value + 1), []);

  return {
    category,
    setCategory,
    results,
    loading,
    error,
    offline,
    subtitle: offline ? EXPLORE_SUBTITLE_OFFLINE : EXPLORE_SUBTITLE,
    status: loading ? EXPLORE_LOADING : error ? EXPLORE_ERROR : `${results.length} places`,
    showEmpty: !loading && !error && results.length === 0,
    refresh,
  };
}
