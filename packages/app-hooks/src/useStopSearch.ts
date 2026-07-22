/**
 * The route planner's two searches, shared by web and Android.
 *
 * Both apps need the same rules — debounce, saved places matched locally and
 * shown first, geocoder results merged in, corridor filtering and detour
 * ranking for the along-route case — and differ only in markup and in how a
 * query reaches a geocoder. So the rules live here and the geocoder is a seam.
 */

import {
  matchPlacesByName,
  stopHitKey,
  type AlongRouteHit,
  type LatLng,
  type SearchResult,
  type StopHit,
} from '@atlas/core';
import {
  distanceToRouteM,
  photonBbox,
  routeSearchBounds,
  ROUTE_SEARCH_CORRIDOR_M,
  type RoutePath,
} from '@atlas/routing';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { RouteDetourEstimate } from './useRoute.js';

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

export interface AlongRouteSearch {
  query: string;
  setQuery: (text: string) => void;
  hits: AlongRouteHit[];
  loading: boolean;
  reset: () => void;
}

/**
 * Search for a stop *along* the selected route: candidates within the corridor,
 * costed by the detour they add and ranked cheapest first. Saved places are
 * costed immediately rather than waiting for the geocoder, so the list is
 * useful before the network answers — and remains useful if it never does.
 */
export function useAlongRouteSearch({
  geocode,
  places,
  path,
  estimateDetours,
  active,
  debounceMs = 250,
  limit = 6,
}: {
  geocode: StopGeocodeFn;
  places: StopSearchPlace[];
  /** The selected path — its geometry defines the corridor and the bounds. */
  path: RoutePath | null;
  estimateDetours: (
    positions: LatLng[],
    signal: AbortSignal,
  ) => Promise<(RouteDetourEstimate | null)[]>;
  /** False while the search is collapsed: no query runs, results are dropped. */
  active: boolean;
  debounceMs?: number;
  limit?: number;
}): AlongRouteSearch {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<AlongRouteHit[]>([]);
  const [loading, setLoading] = useState(false);
  const points = path?.points;
  const placesRef = useLatest(places);
  const geocodeRef = useLatest(geocode);
  const estimateRef = useLatest(estimateDetours);

  useEffect(() => {
    const q = query.trim();
    if (!active || q.length < 2 || !points) {
      setHits(emptied);
      setLoading(false);
      return;
    }
    const bounds = routeSearchBounds(points);
    if (!bounds) return;
    const controller = new AbortController();
    setHits(emptied);
    setLoading(true);

    const nearRoute = (hit: StopHit): boolean =>
      distanceToRouteM(hit.position, points) <= ROUTE_SEARCH_CORRIDOR_M;

    /** Cost candidates, then merge them into the ranked list already shown. */
    const mergeEstimated = async (candidates: StopHit[]) => {
      if (candidates.length === 0) return;
      const estimates = await estimateRef.current(
        candidates.map((hit) => hit.position),
        controller.signal,
      );
      if (controller.signal.aborted) return;
      const next: AlongRouteHit[] = [];
      for (let i = 0; i < candidates.length; i++) {
        const estimate = estimates[i];
        if (estimate) next.push({ ...candidates[i]!, ...estimate });
      }
      setHits((previous) => {
        const merged = new Map(previous.map((hit) => [stopHitKey(hit), hit]));
        for (const hit of next) merged.set(stopHitKey(hit), hit);
        return [...merged.values()]
          .sort((a, b) => a.extraTimeMs - b.extraTimeMs || a.extraDistanceM - b.extraDistanceM)
          .slice(0, limit);
      });
    };

    // Saved places do not wait for the network: match and cost them now.
    const saved = savedHits(placesRef.current, q, 8).filter(nearRoute).slice(0, 4);
    void mergeEstimated(saved);

    const timer = setTimeout(() => {
      void (async () => {
        try {
          const results = await geocodeRef.current({
            text: q,
            bbox: photonBbox(bounds),
            limit: 20,
            signal: controller.signal,
          });
          const savedKeys = new Set(saved.map(stopHitKey));
          const remote = remoteHits(results)
            .filter((hit) => !savedKeys.has(stopHitKey(hit)))
            .filter(nearRoute)
            .slice(0, Math.max(limit - saved.length, 0));
          await mergeEstimated(remote);
        } catch {
          // Offline or superseded: already-matched saved places remain useful.
        } finally {
          if (!controller.signal.aborted) setLoading(false);
        }
      })();
    }, debounceMs);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [active, query, points, placesRef, geocodeRef, estimateRef, debounceMs, limit]);

  const reset = useCallback(() => {
    setQuery('');
    setHits(emptied);
  }, []);

  return { query, setQuery, hits, loading, reset };
}
