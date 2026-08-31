/**
 * The commute dashboard's state, derived once for web and Android.
 *
 * `useCommute` owns the saved configuration and the upstream answer;
 * `@atlas/transit`'s `dashboard.ts` owns every label and number. This is the
 * thin layer between them — which mode is being read, which journey is
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
  commuteListings,
  commuteModes,
  commuteModeTitle,
  commuteNowLabel,
  commuteOffDayNote,
  commuteOrigins,
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
  type CommuteListing,
  type CommuteMode,
  type CommuteRibbonPart,
  type CommuteSegment,
  type TransitCommuteDirection,
  type TransitCommuteResult,
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
  /**
   * The row's identity on this board — the journey's key, qualified by the list
   * it belongs to.
   *
   * Not `journey.key`: the interchange mode puts two lists on one screen, and a
   * journey key is only unique within the answer it came from. Two vehicles
   * leaving Asker at 16:41 in opposite directions would otherwise share an
   * expansion, and tapping one would open the other.
   */
  key: string;
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

/**
 * One journey list, whole — §6.4 §13.
 *
 * A door mode shows one of these and the interchange shows two, which is the
 * entire reason the board's answer is a list of sections rather than a set of
 * fields. Everything a reader needs to judge *one* direction hangs off the
 * section: its headline, its rows, its notices, its emptiness and its own
 * Track, so two of them can sit on one screen without either quoting the
 * other's departure.
 */
export interface CommuteDashboardSection extends CommuteListing {
  /** Complete journey options for this list, most imminent first. */
  journeys: CommuteJourney[];
  /**
   * The list a "next journeys" run shows: {@link journeys} without the one
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
  /** Wording for an empty list, or null when there is one. */
  emptyNote: string | null;
  /** That emptiness is the commute's own line filter — offer the way out. */
  emptyFromFilter: boolean;
  /**
   * Start tracking one of *this list's* journeys, or stop (null).
   *
   * Per section rather than per board: a commitment records where the journey
   * starts (§13), and the train home from Asker committed to as a door journey
   * would be re-read from Nationaltheatret, not found, and released mid-ride.
   */
  track: (journey: CommuteJourney | null) => void;
}

export interface CommuteDashboard {
  /**
   * Which of the three the board is reading — §6.4 §13. `outbound` and
   * `inbound` are the commute door to door; `interchange` is both directions
   * from the change, listed apart.
   */
  mode: CommuteMode;
  setMode: (mode: CommuteMode) => void;
  /** The modes this commute offers: three with an interchange, two without. */
  modes: CommuteMode[];
  /**
   * The direction the *rest* of the board follows — the per-leg board order and
   * the day note. In a door mode it is the mode; at the interchange it is the
   * one the clock puts first, which is also the order the two lists come in.
   */
  direction: TransitCommuteDirection;
  /** The journey lists this mode shows: one for a door mode, two at the change. */
  sections: CommuteDashboardSection[];
  /** `"Engelsrud Terrasse → Nationaltheatret"`, or `"From Asker stasjon"`. */
  routeLabel: string;
  /** `"Tuesday 25 August · 08:32"`, ticking. */
  nowLabel: string;
  /** The clock the countdowns and day notes are measured from. */
  nowMs: number;
  view: CommuteDashboardView;
  setView: (view: CommuteDashboardView) => void;
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
  /**
   * Release the commitment, whichever list it was made from.
   *
   * Starting is a section's business (it must record where the journey begins);
   * stopping is the board's, because the tracked card outlives the list its
   * journey came from and is the surface the traveller stops it on.
   */
  stopTracking: () => void;
  /** §5 — the per-leg boards, the ones you are standing at first. */
  boards: CommuteDashboardBoard[];
  /** The row whose legs are open, by {@link CommuteDashboardRow.key}, or null. */
  expanded: string | null;
  toggle: (key: string) => void;
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
  const [pinnedMode, setPinnedMode] = useState<CommuteMode | null>(null);
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
  const clockDirection = commute.query ? defaultCommuteDirection(commute.query, nowMs) : 'outbound';

  const modes = useMemo(
    () => (commute.query ? commuteModes(commute.query) : ['outbound' as const, 'inbound' as const]),
    [commute.query],
  );
  // A pinned mode the commute no longer offers is not a mode: dropping the
  // interchange from a saved commute must not leave the board reading a middle
  // ground that has ceased to exist.
  const mode = pinnedMode && modes.includes(pinnedMode) ? pinnedMode : clockDirection;
  // At the interchange the clock still decides which of the two lists is read
  // first, and with it the per-leg board order and the day note.
  const direction = mode === 'interchange' ? clockDirection : mode;

  const result = commute.result;

  const listings = useMemo(
    () => (commute.query ? commuteListings(commute.query, mode, clockDirection) : []),
    [commute.query, mode, clockDirection],
  );

  const segments = useMemo(
    () => (commute.query ? commuteSegments(commute.query) : []),
    [commute.query],
  );

  const boards = useMemo<CommuteDashboardBoard[]>(() => {
    const byId = new Map((result?.segments ?? []).map((entry) => [entry.id, entry.result]));
    const listed = new Set(
      listings.map((listing) => listing.segmentId).filter((id): id is string => id !== null),
    );
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
        // The hops you are standing at come first — the two the mode is already
        // listing journeys for, then the direction being travelled. The rest
        // stay (someone checking the way home at lunchtime needs them) but they
        // are not what a glance mid-commute is for. In a door mode no hop is
        // listed, so this is the direction rule the boards always had.
        .sort((a, b) => {
          const rank = (board: CommuteDashboardBoard) =>
            listed.has(board.segment.id) ? 0 : board.segment.direction === direction ? 1 : 2;
          return rank(a) - rank(b) || a.segment.index - b.segment.index;
        })
    );
  }, [result, segments, listings, nowMs, direction]);

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
    // The fallback searches the list the commitment was *made* from, which is
    // not always one on screen: a journey tracked from the interchange lives in
    // that hop's own board, and looking for it in the door-to-door answer would
    // release a commitment that is perfectly alive.
    const committedOrigin = commute.query
      ? (commuteOrigins(commute.query, commit.direction).find(
          (option) => option.id === (commit.origin ?? 'door'),
        ) ?? null)
      : null;
    const source = committedOrigin?.segmentId
      ? (result?.segments ?? []).find((entry) => entry.id === committedOrigin.segmentId)?.result
      : result?.[commit.direction];
    return (
      commuteJourneyList(
        (source?.trips ?? []).map((trip, index) => commuteJourney(trip, nowMs, index)),
      ).find(
        (journey) =>
          commuteCommitId(commit.direction, journey, commit.origin ?? 'door') === commitKey,
      ) ?? null
    );
  }, [commit, commitKey, commute.query, result, nowMs]);

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

  const stopTracking = useCallback(() => setCommit(null), [setCommit]);

  // ------------------------------------------------------------ sections ---

  const sections = useMemo<CommuteDashboardSection[]>(
    () =>
      listings.map((listing) =>
        buildSection(listing, {
          result,
          nowMs,
          commitKey,
          emptyReason: commute.emptyReason,
          setCommit,
        }),
      ),
    [listings, result, nowMs, commitKey, commute.emptyReason, setCommit],
  );

  const routeLabel = commute.query
    ? commuteModeTitle(commute.query, mode, clockDirection)
    : 'Commute';

  const toggle = useCallback(
    (key: string) => setExpanded((current) => (current === key ? null : key)),
    [],
  );

  return {
    mode,
    setMode: setPinnedMode,
    modes,
    direction,
    sections,
    routeLabel,
    nowLabel: commuteNowLabel(nowMs),
    nowMs,
    view,
    setView,
    here,
    // Only alongside `here`: without a placed traveller there is nothing for a
    // leg list to be *about*, and the journey is already in the list below.
    hereJourney: here ? trackedJourney : null,
    stopTracking,
    boards,
    expanded,
    toggle,
    offDayNote: commute.query
      ? commuteOffDayNote(commute.query.days, norwayTime(nowMs).weekday)
      : null,
    hasBoards: segments.length > 0 && Boolean(result?.segments),
  };
}

/**
 * Everything one journey list needs, from the answer already in hand.
 *
 * A plain function rather than a hook so the interchange can build two of them
 * in one pass: the lists are a *list*, and there is no such thing as calling
 * `useMemo` a variable number of times.
 */
function buildSection(
  listing: CommuteListing,
  ctx: {
    result: TransitCommuteResult | null;
    nowMs: number;
    commitKey: string | null;
    emptyReason: CommuteController['emptyReason'];
    setCommit: CommuteController['setCommit'];
  },
): CommuteDashboardSection {
  const { result, nowMs, commitKey, emptyReason, setCommit } = ctx;

  /**
   * The answer this list is built from.
   *
   * For a door it is the direction the backend was asked for. For the
   * interchange it is the corridor's last hop — a board the dashboard already
   * asked for (§5), which is why the middle mode costs no upstream call.
   * `undefined` means that hop was not answered at all, which is a different
   * nothing from an empty one and is reported as such below.
   */
  const source = listing.segmentId
    ? (result?.segments ?? []).find((entry) => entry.id === listing.segmentId)?.result
    : result?.[listing.direction];

  // `commuteJourneyList` is what turns the planner's *ranked* answer into a
  // timetable: in the order the vehicles leave, one row per departure. Without
  // it the second row can leave before the first, and the same bus appears
  // twice because Entur offered two trains to catch after it.
  const journeys = commuteJourneyList(
    (source?.trips ?? []).map((trip, index) => commuteJourney(trip, nowMs, index)),
  );

  const leaveNow = commuteLeaveNow(journeys, nowMs);
  // Not `journeys.slice(1)`: the headline is the first journey still *catchable*,
  // which is not always the first one the planner returned, and the list has to
  // drop the same departures the headline does.
  const laterJourneys = leaveNow.next ? leaveNow.later : journeys;

  const sharedDisruptions = commuteSharedDisruptions(
    leaveNow.next ? [leaveNow.next, ...leaveNow.later] : journeys,
  );
  const hoisted = new Set(sharedDisruptions.map((disruption) => disruption.key));

  // Through `commuteCommitId`, never by comparing three fields here: what "the
  // same journey" means is a fact about commitments, and the widget already
  // owns the one definition of it.
  const toRow = (journey: CommuteJourney): CommuteDashboardRow => {
    const broken = commuteConnectionBreak(journey, nowMs);
    return {
      key: `${listing.key}:${journey.key}`,
      journey,
      parts: commuteRibbon(journey, { brokenIndex: broken?.index ?? null }),
      broken,
      disruptions: journey.disruptions.filter((disruption) => !hoisted.has(disruption.key)),
      tracked:
        commitKey !== null &&
        commuteCommitId(listing.direction, journey, listing.origin) === commitKey,
    };
  };

  // The direction's own reason only describes the direction's own answer. A
  // list read off a hop has none — the backend reports emptiness per direction
  // — so it says the weaker true thing rather than blaming a filter it cannot
  // know about, and a hop that failed outright is not called empty at all.
  const emptyFromFilter =
    listing.origin === 'door' && emptyReason(listing.direction) === 'filtered';

  return {
    ...listing,
    journeys,
    laterJourneys,
    leaveNow,
    leadRow: leaveNow.next ? toRow(leaveNow.next) : null,
    rows: laterJourneys.map(toRow),
    sharedDisruptions,
    emptyNote:
      !result || journeys.length > 0
        ? null
        : source
          ? `${emptyDirectionNote(emptyFromFilter ? 'filtered' : 'upstream')}.`
          : 'Could not be checked just now.',
    emptyFromFilter,
    track: (journey) => {
      if (!journey) {
        setCommit(null);
        return;
      }
      // The same fields `commuteCommitId` reads back, in the same order: a
      // commitment is the *scheduled* departure and the first vehicle, so it
      // survives the delay that is usually the reason anyone is looking — plus
      // where the journey starts, without which the re-read would ask about a
      // journey from the wrong end of the corridor.
      setCommit({
        direction: listing.direction,
        departureMs: journey.startMs,
        line: journey.rides[0]?.line ?? 'walk',
        committedAtMs: Date.now(),
        ...(listing.origin === 'door' ? {} : { origin: listing.origin }),
      } satisfies TransitWidgetV2Commit);
    },
  };
}
