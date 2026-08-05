/**
 * Local-first text search, shared by the main search box and stop pickers.
 *
 * The platform supplies two seams: a synchronous local matcher (saved places,
 * coordinates) and an asynchronous index search (web proxy, or Android's
 * online-with-pack-fallback search). This hook owns the state transition so a
 * new query can never leave the previous query's rows or status on screen.
 */

import {
  coordinateSearchResult,
  parseCoordinateQuery,
  savedPlaceResults,
  type SearchablePlace,
  type SearchResult,
} from '@atlas/core';
import { useCallback, useEffect, useRef, useState } from 'react';

export type SearchStatus = 'idle' | 'loading' | 'ready' | 'empty' | 'offline' | 'error';

export interface SearchHits<T = SearchResult> {
  results: T[];
  /** True when the answer came from downloaded data rather than the server. */
  offline: boolean;
}

export interface SearchQuery {
  text: string;
  signal: AbortSignal;
}

/** Search the platform index — web proxy / Android packs-with-fallback. */
export type SearchFn = (query: SearchQuery) => Promise<SearchHits>;

export const SEARCH_LOADING = 'Searching…';
export const SEARCH_EMPTY = 'No matches found.';
export const SEARCH_OFFLINE = 'Offline results';
export const SEARCH_OFFLINE_EMPTY = 'No matches in downloaded regions.';
export const SEARCH_ERROR = 'Search is unavailable.';
export const SEARCH_LOCAL_ERROR = 'Saved results · online search unavailable';

export function searchStatusText(status: SearchStatus, resultCount: number): string | null {
  switch (status) {
    case 'loading':
      return SEARCH_LOADING;
    case 'empty':
      return SEARCH_EMPTY;
    case 'offline':
      return resultCount > 0 ? SEARCH_OFFLINE : SEARCH_OFFLINE_EMPTY;
    case 'error':
      return resultCount > 0 ? SEARCH_LOCAL_ERROR : SEARCH_ERROR;
    default:
      return null;
  }
}

interface LocalHits<T> {
  results: T[];
  /** The local answer is definitive (for example, a coordinate query). */
  complete?: boolean;
}

interface LocalFirstSearchOptions<T> {
  initialQuery?: string;
  debounceMs?: number;
  minLength?: number;
  /** Re-run the same text when a meaningful search option changes. */
  requestKey?: unknown;
  local: (text: string) => LocalHits<T>;
  remote: (query: SearchQuery) => Promise<SearchHits<T>>;
  merge: (local: T[], remote: T[]) => T[];
}

interface LocalFirstSearch<T> {
  query: string;
  setQuery: (text: string) => void;
  results: T[];
  status: SearchStatus;
  loading: boolean;
  offline: boolean;
  error: boolean;
  showEmpty: boolean;
  statusText: string | null;
  /** Keep picked text in the input without searching for it again. */
  settle: (text: string) => void;
  reset: () => void;
}

/** Read a changing platform seam without restarting every active debounce. */
function useLatest<T>(value: T): { current: T } {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

/**
 * Generic engine used by ordinary SearchResult rows and route StopHit rows.
 * It intentionally ignores a late answer even when its provider did not
 * honour AbortSignal: the aborted generation can never overwrite a new query.
 */
export function useLocalFirstSearch<T>({
  initialQuery = '',
  debounceMs = 250,
  minLength = 2,
  requestKey,
  local,
  remote,
  merge,
}: LocalFirstSearchOptions<T>): LocalFirstSearch<T> {
  const [query, setQueryState] = useState(initialQuery);
  const [results, setResults] = useState<T[]>([]);
  const [status, setStatus] = useState<SearchStatus>('idle');
  const settledRef = useRef<string | null>(null);
  const localRef = useLatest(local);
  const remoteRef = useLatest(remote);
  const mergeRef = useLatest(merge);

  useEffect(() => {
    const text = query.trim();
    if (settledRef.current === text) {
      settledRef.current = null;
      return;
    }
    settledRef.current = null;
    if (text.length < minLength) {
      setResults([]);
      setStatus('idle');
      return;
    }

    const localHits = localRef.current(text);
    setResults(localHits.results);
    if (localHits.complete) {
      setStatus(localHits.results.length > 0 ? 'ready' : 'empty');
      return;
    }
    setStatus('loading');

    const controller = new AbortController();
    const timer = setTimeout(() => {
      void remoteRef
        .current({ text, signal: controller.signal })
        .then((found) => {
          if (controller.signal.aborted) return;
          const merged = mergeRef.current(localHits.results, found.results);
          setResults(merged);
          setStatus(found.offline ? 'offline' : merged.length > 0 ? 'ready' : 'empty');
        })
        .catch(() => {
          if (controller.signal.aborted) return;
          setResults(localHits.results);
          setStatus('error');
        });
    }, debounceMs);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, debounceMs, minLength, requestKey, localRef, remoteRef, mergeRef]);

  const setQuery = useCallback((text: string) => {
    settledRef.current = null;
    setQueryState(text);
  }, []);
  const settle = useCallback((text: string) => {
    const trimmed = text.trim();
    settledRef.current = trimmed;
    setQueryState(text);
    setResults([]);
    setStatus('idle');
  }, []);
  const reset = useCallback(() => settle(''), [settle]);

  return {
    query,
    setQuery,
    results,
    status,
    loading: status === 'loading',
    offline: status === 'offline',
    error: status === 'error',
    showEmpty: status === 'empty' || (status === 'offline' && results.length === 0),
    statusText: searchStatusText(status, results.length),
    settle,
    reset,
  };
}

const resultKey = (result: SearchResult): string =>
  `${result.name.toLocaleLowerCase()}|${result.position.lat}|${result.position.lng}`;

/** Saved/coordinate hits remain first; exact remote duplicates are discarded. */
export function mergeSearchResults(local: SearchResult[], remote: SearchResult[]): SearchResult[] {
  const seen = new Set(local.map(resultKey));
  return [
    ...local,
    ...remote.filter((result) => {
      const key = resultKey(result);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  ];
}

export type SearchState = LocalFirstSearch<SearchResult>;

/** Main place search: coordinates and saved data now precede every network call. */
export function useSearch({
  search,
  places,
  debounceMs = 250,
}: {
  search: SearchFn;
  places: SearchablePlace[];
  debounceMs?: number;
}): SearchState {
  const placesRef = useLatest(places);
  return useLocalFirstSearch<SearchResult>({
    debounceMs,
    local: (text) => {
      const coordinate = parseCoordinateQuery(text);
      if (coordinate) return { results: [coordinateSearchResult(coordinate)], complete: true };
      return { results: savedPlaceResults(placesRef.current, text) };
    },
    remote: search,
    merge: mergeSearchResults,
  });
}
