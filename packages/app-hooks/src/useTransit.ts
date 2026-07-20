import type { LatLng } from '@atlas/core';
import { RIDE_MODES, TransitError, transitCoverage } from '@atlas/transit';
import type { TransitMode, TransitQuery, TransitResult, TransitTrip } from '@atlas/transit';
import { useCallback, useEffect, useRef, useState } from 'react';

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
