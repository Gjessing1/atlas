import {
  poiViewportIsQueryable,
  type LngLatBbox,
  type PoiCategoryId,
  type PoiResult,
} from '@atlas/core';
import { useCallback, useEffect, useRef, useState } from 'react';

export interface PoiViewport {
  bbox: LngLatBbox;
  zoom: number;
}

export type PoiViewportFetch = (query: {
  bbox: LngLatBbox;
  categories: readonly PoiCategoryId[];
  signal: AbortSignal;
}) => Promise<PoiResult[]>;

export interface PoiViewportState {
  results: PoiResult[];
  loading: boolean;
  error: boolean;
  tooWide: boolean;
  refresh: () => void;
}

/** Settled-viewport POIs: one result set feeds the map pins and the web list. */
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
  const fetchRef = useRef(fetchPois);
  fetchRef.current = fetchPois;
  const categoryKey = categories.join(',');
  const bboxKey = viewport?.bbox.map((value) => value.toFixed(5)).join(',') ?? '';
  const tooWide = viewport !== null && !poiViewportIsQueryable(viewport.bbox, viewport.zoom);

  useEffect(() => {
    if (!active || !viewport || tooWide) {
      setResults([]);
      setLoading(false);
      setError(false);
      return;
    }
    const controller = new AbortController();
    setResults([]);
    setLoading(true);
    setError(false);
    void fetchRef
      .current({ bbox: viewport.bbox, categories, signal: controller.signal })
      .then((next) => {
        if (controller.signal.aborted) return;
        setResults(next);
        setLoading(false);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setResults([]);
        setLoading(false);
        setError(true);
      });
    return () => controller.abort();
  }, [active, bboxKey, categoryKey, generation, tooWide]);

  return {
    results,
    loading,
    error,
    tooWide,
    refresh: useCallback(() => setGeneration((value) => value + 1), []),
  };
}
