/**
 * The commute dashboard's state, derived once for web and Android.
 *
 * `useCommute` owns the saved configuration and the upstream answer;
 * `@atlas/transit`'s `dashboard.ts` owns every label and number. This is the
 * thin layer between them — which direction is being read, which journey is
 * expanded, which of the two views is showing, and the clock that makes a
 * countdown a countdown.
 *
 * The clock is the reason this is a hook at all. Everything else here could be
 * a pure function of the result, but "in 6 min" is only true for a minute, and
 * a dashboard whose countdowns freeze the moment it renders is worse than one
 * that never had them: it reads as live and is not.
 */

import {
  commuteBoardRows,
  commuteJourney,
  commuteJourneyList,
  commuteLeaveNow,
  commuteNowLabel,
  commuteOffDayNote,
  commuteSegments,
  defaultCommuteDirection,
  emptyDirectionNote,
  norwayTime,
  type CommuteBoardRow,
  type CommuteJourney,
  type CommuteLeaveNow,
  type CommuteSegment,
  type TransitCommuteDirection,
} from '@atlas/transit';
import { useCallback, useEffect, useMemo, useState } from 'react';

import type { CommuteController } from './useCommute.js';

/** Which half of the dashboard is in front; both live on the same scroll (§9). */
export type CommuteDashboardView = 'overview' | 'departures';

/** One directed hop with its rows — §5's independent departure boards. */
export interface CommuteDashboardBoard {
  segment: CommuteSegment;
  rows: CommuteBoardRow[];
  /** Why there are no rows, or null when there are. */
  note: string | null;
}

export interface CommuteDashboard {
  /** The direction the journey list is about, from the clock until pinned. */
  direction: TransitCommuteDirection;
  setDirection: (direction: TransitCommuteDirection) => void;
  /** `"Engelsrud terrasse → Nationaltheatret"` for the shown direction. */
  routeLabel: string;
  /** `"Tuesday 25 August · 08:32"`, ticking. */
  nowLabel: string;
  /** The clock the countdowns and day notes are measured from. */
  nowMs: number;
  view: CommuteDashboardView;
  setView: (view: CommuteDashboardView) => void;
  /** Complete journey options for `direction`, most imminent first — the whole answer. */
  journeys: CommuteJourney[];
  /**
   * The list a "Next journeys" section shows: {@link journeys} without the one
   * §11 already states in full above it.
   *
   * The two used to be the same list, so the dashboard opened with the 08:36
   * as its headline answer and then began its list with the 08:36 — the same
   * departure, the same times, twice on one screen, and the second copy
   * occupying the slot where the answer to "and if I miss it?" belongs. §11 is
   * the first row now; this is everything after it.
   *
   * Falls back to the whole list when there is no headline at all — an answer
   * old enough that every journey in it has left is still the last thing known,
   * and an empty list would say something stronger and less true.
   */
  laterJourneys: CommuteJourney[];
  /** §11 — what leaving now actually gets you. */
  leaveNow: CommuteLeaveNow;
  /** §5 — the per-leg boards, current direction's hops first. */
  boards: CommuteDashboardBoard[];
  /** The journey whose legs are open, or null. */
  expanded: string | null;
  toggle: (key: string) => void;
  /** Wording for an empty journey list, or null when there is one. */
  emptyNote: string | null;
  /** That emptiness is the commute's own line filter — offer the way out. */
  emptyFromFilter: boolean;
  /** A weekday this commute is not saved for, said plainly rather than as "nothing runs". */
  offDayNote: string | null;
  /**
   * Whether per-leg boards can be offered at all: the corridor needs an
   * interchange to have legs, *and* the server has to be one that answers them.
   * A backend older than §6.4 omits `segments` entirely, and a Departures tab
   * over four boards it cannot fill would report a healthy corridor as dead.
   */
  hasBoards: boolean;
}

/**
 * How often the clock is re-read. Thirty seconds is the coarsest tick that
 * never shows a stale minute: a countdown rounded to whole minutes changes at
 * most once per minute, and sampling at half that guarantees the visible value
 * is never more than one tick behind the truth.
 */
const CLOCK_TICK_MS = 30_000;

export function useCommuteDashboard(commute: CommuteController): CommuteDashboard {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [pinned, setPinned] = useState<TransitCommuteDirection | null>(null);
  const [view, setView] = useState<CommuteDashboardView>('overview');
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  // The way out before the outbound time, the way home after it — what a board
  // opened at 16:30 is being opened for. Pinning overrides it until the panel
  // closes; re-deriving would yank the direction out from under a reader at the
  // moment the clock crosses their departure.
  const direction =
    pinned ?? (commute.query ? defaultCommuteDirection(commute.query, nowMs) : 'outbound');

  const result = commute.result;
  // `commuteJourneyList` is what turns the planner's *ranked* answer into a
  // timetable: in time order, one row per departure. Without it the second row
  // can leave before the first, and the same bus appears twice because Entur
  // offered two trains to catch after it.
  const journeys = useMemo(
    () =>
      commuteJourneyList(
        (result?.[direction].trips ?? []).map((trip, index) => commuteJourney(trip, nowMs, index)),
      ),
    [result, direction, nowMs],
  );

  const leaveNow = useMemo(() => commuteLeaveNow(journeys, nowMs), [journeys, nowMs]);

  // Not `journeys.slice(1)`: the headline is the first journey still *catchable*,
  // which is not always the first one the planner returned, and the list has to
  // drop the same departures the headline does.
  const laterJourneys = leaveNow.next ? leaveNow.later : journeys;

  const segments = useMemo(
    () => (commute.query ? commuteSegments(commute.query) : []),
    [commute.query],
  );

  const boards = useMemo<CommuteDashboardBoard[]>(() => {
    const byId = new Map((result?.segments ?? []).map((entry) => [entry.id, entry.result]));
    return (
      segments
        .map((segment) => {
          const answer = byId.get(segment.id);
          const rows = answer ? commuteBoardRows(answer, nowMs) : [];
          return {
            segment,
            rows,
            // Three different nothings, and only one of them is the timetable's.
            // A hop the backend dropped (its upstream call failed) has *not*
            // been shown to be empty, and saying "nothing runs" about it would
            // send someone looking for another way home from a service that is
            // running fine.
            note:
              rows.length > 0
                ? null
                : answer
                  ? emptyDirectionNote('upstream')
                  : 'Could not be checked just now.',
          };
        })
        // The hops you are travelling *now* come first. The other direction's
        // boards stay — someone checking the way home at lunchtime needs them —
        // but they are not what a glance during the morning commute is for.
        .sort((a, b) => {
          const rank = (board: CommuteDashboardBoard) =>
            board.segment.direction === direction ? 0 : 1;
          return rank(a) - rank(b) || a.segment.index - b.segment.index;
        })
    );
  }, [result, segments, nowMs, direction]);

  const reason = commute.emptyReason(direction);
  const emptyFromFilter = reason === 'filtered';
  const emptyNote =
    !result || journeys.length > 0
      ? null
      : `${emptyDirectionNote(emptyFromFilter ? 'filtered' : 'upstream')}.`;

  const routeLabel = commute.query
    ? direction === 'outbound'
      ? `${commute.query.from.name} → ${commute.query.to.name}`
      : `${commute.query.to.name} → ${commute.query.from.name}`
    : 'Commute';

  const toggle = useCallback(
    (key: string) => setExpanded((current) => (current === key ? null : key)),
    [],
  );

  return {
    direction,
    setDirection: setPinned,
    routeLabel,
    nowLabel: commuteNowLabel(nowMs),
    nowMs,
    view,
    setView,
    journeys,
    laterJourneys,
    leaveNow,
    boards,
    expanded,
    toggle,
    emptyNote,
    emptyFromFilter,
    offDayNote: commute.query
      ? commuteOffDayNote(commute.query.days, norwayTime(nowMs).weekday)
      : null,
    hasBoards: segments.length > 0 && Boolean(result?.segments),
  };
}
