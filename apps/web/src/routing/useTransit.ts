import {
  useTransit as useSharedTransit,
  type TransitFn,
  type TransitPlanner,
} from '@atlas/app-hooks';
import { fetchTransitTrips, type TransitTrip } from '@atlas/transit';
import { useEffect, useState } from 'react';
import type { RoutePlanner } from './useRoute.js';

/** Web journey planning goes straight to the same-origin backend proxy. */
const transit: TransitFn = (query, signal) => fetchTransitTrips(query, { signal });

/**
 * The planner plus the bits of state the *panel and the map* must agree on:
 * whether the traveller has chosen transit at all, and which of the offered
 * journeys is the one being looked at. Both surfaces read the same object, so
 * the card highlighted in the list is the journey drawn on the map.
 */
export interface TransitPlan extends TransitPlanner {
  /** Transit can be offered here: endpoints inside coverage, and not a round trip. */
  offered: boolean;
  /** The traveller has chosen transit over the road profiles. */
  enabled: boolean;
  setEnabled: (on: boolean) => void;
  /** Index of the journey being examined, or null when the list is collapsed. */
  selected: number | null;
  select: (index: number | null) => void;
  /** The selected journey — what the map draws. */
  trip: TransitTrip | null;
}

/**
 * Public transport for the current plan. It travels between the *ends* of the
 * plan only: a timetable has no way to honour via points, so intermediate
 * stops are deliberately ignored rather than silently approximated.
 */
export function useTransitPlan(route: RoutePlanner): TransitPlan {
  const [enabled, setEnabled] = useState(false);
  const [selected, select] = useState<number | null>(0);

  const from = route.waypoints[0]?.pos ?? null;
  const to = route.waypoints.length >= 2 ? route.waypoints[route.waypoints.length - 1]!.pos : null;
  const planner = useSharedTransit(transit, from, to, enabled && route.active);
  // Offered only where the national planner can answer, and never for a loop:
  // shown-and-failing is worse than absent (see @atlas/transit's model).
  const offered = planner.covered && !route.roundTrip;

  useEffect(() => {
    if (!offered) setEnabled(false);
  }, [offered]);
  // A fresh set of departures invalidates which card was open; lead with the
  // best option again rather than pointing at whatever now sits at that index.
  useEffect(() => select(0), [planner.trips]);

  const trip = selected !== null ? (planner.trips?.[selected] ?? null) : null;
  return { ...planner, offered, enabled, setEnabled, selected, select, trip };
}
