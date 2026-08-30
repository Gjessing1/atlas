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
  commuteCommitHolds,
  commuteCommitId,
  commuteCommitKey,
  commuteConnectionBreak,
  commuteHere,
  commuteJourney,
  commuteJourneyList,
  commuteLeaveNow,
  commuteNowLabel,
  commuteOffDayNote,
  commuteRibbon,
  commuteSegments,
  commuteSharedDisruptions,
  defaultCommuteDirection,
  emptyDirectionNote,
  norwayTime,
  type CommuteBoardRow,
  type CommuteConnectionBreak,
  type CommuteDisruption,
  type CommuteHere,
  type CommuteJourney,
  type CommuteLeaveNow,
  type CommuteRibbonPart,
  type CommuteSegment,
  type TransitCommuteDirection,
  type TransitWidgetV2Commit,
} from '@atlas/transit';
import { useCallback, useEffect, useMemo, useState } from 'react';

import type { CommuteController } from './useCommute.js';

/** Which half of the dashboard is in front; both live on the same scroll (§9). */
export type CommuteDashboardView = 'overview' | 'departures';

/**
 * One journey as the board draws it — §6.4 §1 and §7.
 *
 * The ribbon and the break live here rather than in each client because both
 * are derivations, and a derivation done twice is a derivation that disagrees.
 * The break in particular: it is arithmetic on the timetable, so it is computed
 * for *every* listed journey and not only for the tracked one — §6.5 §3 forbids
 * inferring that someone boarded, not stating that a change no longer holds.
 */
export interface CommuteDashboardRow {
  journey: CommuteJourney;
  /** The journey drawn as one proportional bar. */
  parts: CommuteRibbonPart[];
  /** The first change the numbers have broken, or null. */
  broken: CommuteConnectionBreak | null;
  /** This journey's own notices — the corridor-wide ones are hoisted out. */
  disruptions: CommuteDisruption[];
  /** This is the journey being tracked (§6.4 §7). */
  tracked: boolean;
}

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
  /** {@link leaveNow}`.next` as a drawable row, or null. */
  leadRow: CommuteDashboardRow | null;
  /** {@link laterJourneys} as drawable rows. */
  rows: CommuteDashboardRow[];
  /**
   * Notices every listed journey carries, said once above them.
   *
   * A corridor-wide disruption is attached by the operator to every service on
   * the corridor, so a board that paints it per row prints one amber paragraph
   * five times and pushes two journeys off the screen with it.
   */
  sharedDisruptions: CommuteDisruption[];
  /** §6.4 §7 — where the traveller is in the journey they are tracking. */
  here: CommuteHere | null;
  /**
   * That journey whole, so the tracked card can show its legs — each one's
   * platform, departure and arrival.
   *
   * Exposed beside {@link here} rather than folded into it because it is not
   * the same fact: `here` is the ladder's answer about *one* vehicle, and once
   * a journey has departed it is the only thing on screen about it. The board's
   * list cannot supply the rest — it is asked "from now", so the journey being
   * ridden has already fallen out of it — which is exactly why tracking used to
   * show less than not tracking.
   */
  hereJourney: CommuteJourney | null;
  /** Start tracking a journey, or stop (null). */
  track: (journey: CommuteJourney | null) => void;
  /** Whether `journey` is the one being tracked. */
  isTracked: (journey: CommuteJourney) => boolean;
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

  // ------------------------------------------------------------ tracking ---

  const commit = commute.commit;
  const setCommit = commute.setCommit;
  const commitKey = commit ? commuteCommitKey(commit) : null;

  /**
   * The journey being tracked, preferring the backend's own re-read of it.
   *
   * The order matters and is not a fallback chain for tidiness: `committed`
   * comes from a call asked *around the commitment's own departure*, so it is
   * the only source that still contains the journey once it has left — which is
   * exactly when this block is worth having. The board's own list answers
   * before it departs, and answers with the same journey.
   */
  const trackedJourney = useMemo<CommuteJourney | null>(() => {
    if (!commit || !commitKey) return null;
    const committed = result?.committed?.trip;
    if (committed) return commuteJourney(committed, nowMs);
    return (
      commuteJourneyList(
        (result?.[commit.direction].trips ?? []).map((trip, index) =>
          commuteJourney(trip, nowMs, index),
        ),
      ).find((journey) => commuteCommitId(commit.direction, journey) === commitKey) ?? null
    );
  }, [commit, commitKey, result, nowMs]);

  // A commitment releases itself once the journey it names has finished, rather
  // than waiting to be dismissed: nobody stops tracking a bus they got off, and
  // a board still saying "On board" at lunchtime is the one failure that would
  // teach a reader to stop believing this card.
  useEffect(() => {
    if (!commit) return;
    if (trackedJourney && commuteCommitHolds(trackedJourney, nowMs)) return;
    // Only when the answer is loaded: an unresolved commitment during the
    // moment before the first result arrives is unknown, not finished.
    if (!result) return;
    setCommit(null);
  }, [commit, nowMs, result, setCommit, trackedJourney]);

  const here = useMemo<CommuteHere | null>(() => {
    if (!trackedJourney || !commit) return null;
    // Asked twice on purpose, and cheaply: the first call says which ride the
    // ladder landed on, and only then is it knowable *which* hop's departure
    // board holds the alternatives. Passing them in is what makes "and if I
    // miss it?" cost no upstream call — the per-leg boards are already here.
    const placed = commuteHere(trackedJourney, nowMs);
    if (!placed) return null;
    const hop =
      placed.connectionRideIndex === null
        ? undefined
        : boards.find(
            (board) =>
              board.segment.direction === commit.direction &&
              board.segment.index === placed.connectionRideIndex,
          );
    return commuteHere(trackedJourney, nowMs, hop?.rows ?? []);
  }, [boards, commit, nowMs, trackedJourney]);

  const track = useCallback(
    (journey: CommuteJourney | null) => {
      if (!journey) {
        setCommit(null);
        return;
      }
      // The same three fields `commuteCommitId` reads back, in the same order:
      // a commitment is the *scheduled* departure and the first vehicle, so it
      // survives the delay that is usually the reason anyone is looking.
      setCommit({
        direction,
        departureMs: journey.startMs,
        line: journey.rides[0]?.line ?? 'walk',
        committedAtMs: Date.now(),
      } satisfies TransitWidgetV2Commit);
    },
    [direction, setCommit],
  );

  // Through `commuteCommitId`, never by comparing three fields here: what "the
  // same journey" means is a fact about commitments, and the widget already
  // owns the one definition of it.
  const isTracked = useCallback(
    (journey: CommuteJourney) =>
      commitKey !== null &&
      commit !== null &&
      commuteCommitId(commit.direction, journey) === commitKey,
    [commit, commitKey],
  );

  // ---------------------------------------------------------------- rows ---

  const sharedDisruptions = useMemo(
    () => commuteSharedDisruptions(leaveNow.next ? [leaveNow.next, ...leaveNow.later] : journeys),
    [journeys, leaveNow],
  );

  const toRow = useCallback(
    (journey: CommuteJourney): CommuteDashboardRow => {
      const broken = commuteConnectionBreak(journey, nowMs);
      const hoisted = new Set(sharedDisruptions.map((disruption) => disruption.key));
      return {
        journey,
        parts: commuteRibbon(journey, { brokenIndex: broken?.index ?? null }),
        broken,
        disruptions: journey.disruptions.filter((disruption) => !hoisted.has(disruption.key)),
        tracked: isTracked(journey),
      };
    },
    [isTracked, nowMs, sharedDisruptions],
  );

  const leadRow = useMemo(
    () => (leaveNow.next ? toRow(leaveNow.next) : null),
    [leaveNow.next, toRow],
  );
  const rows = useMemo(() => laterJourneys.map(toRow), [laterJourneys, toRow]);

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
    leadRow,
    rows,
    sharedDisruptions,
    here,
    // Only alongside `here`: without a placed traveller there is nothing for a
    // leg list to be *about*, and the journey is already in the list below.
    hereJourney: here ? trackedJourney : null,
    track,
    isTracked,
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
