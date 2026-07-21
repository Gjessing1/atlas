import type { LatLng } from '@atlas/core';
import { RIDE_MODES, TransitError, transitCoverage } from '@atlas/transit';
import type { TransitMode, TransitQuery, TransitResult, TransitTrip } from '@atlas/transit';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { RoutePlanner } from './useRoute.js';

/**
 * Executes a journey query — the platform seam, mirroring `RouteFn`. Unlike
 * routing there is no offline variant to swap in: transit is online-only by
 * design (see `@atlas/transit`'s model), so both platforms pass the same
 * server-backed fetch. The seam exists for testing and for the day Entur is
 * joined by a second national planner.
 */
export type TransitFn = (query: TransitQuery, signal: AbortSignal) => Promise<TransitResult>;

/** Journey-planning state: two endpoints and a time in, timed trips out. */
export interface TransitPlanner {
  /** False when the endpoints are outside the planner's country — the mode is then not offered at all. */
  covered: boolean;
  /**
   * Journey options, best first. `null` means "not asked yet / not askable";
   * an empty array is a real answer meaning nothing runs then, and the UI must
   * word those two differently.
   */
  trips: TransitTrip[] | null;
  loading: boolean;
  error: string | null;
  /** Epoch ms to plan around, or null for "now" (the server's now). */
  timeMs: number | null;
  setTimeMs: (ms: number | null) => void;
  /** Interpret `timeMs` as the latest acceptable arrival rather than the departure. */
  arriveBy: boolean;
  setArriveBy: (on: boolean) => void;
  /**
   * Ride modes the traveller accepts. Empty means all of them — the normal
   * state, and the one an empty result must not be blamed on.
   */
  modes: TransitMode[];
  /**
   * Include or exclude one ride mode. Excluding the last remaining mode is
   * refused: a filter that can only return nothing is a trap, not a choice.
   */
  toggleMode: (mode: TransitMode) => void;
  /** Accept every mode again — the way out of an over-filtered empty result. */
  clearModes: () => void;
  /** Re-ask with the same query — the answer decays, so this is a real action, not a retry. */
  refresh: () => void;
}

/**
 * Plan public transport between two points. Held apart from `useRoute` rather
 * than folded into it because the two answer different questions: a route is a
 * geometry that stays true, a journey is a timetable lookup that expires. They
 * share only the endpoints, which the caller passes in.
 */
export function useTransit(
  transit: TransitFn,
  from: LatLng | null,
  to: LatLng | null,
  active: boolean,
): TransitPlanner {
  const [trips, setTrips] = useState<TransitTrip[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [timeMs, setTimeMs] = useState<number | null>(null);
  const [arriveBy, setArriveBy] = useState(false);
  const [modes, setModes] = useState<TransitMode[]>([]);
  const [seed, setSeed] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  // Order-independent identity for the mode set, so re-selecting the same modes
  // in a different order doesn't re-ask.
  const modeKey = [...modes].sort().join(',');

  const covered = from !== null && to !== null && transitCoverage(from, to);
  // Endpoints are objects rebuilt on every render upstream; depend on their
  // values so a re-render doesn't re-ask the planner.
  const fromKey = from ? `${from.lat},${from.lng}` : '';
  const toKey = to ? `${to.lat},${to.lng}` : '';

  useEffect(() => {
    abortRef.current?.abort();
    if (!active || !covered || !from || !to) {
      setTrips(null);
      setError(null);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    const timer = setTimeout(async () => {
      const query: TransitQuery = { from, to };
      if (timeMs !== null) query.dateTimeMs = timeMs;
      if (arriveBy) query.arriveBy = true;
      if (modes.length > 0) query.modes = modes;
      try {
        const result = await transit(query, controller.signal);
        if (controller.signal.aborted) return; // superseded — don't paint it
        setTrips(result.trips);
        setError(null);
        setLoading(false);
      } catch (err) {
        if (controller.signal.aborted) return;
        setTrips(null);
        setLoading(false);
        setError(
          err instanceof TransitError
            ? err.message
            : 'Journey planner unavailable — check your connection.',
        );
      }
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
    // `from`/`to` enter the deps through their value keys above: callers rebuild
    // the objects each render, and re-asking a national planner on every render
    // would be both wrong and rude.
  }, [active, covered, fromKey, toKey, timeMs, arriveBy, modeKey, seed, transit]);

  const refresh = useCallback(() => setSeed((s) => s + 1), []);
  const clearModes = useCallback(() => setModes([]), []);
  const toggleMode = useCallback((mode: TransitMode) => {
    setModes((current) => {
      // An empty selection means "all modes", so the first exclusion has to
      // expand to "everything except this one" — otherwise unticking Train
      // would read as "Train only".
      const selected = current.length > 0 ? current : RIDE_MODES;
      if (!selected.includes(mode)) return [...selected, mode];
      const next = selected.filter((m) => m !== mode);
      return next.length === 0 ? current : next;
    });
  }, []);

  return {
    covered,
    trips,
    loading,
    error,
    timeMs,
    setTimeMs,
    arriveBy,
    setArriveBy,
    modes,
    toggleMode,
    clearModes,
    refresh,
  };
}

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
 *
 * Shared by web and Android — the platforms differ only in the `transit`
 * fetcher they pass (same-origin vs. an absolute server origin), which is not
 * a reason for either to keep its own copy of this glue.
 */
export function useTransitPlan(route: RoutePlanner, transit: TransitFn): TransitPlan {
  const [enabled, setEnabled] = useState(false);
  const [selected, select] = useState<number | null>(0);

  const from = route.waypoints[0]?.pos ?? null;
  const to = route.waypoints.length >= 2 ? route.waypoints[route.waypoints.length - 1]!.pos : null;
  const planner = useTransit(transit, from, to, enabled && route.active);
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
