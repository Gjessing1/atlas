/**
 * The journey board's controls, derived once for both apps.
 *
 * `useTransitPlan` answers *what the timetable says*; this answers *what the
 * board is currently asking it* — which of the three timings is selected, what
 * a tap on one of them does, whether the mode filter is narrowed, how paging
 * falls back when the planner sent no cursor, and how an empty answer should be
 * worded. Web and Android each had their own copy of all of it, including the
 * one piece of real subtlety: an empty result caused by the traveller's own
 * mode filter must never be reported as "nothing runs", or they go hunting for
 * a departure that exists.
 *
 * Markup stays in the apps — a `<select>` on one side, a row of chips on the
 * other. Only the decisions are here.
 */

import { transitProblemMessage, type TransitMode } from '@atlas/transit';
import { useCallback, useMemo } from 'react';

import type { TransitPlan } from './useTransit.js';

/** What the chosen time means, if one is chosen at all. */
export type TransitTiming = 'now' | 'depart' | 'arrive';

/** The board's derived state: everything both apps compute from a `TransitPlan`. */
export interface TransitBoard {
  timing: TransitTiming;
  /** Pick a timing. "Now" drops the chosen time entirely — it means "whenever now is when the answer arrives". */
  chooseTiming: (choice: TransitTiming) => void;
  /** Move the chosen time by a delta, seeding from now when none is chosen yet. */
  stepTime: (deltaMs: number) => void;
  /** The traveller has narrowed the modes. An empty selection means all of them, so it is not a filter. */
  filtered: boolean;
  /** Whether a ride mode is currently accepted (true for every mode when unfiltered). */
  accepts: (mode: TransitMode) => boolean;
  /**
   * Page to the departures just before / just after the ones shown. Null when
   * there is no such page — the control must then be absent rather than dead,
   * because at the end of the service day there genuinely is no "later".
   */
  showEarlier: (() => void) | null;
  showLater: (() => void) | null;
  /**
   * How to word a real, empty answer, or null when there is no such answer to
   * word (still loading, failed, or trips in hand).
   */
  emptyMessage: string | null;
  /** The empty answer is the mode filter's doing, so offer the way out of it. */
  emptyFromFilter: boolean;
}

export function useTransitBoard(transit: TransitPlan): TransitBoard {
  const { trips, modes, timeMs, arriveBy, setTimeMs, setArriveBy } = transit;
  const timing: TransitTiming = timeMs === null ? 'now' : arriveBy ? 'arrive' : 'depart';
  // An empty mode list means "all of them", so it is not a filter.
  const filtered = modes.length > 0;

  const chooseTiming = useCallback(
    (choice: TransitTiming) => {
      if (choice === 'now') {
        setTimeMs(null);
        setArriveBy(false);
        return;
      }
      setArriveBy(choice === 'arrive');
      // Switching away from "now" has to land on a concrete time, and the only
      // sensible one is the moment the traveller asked.
      if (timeMs === null) setTimeMs(Date.now());
    },
    [timeMs, setTimeMs, setArriveBy],
  );

  const stepTime = useCallback(
    (deltaMs: number) => setTimeMs((timeMs ?? Date.now()) + deltaMs),
    [timeMs, setTimeMs],
  );

  const accepts = useCallback(
    (mode: TransitMode) => !filtered || modes.includes(mode),
    [filtered, modes],
  );

  // Paging uses the planner's own page cursors, which know exactly where the
  // last page ended — the old arithmetic (re-query at "one minute after the
  // first departure shown") both skipped and repeated departures at the seam
  // when several left in the same minute. It survives only as the fallback for
  // when no cursor was sent, which happens at the very ends of the timetable.
  const first = trips?.[0];
  const last = trips && trips.length > 0 ? trips[trips.length - 1] : undefined;
  const showEarlier = useMemo(() => {
    if (transit.pageEarlier) return transit.pageEarlier;
    if (!first) return null;
    return () => {
      setArriveBy(true);
      setTimeMs(first.startMs - 60_000);
    };
  }, [transit.pageEarlier, first, setArriveBy, setTimeMs]);
  const showLater = useMemo(() => {
    if (transit.pageLater) return transit.pageLater;
    if (!last || !first) return null;
    return () => {
      setArriveBy(false);
      setTimeMs((trips!.length > 1 ? first.startMs : last.startMs) + 60_000);
    };
  }, [transit.pageLater, first, last, trips, setArriveBy, setTimeMs]);

  // Two very different empty answers: nothing runs, versus nothing runs *that
  // you allowed*. Blaming the timetable for the traveller's own filter would
  // send them hunting for a departure that exists.
  const isEmpty = !transit.loading && !transit.error && trips?.length === 0;
  const emptyFromFilter = isEmpty && filtered;
  const emptyMessage = !isEmpty
    ? null
    : emptyFromFilter
      ? 'No journeys with the modes you picked.'
      : // The planner usually says *which* nothing this is — no stops in range,
        // outside the timetable's date range, nothing in this search window.
        // Its reason beats our guess; ours is the fallback.
        (transitProblemMessage(transit.problems) ??
        'No departures found for this time. Try a different time or a nearer stop.');

  return {
    timing,
    chooseTiming,
    stepTime,
    filtered,
    accepts,
    showEarlier,
    showLater,
    emptyMessage,
    emptyFromFilter,
  };
}
