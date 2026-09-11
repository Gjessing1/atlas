/**
 * The commute dashboard's state, derived once for web and Android.
 *
 * `useCommute` owns the saved configuration and the upstream answer;
 * `@atlas/transit`'s `dashboard.ts` owns every label and number. This is the
 * thin layer between them — which mode is being read, which journey is
 * expanded, and the clock that makes a countdown a countdown.
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
  commuteInterchangeHops,
  commuteJourney,
  commuteJourneyList,
  commuteLeaveNow,
  commuteListing,
  commuteModes,
  commuteModeTitle,
  commuteNowLabel,
  commuteOffDayNote,
  commuteOrigins,
  commuteRibbon,
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
  type TransitCommuteResult,
  type TransitWidgetV2Commit,
} from '@atlas/transit';
import { useCallback, useEffect, useMemo, useState } from 'react';

import type { CommuteController } from './useCommute.js';

/**
 * One journey as the board draws it — TRANSIT.md §1 and §7.
 *
 * The ribbon and the break live here rather than in each client because both
 * are derivations, and a derivation done twice is a derivation that disagrees.
 * The break in particular: it is arithmetic on the timetable, so it is computed
 * for *every* listed journey and not only for the tracked one — TRANSIT.md §W3 forbids
 * inferring that someone boarded, not stating that a change no longer holds.
 */
export interface CommuteDashboardRow {
  /**
   * The row's identity on this board — the journey's key, qualified by the list
   * it belongs to.
   *
   * Qualified even though a mode now draws exactly one list: the key is what an
   * expansion is remembered by, and switching Outbound → Return must not open a
   * row in the new list because the old one had a journey with the same key.
   */
  key: string;
  journey: CommuteJourney;
  /** The journey drawn as one proportional bar. */
  parts: CommuteRibbonPart[];
  /** The first change the numbers have broken, or null. */
  broken: CommuteConnectionBreak | null;
  /** This journey's own notices — the corridor-wide ones are hoisted out. */
  disruptions: CommuteDisruption[];
  /** This is the journey being tracked (TRANSIT.md §7). */
  tracked: boolean;
}

/** One directed hop with its rows — the departure board §13's middle mode draws. */
export interface CommuteDashboardBoard {
  segment: CommuteSegment;
  rows: CommuteBoardRow[];
  /** Why there are no rows, or null when there are. */
  note: string | null;
}

/**
 * The journey list a door mode draws, whole — TRANSIT.md §13.
 *
 * Everything a reader needs to judge the direction hangs off it: its headline,
 * its rows, its notices, its emptiness and its own Track. One object rather
 * than a set of fields on the dashboard because the answer it carries is one
 * question's — and the mode that asks a different question (the interchange,
 * which asks a *stop*) has no section at all rather than a hollowed-out one.
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
   * Start tracking one of this list's journeys, or stop (null).
   *
   * On the section rather than on the dashboard because a commitment records
   * the direction the journey belongs to, and the list is what knows it.
   */
  track: (journey: CommuteJourney | null) => void;
}

export interface CommuteDashboard {
  /**
   * Which of the three the board is reading — TRANSIT.md §13. `outbound` and
   * `inbound` are the commute door to door, as journeys; `interchange` is the
   * change itself, as the departure boards leaving it in both directions.
   */
  mode: CommuteMode;
  setMode: (mode: CommuteMode) => void;
  /** The modes this commute offers: three with an interchange, two without. */
  modes: CommuteMode[];
  /** The journey list this mode draws, or null at the interchange (§13). */
  section: CommuteDashboardSection | null;
  /** `"Engelsrud Terrasse → Nationaltheatret"`, or `"From Asker stasjon"`. */
  routeLabel: string;
  /** `"Tuesday 25 August · 08:32"`, ticking. */
  nowLabel: string;
  /** The clock the countdowns and day notes are measured from. */
  nowMs: number;
  /** TRANSIT.md §7 — where the traveller is in the journey they are tracking. */
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
   * Starting is a section's business (it must record which direction the
   * journey belongs to); stopping is the board's, because the tracked card
   * outlives the list its journey came from — a mode switch included — and is
   * the surface the traveller stops it on.
   */
  stopTracking: () => void;
  /**
   * §13 — the two boards leaving the change, or empty in a door mode.
   *
   * Empty rather than hidden by the client: which mode draws boards is a fact
   * about the model, and a client deciding it for itself is how the panel and
   * the sheet come to show different things.
   */
  boards: CommuteDashboardBoard[];
  /** The row whose legs are open, by {@link CommuteDashboardRow.key}, or null. */
  expanded: string | null;
  toggle: (key: string) => void;
  /** A weekday this commute is not saved for, said plainly rather than as "nothing runs". */
  offDayNote: string | null;
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

  const result = commute.result;

  const listing = useMemo(
    () => (commute.query ? commuteListing(commute.query, mode) : null),
    [commute.query, mode],
  );

  /**
   * The hops that leave the change, in whichever mode is being read.
   *
   * Computed outside the mode on purpose: the middle mode *draws* them, and the
   * tracked card reads its "and if I miss it" alternatives off the same rows
   * from inside a door mode (`here` below). Two derivations of the same two
   * hops is how the alternatives and the boards would come to disagree.
   */
  const hops = useMemo(
    () => (commute.query ? commuteInterchangeHops(commute.query, clockDirection) : []),
    [commute.query, clockDirection],
  );

  const hopBoards = useMemo<CommuteDashboardBoard[]>(() => {
    const byId = new Map((result?.segments ?? []).map((entry) => [entry.id, entry.result]));
    return hops.map((segment) => {
      const answer = byId.get(segment.id);
      const rows = answer ? commuteBoardRows(answer, nowMs) : [];
      return {
        segment,
        rows,
        // Three different nothings, and only one of them is the timetable's. A
        // hop the backend dropped (its upstream call failed) has *not* been
        // shown to be empty, and saying "nothing runs" about it would send
        // someone looking for another way home from a service that is running
        // fine.
        note:
          rows.length > 0
            ? null
            : answer
              ? emptyDirectionNote('upstream')
              : 'Could not be checked just now.',
      };
    });
  }, [result, hops, nowMs]);

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
    // not always one on screen: a commitment made from the interchange by a
    // bundle old enough to have offered that (§13 before v0.191.0) names a
    // journey in that hop's own answer, and looking for it in the door-to-door
    // one would release a commitment that is perfectly alive.
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
    // miss it?" cost no upstream call — the hop's board is already here, in
    // every mode, which is why `hopBoards` is not the mode's own `boards`.
    const placed = commuteHere(trackedJourney, nowMs);
    if (!placed) return null;
    const hop =
      placed.connectionRideIndex === null
        ? undefined
        : hopBoards.find(
            (board) =>
              board.segment.direction === commit.direction &&
              board.segment.index === placed.connectionRideIndex,
          );
    return commuteHere(trackedJourney, nowMs, hop?.rows ?? []);
  }, [hopBoards, commit, nowMs, trackedJourney]);

  const stopTracking = useCallback(() => setCommit(null), [setCommit]);

  // ------------------------------------------------------------- section ---

  const section = useMemo<CommuteDashboardSection | null>(
    () =>
      listing
        ? buildSection(listing, {
            result,
            nowMs,
            commitKey,
            emptyReason: commute.emptyReason,
            setCommit,
          })
        : null,
    [listing, result, nowMs, commitKey, commute.emptyReason, setCommit],
  );

  const routeLabel = commute.query ? commuteModeTitle(commute.query, mode) : 'Commute';

  const toggle = useCallback(
    (key: string) => setExpanded((current) => (current === key ? null : key)),
    [],
  );

  return {
    mode,
    setMode: setPinnedMode,
    modes,
    section,
    routeLabel,
    nowLabel: commuteNowLabel(nowMs),
    nowMs,
    here,
    // Only alongside `here`: without a placed traveller there is nothing for a
    // leg list to be *about*, and the journey is already in the list below.
    hereJourney: here ? trackedJourney : null,
    stopTracking,
    boards: mode === 'interchange' ? hopBoards : [],
    expanded,
    toggle,
    offDayNote: commute.query
      ? commuteOffDayNote(commute.query.days, norwayTime(nowMs).weekday)
      : null,
  };
}

/**
 * Everything the journey list needs, from the answer already in hand.
 *
 * A plain function rather than a hook because it is a pure derivation of the
 * result and the clock, and the mode it belongs to may have no list at all —
 * there is no such thing as calling `useMemo` conditionally.
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
   * The answer this list is built from — the direction the backend was asked
   * for, door to door. `undefined` means it was not answered at all, which is a
   * different nothing from an empty one and is reported as such below.
   */
  const source = result?.[listing.direction];

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
      // No origin: a journey listed here is the commute door to door, and
      // `commuteCommitId` defaults to exactly that. A commitment made from the
      // interchange by an older bundle therefore matches no row in this list,
      // which is right — its journey is not in this list.
      tracked: commitKey !== null && commuteCommitId(listing.direction, journey) === commitKey,
    };
  };

  // Told apart by the backend, per direction: "the last bus has gone" and "your
  // own line filter removed every option" are different sentences, and only the
  // second one has a way out to offer.
  const emptyFromFilter = emptyReason(listing.direction) === 'filtered';

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
      // survives the delay that is usually the reason anyone is looking. No
      // `origin` — the door is the default, and it is the only place a journey
      // is committed to from now that the change draws departures.
      setCommit({
        direction: listing.direction,
        departureMs: journey.startMs,
        line: journey.rides[0]?.line ?? 'walk',
        committedAtMs: Date.now(),
      } satisfies TransitWidgetV2Commit);
    },
  };
}
