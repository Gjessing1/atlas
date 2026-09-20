import {
  mergePoiResults,
  poiPairKey,
  poiQueryCategories,
  poiTileKey,
  poiViewportIsQueryable,
  poiViewportTiles,
  type LngLatBbox,
  type PoiCategoryId,
  type PoiResult,
  type PoiTile,
  type PoiTileResults,
} from '@atlas/core';
import { useCallback, useEffect, useRef, useState } from 'react';

export interface PoiViewport {
  bbox: LngLatBbox;
  zoom: number;
}

/** Ask the backend for these tiles × categories (see `poiTilesUrl`). */
export type PoiViewportFetch = (query: {
  tiles: readonly PoiTile[];
  categories: readonly PoiCategoryId[];
  signal: AbortSignal;
}) => Promise<PoiTileResults[]>;

export interface PoiViewportState {
  results: PoiResult[];
  loading: boolean;
  error: boolean;
  tooWide: boolean;
  /** Increments only when a complete live viewport answer has settled. */
  revision: number;
  refresh: () => void;
}

/** How long this device reuses a (tile, category) answer; the server holds it longer. */
const CACHE_TTL_MS = 60 * 60_000;
const CACHE_MAX_PAIRS = 4000;
/** A fling settles as several viewport changes; only the last one fetches. */
const SETTLE_MS = 250;

interface CachedPair {
  results: PoiResult[];
  expires: number;
}

/**
 * Settled-viewport POIs: one result set feeds the map pins and the web list.
 *
 * The view is covered by fixed tiles, and each (tile, category) answer is kept
 * for an hour, so panning back and forth, or toggling a category off and on,
 * asks for nothing already held. Only the missing pairs are fetched, in one
 * request, once the view has settled — and what is already on the map stays
 * there meanwhile instead of blanking on every pan.
 */
export function usePoiViewport({
  active,
  viewport,
  categories,
  fetchPois,
}: {
  active: boolean;
  viewport: PoiViewport | null;
  categories: readonly PoiCategoryId[];
  fetchPois: PoiViewportFetch;
}): PoiViewportState {
  const [results, setResults] = useState<PoiResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [revision, setRevision] = useState(0);
  const fetchRef = useRef(fetchPois);
  fetchRef.current = fetchPois;
  const cacheRef = useRef(new Map<string, CachedPair>());
  const categoryKey = categories.join(',');
  const bboxKey = viewport?.bbox.map((value) => value.toFixed(5)).join(',') ?? '';
  const zoomKey = viewport ? Math.floor(viewport.zoom) : null;
  const tooWide = viewport !== null && !poiViewportIsQueryable(viewport.bbox, viewport.zoom);

  useEffect(() => {
    if (!active || !viewport || tooWide) {
      setResults([]);
      setLoading(false);
      setError(false);
      return;
    }
    const bbox = viewport.bbox;
    const tiles = poiViewportTiles(bbox, viewport.zoom);
    const wanted = poiQueryCategories(categories);
    const cache = cacheRef.current;
    const held = () => {
      const now = Date.now();
      const groups: PoiResult[][] = [];
      const missingTiles = new Map<string, PoiTile>();
      const missingCategories = new Set<PoiCategoryId>();
      for (const tile of tiles) {
        for (const category of wanted) {
          const key = poiPairKey(poiTileKey(tile), category);
          const entry = cache.get(key);
          if (entry && entry.expires > now) groups.push(entry.results);
          else {
            if (entry) cache.delete(key);
            missingTiles.set(poiTileKey(tile), tile);
            missingCategories.add(category);
          }
        }
      }
      return { groups, missingTiles, missingCategories };
    };

    const { groups, missingTiles, missingCategories } = held();
    if (!missingTiles.size) {
      setResults(mergePoiResults(groups, bbox));
      setRevision((value) => value + 1);
      setLoading(false);
      setError(false);
      return;
    }
    // Until the missing tiles land, keep the pins already shown that are still
    // in view and still in a selected category.
    const selected = new Set(wanted);
    setResults((shown) =>
      mergePoiResults([...groups, shown.filter((result) => selected.has(result.categoryId))], bbox),
    );
    setLoading(true);
    setError(false);
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void fetchRef
        .current({
          tiles: [...missingTiles.values()],
          categories: wanted.filter((category) => missingCategories.has(category)),
          signal: controller.signal,
        })
        .then((answers) => {
          if (controller.signal.aborted) return;
          const expires = Date.now() + CACHE_TTL_MS;
          for (const answer of answers) {
            const key = poiPairKey(answer.tile, answer.category);
            cache.delete(key);
            cache.set(key, { results: answer.results, expires });
          }
          for (const key of cache.keys()) {
            if (cache.size <= CACHE_MAX_PAIRS) break;
            cache.delete(key);
          }
          setResults(mergePoiResults(held().groups, bbox));
          setRevision((value) => value + 1);
          setLoading(false);
        })
        .catch(() => {
          if (controller.signal.aborted) return;
          setLoading(false);
          setError(true);
        });
    }, SETTLE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [active, bboxKey, zoomKey, categoryKey, generation, tooWide]);

  return {
    results,
    loading,
    error,
    tooWide,
    revision,
    refresh: useCallback(() => setGeneration((value) => value + 1), []),
  };
}
