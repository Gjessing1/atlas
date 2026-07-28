/**
 * Browse stops *on a planned route*, by category — the planner's twin of the
 * mid-drive {@link useNavAddStop}, shared by web and Android.
 *
 * It replaces a free-text "search along route": typing "cafe" into a geocoder
 * and keeping whatever landed inside the corridor produced matches nobody
 * asked for (a street called Kaffegata, a village two counties along), because
 * a geocoder ranks by name similarity and has no idea what a route is. What a
 * trip planner actually wants is the same question the driver asks mid-drive:
 * *what fuel / food / sights are on this route, and how far off is it?* So this
 * is category-first over the explore endpoint, and every candidate is measured
 * against the route rather than against the query string.
 *
 * The differences from the mid-drive hook are what justify a second one:
 *
 * - There is no vehicle, so nothing is "ahead": distances are measured from the
 *   *start* of the route, and the whole route is offered.
 * - The whole route has to be covered, and explore is a radius search around a
 *   point, so several samples are spread along the line (see SAMPLE_SPACING_M).
 * - A picked stop is inserted into the *plan*, so each hit carries the leg it
 *   belongs to (`insertIndex`) instead of being appended.
 */

import type { ExploreCategoryId, LatLng, SearchResult } from '@atlas/core';
import { cumulativeDistances, pointAtDistance, snapToRoute } from '@atlas/navigation';
import { viaInsertIndex, type RoutePath } from '@atlas/routing';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { FetchNearbyFn } from './useNavAddStop.js';

/**
 * The categories worth browsing for on a trip, per travel mode. Fuel and
 * charging are the whole point of a driving stop and meaningless on foot; the
 * walking modes get the outdoors instead. Order is display order.
 */
export function routeStopCategories(
  profile: string,
): readonly { id: ExploreCategoryId; label: string }[] {
  const driving = profile === 'car';
  return driving
    ? [
        { id: 'fuel', label: 'Gas' },
        { id: 'charging', label: 'Charging' },
        { id: 'supermarket', label: 'Groceries' },
        { id: 'rest-area', label: 'Rest area' },
        { id: 'food', label: 'Food' },
        { id: 'coffee', label: 'Coffee' },
        { id: 'essentials', label: 'Essentials' },
        { id: 'sights', label: 'Sights' },
      ]
    : [
        { id: 'food', label: 'Food' },
        { id: 'coffee', label: 'Coffee' },
        { id: 'shops', label: 'Shops' },
        { id: 'essentials', label: 'Essentials' },
        { id: 'sights', label: 'Sights' },
        { id: 'nature', label: 'Nature' },
      ];
}

/** A candidate stop: a category POI measured against the planned route. */
export interface RouteStopHit {
  name: string;
  /** Disambiguation line from the geocoder (street, town), often empty. */
  label: string;
  position: LatLng;
  /** Distance along the route (m) from the start to the candidate's turn-off. */
  alongM: number;
  /** How far off the route line the place itself sits (m). */
  offRouteM: number;
  /** Insert before this stop to keep the plan's visiting order. */
  insertIndex: number;
}

export interface RouteStops {
  category: ExploreCategoryId;
  setCategory: (category: ExploreCategoryId) => void;
  hits: RouteStopHit[];
  status: 'idle' | 'loading' | 'ready' | 'error';
}

/** A place further off the line than this is not "on the way". */
const CORRIDOR_M = 3_000;
/**
 * Explore answers a radius around one point, so a route is covered by a series
 * of them. 12 km apart with a ≥8 km radius keeps the overlap wide enough that
 * nothing inside the corridor falls between two samples.
 */
const SAMPLE_SPACING_M = 12_000;
const MIN_SAMPLE_RADIUS_M = 8_000;
/** The backend's own ceiling for one explore request. */
const MAX_SAMPLE_RADIUS_M = 50_000;
/**
 * Requests one browse is allowed to make. A route long enough to need more than
 * this is sampled with wider (eventually capped) radii instead, so a very long
 * route can miss candidates *between* samples — the list stays honest about
 * what it found and in what order, which is what it is for.
 */
const MAX_SAMPLES = 8;
const LIMIT = 10;

function useLatest<T>(value: T): { current: T } {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

/**
 * Spread the shown stops along the trip instead of listing whatever is densest.
 *
 * A city has dozens of petrol stations in its first few kilometres, so plain
 * "nearest first" filled the whole list with the suburb the driver is leaving
 * and offered nothing for the 120 km after it. The route is split into as many
 * stretches as there are rows, each stretch contributes the stop *least* off the
 * line (the one actually worth pulling over for), and only then are leftover
 * rows filled with the next most convenient candidates anywhere.
 */
export function spreadAlongRoute(
  candidates: readonly RouteStopHit[],
  totalM: number,
  limit = LIMIT,
): RouteStopHit[] {
  const byAlong = (a: RouteStopHit, b: RouteStopHit) => a.alongM - b.alongM;
  if (candidates.length <= limit) return [...candidates].sort(byAlong);
  const width = totalM > 0 ? totalM / limit : 1;
  const perStretch = new Map<number, RouteStopHit>();
  const leftovers: RouteStopHit[] = [];
  // Most convenient first, so a stretch keeps its closest-to-the-line stop.
  for (const candidate of [...candidates].sort(
    (a, b) => a.offRouteM - b.offRouteM || a.alongM - b.alongM,
  )) {
    const stretch = Math.min(limit - 1, Math.floor(candidate.alongM / width));
    if (perStretch.has(stretch)) leftovers.push(candidate);
    else perStretch.set(stretch, candidate);
  }
  const chosen = [...perStretch.values()];
  for (const candidate of leftovers) {
    if (chosen.length >= limit) break;
    chosen.push(candidate);
  }
  return chosen.sort(byAlong);
}

/** Where to ask, and how wide, to cover this route in at most MAX_SAMPLES calls. */
export function routeSampleCircles(
  points: LatLng[],
  cum: number[],
): { center: LatLng; radiusM: number }[] {
  const totalM = cum[cum.length - 1] ?? 0;
  if (points.length === 0) return [];
  const count = Math.max(1, Math.min(MAX_SAMPLES, Math.ceil(totalM / SAMPLE_SPACING_M)));
  const spacing = totalM / count;
  return Array.from({ length: count }, (_, i) => ({
    // Sample midpoints, so the first and last circles still reach the ends.
    center: pointAtDistance(points, cum, spacing * (i + 0.5)),
    radiusM: Math.min(
      MAX_SAMPLE_RADIUS_M,
      Math.max(MIN_SAMPLE_RADIUS_M, Math.round(spacing * 0.75)),
    ),
  }));
}

export function useRouteStops({
  path,
  waypoints,
  profile,
  active,
  fetchNearby,
}: {
  /** The selected path — its geometry is what candidates are measured against. */
  path: RoutePath | null;
  /** Stop positions in visiting order, for the insert index. */
  waypoints: LatLng[];
  /** Travel mode, deciding which categories are on offer. */
  profile: string;
  /** False while the browser is collapsed: nothing is fetched. */
  active: boolean;
  fetchNearby: FetchNearbyFn;
}): RouteStops {
  const [category, setCategory] = useState<ExploreCategoryId>('fuel');
  const [hits, setHits] = useState<RouteStopHit[]>([]);
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');

  // A mode switch can leave the selected category off the list (fuel on a
  // walk); fall back to the first one the new mode offers.
  const categories = routeStopCategories(profile);
  const selected = categories.some((item) => item.id === category)
    ? category
    : (categories[0]?.id ?? 'food');

  const points = path?.points;
  const fetchRef = useLatest(fetchNearby);
  const waypointsRef = useLatest(waypoints);

  useEffect(() => {
    if (!active || !points || points.length < 2) {
      setHits([]);
      setStatus('idle');
      return;
    }
    const controller = new AbortController();
    setStatus('loading');
    setHits([]);
    void (async () => {
      try {
        const cum = cumulativeDistances(points);
        const circles = routeSampleCircles(points, cum);
        let failed = 0;
        const answers = await Promise.all(
          circles.map(async ({ center, radiusM }) => {
            try {
              return await fetchRef.current(selected, center, radiusM, controller.signal);
            } catch {
              // One sample failing (a hole in the index, a timeout) must not
              // discard the rest of the route's candidates — but every sample
              // failing means the search is down, not that the road is empty.
              failed++;
              return [] as SearchResult[];
            }
          }),
        );
        if (controller.signal.aborted) return;
        if (failed === circles.length) {
          setHits([]);
          setStatus('error');
          return;
        }
        const results = answers.flat();
        const seen = new Set<string>();
        const candidates: RouteStopHit[] = [];
        for (const result of results) {
          const key = `${result.name.trim().toLocaleLowerCase()}@${result.position.lat.toFixed(4)},${result.position.lng.toFixed(4)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const snap = snapToRoute(result.position, points, cum);
          if (snap.crossTrackM > CORRIDOR_M) continue;
          candidates.push({
            name: result.name,
            label: result.label,
            position: result.position,
            alongM: snap.alongM,
            offRouteM: snap.crossTrackM,
            insertIndex: viaInsertIndex(points, waypointsRef.current, result.position),
          });
        }
        // Route order, not name relevance: this is a list of things you pass.
        setHits(spreadAlongRoute(candidates, cum[cum.length - 1] ?? 0));
        setStatus('ready');
      } catch {
        if (controller.signal.aborted) return;
        setHits([]);
        setStatus('error');
      }
    })();
    return () => controller.abort();
  }, [active, selected, points, fetchRef, waypointsRef]);

  const setCategoryChecked = useCallback((next: ExploreCategoryId) => setCategory(next), []);

  return { category: selected, setCategory: setCategoryChecked, hits, status };
}
