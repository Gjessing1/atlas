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

import { matchPlacesByName, type SearchResult, type StopHit } from '@atlas/core';
import { useCallback, useEffect, useRef, useState } from 'react';

/** Geocode a stop query — the platform seam (web proxy / packs-with-fallback). */
export type StopGeocodeFn = (query: StopGeocodeQuery) => Promise<SearchResult[]>;

export interface StopGeocodeQuery {
  /** Trimmed query text, always at least two characters. */
  text: string;
  /** Photon-formatted route bounds, when the search is corridor-constrained. */
  bbox?: string;
  limit?: number;
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

/** Empty out state without churning its identity — see {@link useLatest}. */
const emptied = <T>(previous: T[]): T[] => (previous.length === 0 ? previous : []);

const savedHits = (places: StopSearchPlace[], query: string, limit: number): StopHit[] =>
  matchPlacesByName(places, query, limit).map((p) => ({
    name: p.name,
    label: 'Saved place',
    position: { lat: p.lat, lng: p.lng },
    saved: true,
  }));

const remoteHits = (results: SearchResult[]): StopHit[] =>
  results.map((r) => ({ name: r.name, label: r.label, position: r.position, saved: false }));

export interface StopSearch {
  query: string;
  setQuery: (text: string) => void;
  hits: StopHit[];
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
}): StopSearch {
  const [query, setQuery] = useState(initialQuery);
  const [hits, setHits] = useState<StopHit[]>([]);
  const placesRef = useLatest(places);
  const geocodeRef = useLatest(geocode);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setHits(emptied);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void (async () => {
        const saved = savedHits(placesRef.current, q, savedLimit);
        let remote: StopHit[] = [];
        try {
          remote = remoteHits(await geocodeRef.current({ text: q, signal: controller.signal }));
        } catch {
          // Aborted or offline — saved places still match.
        }
        if (!controller.signal.aborted) setHits([...saved, ...remote].slice(0, limit));
      })();
    }, debounceMs);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, placesRef, geocodeRef, debounceMs, limit, savedLimit]);

  const reset = useCallback(() => {
    setQuery('');
    setHits(emptied);
  }, []);

  return { query, setQuery, hits, reset };
}
