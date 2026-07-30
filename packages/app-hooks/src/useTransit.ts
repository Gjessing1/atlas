import { RIDE_MODES, TransitError, transitCoverage, transitCoversPoint } from '@atlas/transit';
import type {
  TransitLocation,
  TransitMode,
  TransitProblem,
  TransitQuery,
  TransitResult,
  TransitTrip,
} from '@atlas/transit';
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
  /**
   * Why the planner returned nothing, when it said. Distinct from `error`:
   * these are answers ("no stops in range"), not failures, and the board should
   * report them without the language of something having gone wrong.
   */
  problems: TransitProblem[];
  /**
   * When the shown answer came back, epoch ms — null while there is none. A
   * timetable is only true at the moment it was fetched, and this is the one
   * offline-first exception in Atlas: nothing here can be recomputed from
   * local data, so the board has to be able to say how old what it shows is.
   */
  updatedMs: number | null;
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
  /**
   * Page to the departures just before / just after the ones shown, using the
   * planner's own cursors. These are null when there is no such page — the
   * controls must then be absent rather than dead, because at the end of the
   * service day there genuinely is no "later".
   */
  pageEarlier: (() => void) | null;
  pageLater: (() => void) | null;
}

/**
 * Plan public transport between two points. Held apart from `useRoute` rather
 * than folded into it because the two answer different questions: a route is a
 * geometry that stays true, a journey is a timetable lookup that expires. They
 * share only the endpoints, which the caller passes in.
 */
export function useTransit(
  transit: TransitFn,
  from: TransitLocation | null,
  to: TransitLocation | null,
  active: boolean,
  via: readonly TransitLocation[] = [],
): TransitPlanner {
  const [trips, setTrips] = useState<TransitTrip[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [problems, setProblems] = useState<TransitProblem[]>([]);
  const [updatedMs, setUpdatedMs] = useState<number | null>(null);
  const [timeMs, setTimeMsState] = useState<number | null>(null);
  const [arriveBy, setArriveByState] = useState(false);
  const [modes, setModes] = useState<TransitMode[]>([]);
  const [seed, setSeed] = useState(0);
  // The page being shown, and the cursors out of it. Held together because any
  // change to the *question* (time, modes, endpoints) makes a cursor from the
  // old question meaningless — it would page through the wrong timetable.
  const [cursor, setCursor] = useState<string | null>(null);
  const [pages, setPages] = useState<{ next?: string; previous?: string }>({});
  const abortRef = useRef<AbortController | null>(null);
  // Order-independent identity for the mode set, so re-selecting the same modes
  // in a different order doesn't re-ask.
  const modeKey = [...modes].sort().join(',');

  const covered = from !== null && to !== null && transitCoverage(from, to);
  // Endpoints are objects rebuilt on every render upstream; depend on their
  // values so a re-render doesn't re-ask the planner.
  const fromKey = from ? `${from.lat},${from.lng},${from.stopId ?? ''}` : '';
  const toKey = to ? `${to.lat},${to.lng},${to.stopId ?? ''}` : '';
  const viaKey = via.map((point) => `${point.lat},${point.lng},${point.stopId ?? ''}`).join(';');

  useEffect(() => {
    abortRef.current?.abort();
    if (!active || !covered || !from || !to) {
      setTrips(null);
      setError(null);
      setProblems([]);
      setPages({});
      setUpdatedMs(null);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    const timer = setTimeout(async () => {
      const query: TransitQuery = { from, to };
      if (via.length > 0) query.via = via;
      if (timeMs !== null) query.dateTimeMs = timeMs;
      if (arriveBy) query.arriveBy = true;
      if (modes.length > 0) query.modes = modes;
      // A cursor supersedes the time window it came from, so the two are never
      // sent together as competing instructions.
      if (cursor !== null) query.pageCursor = cursor;
      try {
        const result = await transit(query, controller.signal);
        if (controller.signal.aborted) return; // superseded — don't paint it
        setTrips(result.trips);
        setProblems(result.problems ?? []);
        setPages({
          ...(result.nextCursor ? { next: result.nextCursor } : {}),
          ...(result.previousCursor ? { previous: result.previousCursor } : {}),
        });
        setError(null);
        setUpdatedMs(Date.now());
        setLoading(false);
      } catch (err) {
        if (controller.signal.aborted) return;
        setTrips(null);
        setProblems([]);
        setPages({});
        // A failed lookup leaves nothing on screen, so there is no age to state.
        setUpdatedMs(null);
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
  }, [active, covered, fromKey, toKey, viaKey, timeMs, arriveBy, modeKey, cursor, seed, transit]);

  // Every control that changes the question also drops the cursor: paging is
  // only ever relative to the answer currently on screen.
  const refresh = useCallback(() => {
    setCursor(null);
    setSeed((s) => s + 1);
  }, []);
  const setTimeMs = useCallback((ms: number | null) => {
    setCursor(null);
    setTimeMsState(ms);
  }, []);
  const setArriveBy = useCallback((on: boolean) => {
    setCursor(null);
    setArriveByState(on);
  }, []);
  const clearModes = useCallback(() => {
    setCursor(null);
    setModes([]);
  }, []);
  const toggleMode = useCallback((mode: TransitMode) => {
    setCursor(null);
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

  const pageEarlier = useCallback(() => {
    if (pages.previous) setCursor(pages.previous);
  }, [pages.previous]);
  const pageLater = useCallback(() => {
    if (pages.next) setCursor(pages.next);
  }, [pages.next]);

  return {
    covered,
    trips,
    loading,
    error,
    problems,
    updatedMs,
    timeMs,
    setTimeMs,
    arriveBy,
    setArriveBy,
    modes,
    toggleMode,
    clearModes,
    refresh,
    pageEarlier: pages.previous ? pageEarlier : null,
    pageLater: pages.next ? pageLater : null,
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
 * Public transport for the current plan. Every intermediate waypoint is an
 * ordered timetable visit, matching the road planner's visible route.
 *
 * Shared by web and Android — the platforms differ only in the `transit`
 * fetcher they pass (same-origin vs. an absolute server origin), which is not
 * a reason for either to keep its own copy of this glue.
 */
export function useTransitPlan(route: RoutePlanner, transit: TransitFn): TransitPlan {
  const [enabled, setEnabled] = useState(false);
  const [selected, select] = useState<number | null>(0);

  const first = route.waypoints[0];
  const last =
    route.waypoints.length >= 2 ? route.waypoints[route.waypoints.length - 1] : undefined;
  const from: TransitLocation | null = first
    ? { ...first.pos, ...(first.transitStopId ? { stopId: first.transitStopId } : {}) }
    : null;
  const to: TransitLocation | null = last
    ? { ...last.pos, ...(last.transitStopId ? { stopId: last.transitStopId } : {}) }
    : null;
  const via: TransitLocation[] = route.waypoints.slice(1, -1).map((waypoint) => ({
    ...waypoint.pos,
    ...(waypoint.transitStopId ? { stopId: waypoint.transitStopId } : {}),
  }));
  // Offer the mode unless we positively *know* it cannot answer. Gating on
  // `covered` instead would hide the chip until both endpoints exist — which
  // is exactly when someone is looking for the travel mode, and reads as the
  // app having no public transport at all. An endpoint outside Norway is a
  // real answer and still hides it (see @atlas/transit's model); a missing
  // endpoint is not. Never offered for a loop: a timetable has no notion of one.
  const outsideCoverage =
    (from !== null && !transitCoversPoint(from)) || (to !== null && !transitCoversPoint(to));
  const offered = !outsideCoverage && !route.roundTrip;
  // Ask the board as soon as the plan has two ends, rather than waiting for
  // transit to be picked: the mode picker compares trip times, and a chip that
  // stays blank until you commit to it is the one mode you cannot compare. The
  // query is the same one the board would send anyway, so selecting transit
  // then paints departures already in hand instead of re-asking. `useTransit`
  // itself declines to fetch without both endpoints and coverage, so this
  // costs nothing on a half-built plan.
  const planner = useTransit(transit, from, to, offered && route.active, via);

  useEffect(() => {
    if (!offered) setEnabled(false);
  }, [offered]);
  // A fresh set of departures invalidates which card was open; lead with the
  // best option again rather than pointing at whatever now sits at that index.
  useEffect(() => select(0), [planner.trips]);

  const trip = selected !== null ? (planner.trips?.[selected] ?? null) : null;
  return { ...planner, offered, enabled, setEnabled, selected, select, trip };
}
