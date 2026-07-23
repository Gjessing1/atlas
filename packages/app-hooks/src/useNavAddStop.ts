/**
 * The mid-navigation "add a stop" quick search, shared by web and Android.
 *
 * A driver low on fuel does not type — they want the nearest gas station that
 * is actually *ahead on this route*, as one tap. So this is category-first
 * (gas / charging / food), the candidates come from the explore endpoint, and
 * the rules live here: filter to the route corridor, keep only what is still
 * ahead of the car, sort by distance along the route. The platforms differ
 * only in markup and in how the explore request is made (the seam).
 */

import type { ExploreCategoryId, LatLng, SearchResult } from '@atlas/core';
import { cumulativeDistances, snapToRoute } from '@atlas/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { NavController } from './useNavigationController.js';

/** The categories a driving stop is actually made for, in display order. */
export const NAV_STOP_CATEGORIES: readonly { id: ExploreCategoryId; label: string }[] = [
  { id: 'fuel', label: 'Gas' },
  { id: 'charging', label: 'Charging' },
  { id: 'food', label: 'Food' },
];

/** A candidate stop: a nearby POI projected onto the remaining route. */
export interface NavStopHit {
  name: string;
  /** Disambiguation line from the geocoder (street, town), often empty. */
  label: string;
  position: LatLng;
  /** Along-route distance (m) from the car to the candidate's turn-off. */
  aheadM: number;
  /** How far off the route line the place itself sits (m). */
  offRouteM: number;
}

/** Fetch category POIs around a point — the platform seam over /api/explore. */
export type FetchNearbyFn = (
  category: ExploreCategoryId,
  center: LatLng,
  radiusM: number,
  signal: AbortSignal,
) => Promise<SearchResult[]>;

export interface NavAddStop {
  /** Whether the quick-stop panel is showing. */
  open: boolean;
  setOpen: (open: boolean) => void;
  category: ExploreCategoryId;
  setCategory: (category: ExploreCategoryId) => void;
  hits: NavStopHit[];
  status: 'idle' | 'loading' | 'ready' | 'error';
  /** Add this hit to the trip and close the panel. */
  pick: (hit: NavStopHit) => void;
}

/** Candidates further off the line than this are not a "stop on the way". */
const STOP_CORRIDOR_M = 3_000;
/** Ignore candidates already at (or behind) the car — no U-turns for coffee. */
const MIN_AHEAD_M = 150;
/** How far around the car to ask for candidates. */
const SEARCH_RADIUS_M = 30_000;
const LIMIT = 6;

function useLatest<T>(value: T): { current: T } {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

export function useNavAddStop({
  nav,
  fetchNearby,
}: {
  nav: NavController;
  fetchNearby: FetchNearbyFn;
}): NavAddStop {
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<ExploreCategoryId>('fuel');
  const [hits, setHits] = useState<NavStopHit[]>([]);
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');

  // The route identity only changes on reroute; the 1 Hz nav state must not
  // re-run the search, so the car's position is read when a search starts.
  const points = nav.activePath?.points;
  const stateRef = useLatest(nav.state);
  const fetchRef = useLatest(fetchNearby);

  const guiding = nav.phase === 'navigating' || nav.phase === 'rerouting';

  // Leaving guidance takes the panel with it.
  useEffect(() => {
    if (!guiding) setOpen(false);
  }, [guiding]);

  useEffect(() => {
    if (!open || !points || points.length < 2) {
      setHits([]);
      setStatus('idle');
      return;
    }
    const state = stateRef.current;
    const center = state?.snapped ?? { lat: points[0]!.lat, lng: points[0]!.lng };
    const traveledM = state?.traveledM ?? 0;
    const controller = new AbortController();
    setStatus('loading');
    setHits([]);
    void (async () => {
      try {
        const results = await fetchRef.current(
          category,
          center,
          SEARCH_RADIUS_M,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        const cum = cumulativeDistances(points);
        const candidates: NavStopHit[] = [];
        for (const result of results) {
          const snap = snapToRoute(result.position, points, cum);
          if (snap.crossTrackM > STOP_CORRIDOR_M) continue;
          const aheadM = snap.alongM - traveledM;
          if (aheadM < MIN_AHEAD_M) continue;
          candidates.push({
            name: result.name,
            label: result.label,
            position: result.position,
            aheadM,
            offRouteM: snap.crossTrackM,
          });
        }
        candidates.sort((a, b) => a.aheadM - b.aheadM);
        setHits(candidates.slice(0, LIMIT));
        setStatus('ready');
      } catch {
        if (controller.signal.aborted) return;
        setHits([]);
        setStatus('error');
      }
    })();
    return () => controller.abort();
  }, [open, category, points, stateRef, fetchRef]);

  const { addStop } = nav;
  const pick = useCallback(
    (hit: NavStopHit) => {
      addStop(hit.position);
      setOpen(false);
    },
    [addStop],
  );

  return { open, setOpen, category, setCategory, hits, status, pick };
}
