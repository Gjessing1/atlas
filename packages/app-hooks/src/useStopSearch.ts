/**
 * The route planner's stop search, shared by web and Android.
 *
 * Both apps need the same rules — debounce, saved places matched locally and
 * shown first, geocoder results merged in — and differ only in markup and in
 * how a query reaches a geocoder. So the rules live here and the geocoder is a
 * seam. Browsing for a stop *on the route* is a different question and lives in
 * {@link useRouteStops}: it is category-first, because a geocoder ranking names
 * has no idea what a route is.
 */

import {
  coordinateSearchResult,
  matchPlacesByName,
  parseCoordinateQuery,
  type SearchResult,
  type StopHit,
} from '@atlas/core';
import { useRef } from 'react';

import { useLocalFirstSearch, type SearchHits } from './useSearch.js';

/** Geocode a stop query — the platform seam (web proxy / packs-with-fallback). */
export type StopGeocodeFn = (query: StopGeocodeQuery) => Promise<SearchHits>;

export interface StopGeocodeQuery {
  /** Trimmed query text, always at least two characters. */
  text: string;
  /** Photon-formatted route bounds, when the search is corridor-constrained. */
  bbox?: string;
  limit?: number;
  /** Ask the platform seam to rank Entur stops before the general geocoder. */
  transit?: boolean;
  /** Aborted when the query is superseded; implementations should honour it. */
  signal: AbortSignal;
}

/** The minimum a saved place needs to be offered as a stop. */
export interface StopSearchPlace {
  name: string;
  lat: number;
  lng: number;
}

/**
 * Read a value in an effect without re-running it when the value's *identity*
 * changes. Callers pass `places` as a plain array, which is a fresh one on
 * every render of an app that re-renders often; re-running the search for that
 * would restart the debounce forever and never geocode anything. The contents
 * are read when a search actually runs, which is when they matter.
 */
function useLatest<T>(value: T): { current: T } {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

const savedHits = (places: StopSearchPlace[], query: string, limit: number): StopHit[] =>
  matchPlacesByName(places, query, limit).map((p) => ({
    name: p.name,
    label: 'Saved place',
    position: { lat: p.lat, lng: p.lng },
    saved: true,
  }));

const remoteHits = (results: SearchResult[]): StopHit[] =>
  results.map((r) => ({
    name: r.name,
    label: r.label,
    position: r.position,
    saved: false,
    ...(r.transitStopId ? { transitStopId: r.transitStopId } : {}),
  }));

export interface StopSearch {
  query: string;
  setQuery: (text: string) => void;
  hits: StopHit[];
  status: 'idle' | 'loading' | 'ready' | 'empty' | 'offline' | 'error';
  loading: boolean;
  offline: boolean;
  error: boolean;
  showEmpty: boolean;
  statusText: string | null;
  /** Clear query and results — after picking a hit, or on cancel. */
  reset: () => void;
}

/**
 * Search for a stop to add: saved places first, then geocoder results. Saved
 * places are matched locally, so a favourite still resolves with no network.
 */
export function useStopSearch({
  geocode,
  places,
  initialQuery = '',
  debounceMs = 250,
  limit = 6,
  savedLimit = 4,
  transit = false,
}: {
  geocode: StopGeocodeFn;
  places: StopSearchPlace[];
  /** Pre-filled text when this box is editing an existing stop. */
  initialQuery?: string;
  debounceMs?: number;
  /** Rows shown in total. */
  limit?: number;
  /** Of those, at most this many saved places. */
  savedLimit?: number;
  /** Use Entur stop-aware autocomplete ahead of general address results. */
  transit?: boolean;
}): StopSearch {
  const placesRef = useLatest(places);
  const geocodeRef = useLatest(geocode);
  const state = useLocalFirstSearch<StopHit>({
    initialQuery,
    debounceMs,
    requestKey: transit,
    local: (text) => {
      const coordinate = parseCoordinateQuery(text);
      if (coordinate) {
        return { results: remoteHits([coordinateSearchResult(coordinate)]), complete: true };
      }
      return { results: savedHits(placesRef.current, text, savedLimit) };
    },
    remote: async ({ text, signal }) => {
      const found = await geocodeRef.current({ text, signal, transit });
      return { results: remoteHits(found.results), offline: found.offline };
    },
    merge: (local, remote) => [...local, ...remote].slice(0, limit),
  });

  return { ...state, hits: state.results };
}
