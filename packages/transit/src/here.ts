/**
 * "You are here" — the committed journey, on the board — TRANSIT.md §7.
 *
 * This is the one rule of the board's specification that neither client
 * answered, and the reason is worth keeping: everything it needs already
 * existed and was wired to the wrong surface. `commuteJourneyProgress`,
 * `COMMUTE_PHASE_LABEL` and `commuteConnectionBreak` shipped with the v2 widget for the
 * *home-screen widget*, whose only consumer is the backend widget route. So the
 * widget knew which leg you were on and the board — the surface a traveller
 * actually opens once they are moving — did not.
 *
 * Two things are composed here that the widget has no room for:
 *
 *  - **The change you are booked on, and the one after it.** A widget row has
 *    space for the next action; a board can afford the fallback beside it,
 *    which is the answer to the only question worth asking while a connection
 *    is in doubt. The alternative is read off the per-leg board the dashboard
 *    already asks for (TRANSIT.md §5) — no extra upstream call.
 *  - **A phrase for the phase.** `COMMUTE_PHASE_LABEL` is a chip ("On board");
 *    the board has room to say what happens next and when, which is the part a
 *    chip cannot carry.
 *
 * What is deliberately *not* here: any inference that the traveller boarded.
 * TRANSIT.md §W3's rule holds on this surface too — the block exists only for a
 * journey the user has explicitly committed to, and the ladder below it reads
 * the operator's record before the clock.
 */

import {
  commuteDurationLabel,
  commuteEstimateLabel,
  commuteRibbon,
  commuteRibbonProgress,
} from './dashboard.js';
import type {
  CommuteBoardRow,
  CommuteJourney,
  CommuteLineBadge,
  CommuteRibbonPart,
  CommuteRide,
} from './dashboard.js';
import type { TransitMode } from './model.js';
import {
  COMMUTE_PHASE_LABEL,
  commuteConnectionBreak,
  commuteJourneyProgress,
  type CommuteConnectionBreak,
  type CommuteJourneyPhase,
  type CommutePhaseSource,
} from './widget-v2.js';

/** One departure offered as the way on from the change ahead. */
export interface CommuteHereConnection {
  key: string;
  /** Scheduled departure, as the timetable prints it. */
  aimed: string;
  mode: TransitMode;
  line: string;
  badge: CommuteLineBadge;
  /** Where this departure is headed, when the call said. */
  towards: string | null;
  /** `"6 min change"`, `"missed by 4 min"`, `"in 18 min"`. */
  note: string;
  /**
   * The connection the committed journey itself names. Exactly one row carries
   * this; the rest are alternatives from the hop's own board.
   */
  booked: boolean;
  /** The numbers have broken this one — only ever true on the booked row. */
  missed: boolean;
}

/** Where the traveller is in the journey they committed to, and what to do next. */
export interface CommuteHere {
  phase: CommuteJourneyPhase;
  /** {@link COMMUTE_PHASE_LABEL} — the chip, never a sentence. */
  phaseLabel: string;
  /**
   * The card's own heading. "You are here" is a claim, and before the first
   * vehicle has left it is not a true one: the traveller is following a journey,
   * not standing in it. Saying so is the difference between a board that
   * reports and one that guesses.
   */
  heading: string;
  /** Whether the operator's record or the clock placed them (TRANSIT.md §W2). */
  source: CommutePhaseSource;
  /** The vehicle this is about: the one being ridden, or the one to board next. */
  ride: CommuteRide;
  /**
   * Which of {@link CommuteJourney.rides} that is — the hop whose own departure
   * board holds the alternatives, so a caller can look them up without
   * re-running the ladder to find out where it landed.
   */
  rideIndex: number;
  /**
   * The ride the next change puts you on, or null past the last one — which is
   * the hop whose own departure board holds the alternatives. Exposed because a
   * caller cannot work it out without re-running the ladder: at an interchange
   * it is `rideIndex`, and everywhere else it is the one after.
   */
  connectionRideIndex: number | null;
  /** `"280 to Asker stasjon"` — the vehicle, named the way a traveller names it. */
  title: string;
  /** `"Arrives Asker stasjon 11:18"` — what happens next, and when. */
  lead: string;
  /**
   * The live line under {@link lead}: `"11:21 est."`, `"On time"`, or
   * `"Timetable"` for a vehicle with no live feed at all.
   *
   * §3 on the one card that lacked it. `lead` quotes a scheduled time — the
   * right primary number — and the tracked card is read while standing at the
   * stop it names, which is precisely where "and is it running to that?" is the
   * next question. It is always present, so a service with no live data says so
   * rather than looking like one nobody has checked.
   */
  leadEstimate: string;
  /** The change ahead and the alternative after it; empty past the last change. */
  connections: CommuteHereConnection[];
  /** The connection the numbers have broken, or null. */
  broken: CommuteConnectionBreak | null;
  /** The journey as a ribbon, with the break marked. */
  parts: CommuteRibbonPart[];
  /** Where "now" sits along that ribbon, 0–100, or null before it starts. */
  progress: number | null;
}

/**
 * Which vehicle the *next change* puts you on, or null when there is none left.
 *
 * At the interchange it is the ride the ladder already points at — you are
 * standing at that change. Riding, or not yet aboard, it is the one after: the
 * change ahead of you is the one out of the vehicle you are on or about to
 * board.
 */
function nextConnectionIndex(
  journey: CommuteJourney,
  phase: CommuteJourneyPhase,
  rideIndex: number,
): number | null {
  if (phase === 'arrived') return null;
  const index = phase === 'interchange' ? rideIndex : rideIndex + 1;
  return journey.rides[index] && journey.connections[index - 1] ? index : null;
}

/** How many ways on from a broken or imminent change are worth listing. */
const MAX_CONNECTIONS = 2;

/**
 * The line under the phase chip: what happens next on this vehicle, and when.
 *
 * Deliberately one clause. The card already carries the ribbon, the vehicle and
 * the connections; a second sentence here is the thing that pushes the
 * connections below the fold on a 360 px sheet.
 */
function leadLine(phase: CommuteJourneyPhase, ride: CommuteRide): string {
  const quay = ride.fromQuay ? ` · ${ride.fromQuay}` : '';
  switch (phase) {
    case 'riding':
      return `Arrives ${ride.to} ${ride.arrival.aimed}`;
    case 'arrived':
      return `Arrived ${ride.to} ${ride.arrival.aimed}`;
    default:
      // upcoming, boarding and interchange are all "get on this one, there".
      return `Leaves ${ride.from} ${ride.departure.aimed}${quay}`;
  }
}

/**
 * The estimate for whichever of the ride's two times {@link leadLine} quoted —
 * the arrival while aboard, the departure everywhere else. Reading it off the
 * same phase is what keeps the two lines about one number.
 */
function leadEstimateLabel(phase: CommuteJourneyPhase, ride: CommuteRide): string {
  const parts = phase === 'riding' || phase === 'arrived' ? ride.arrival : ride.departure;
  return commuteEstimateLabel(parts, ride.state === 'cancelled');
}

/**
 * The ways on from the change ahead: the one the journey names first, then the
 * next departure of the same hop.
 *
 * The booked row is kept even when it has been missed — struck through rather
 * than dropped. A traveller standing at Asker is looking for the train they
 * planned to take, and a board that silently swaps it for another one has
 * answered a question they did not ask.
 */
function connectionsAhead(
  journey: CommuteJourney,
  nextIndex: number | null,
  broken: CommuteConnectionBreak | null,
  alternatives: readonly CommuteBoardRow[],
): CommuteHereConnection[] {
  if (nextIndex === null) return [];
  const next = journey.rides[nextIndex];
  const previous = journey.rides[nextIndex - 1];
  const change = journey.connections[nextIndex - 1];
  if (!next || !previous || !change) return [];
  const missed = broken?.index === nextIndex;
  const rows: CommuteHereConnection[] = [
    {
      key: next.key,
      aimed: next.departure.aimed,
      mode: next.mode,
      line: next.line,
      badge: next.badge,
      towards: next.towards,
      note: missed
        ? `missed by ${commuteDurationLabel(broken?.shortfallMs ?? 0)}`
        : `${change.label} change`,
      booked: true,
      missed,
    },
  ];
  for (const row of alternatives) {
    if (rows.length >= MAX_CONNECTIONS) break;
    // Only departures the traveller could still reach, and never the booked one
    // said twice: the hop's own board contains it.
    if (row.whenMs <= next.startMs) continue;
    rows.push({
      key: row.key,
      aimed: row.aimed,
      mode: row.mode,
      line: row.line,
      badge: row.badge,
      towards: row.towards,
      // Stated as a *change*, like the booked row above it, and on the same
      // scheduled-to-scheduled basis. A board row's own countdown is time from
      // now, which is a different number from the wait on the platform — and
      // two adjacent rows answering two different questions is how a fallback
      // stops being comparable with the thing it is a fallback for.
      note: `${commuteDurationLabel(row.whenMs - previous.endMs)} change`,
      booked: false,
      missed: false,
    });
  }
  return rows;
}

/**
 * The block, or null when there is nothing to say.
 *
 * `alternatives` are the rows of the hop that follows the change — the
 * dashboard's own per-leg board for it. Passing them in rather than asking for
 * them keeps this a pure function of what the board already has, which is what
 * lets it be tested against a fixture instead of a network.
 */
export function commuteHere(
  journey: CommuteJourney,
  nowMs: number,
  alternatives: readonly CommuteBoardRow[] = [],
): CommuteHere | null {
  const progress = commuteJourneyProgress(journey, nowMs);
  const ride = journey.rides[progress.rideIndex];
  if (!ride) return null;
  const broken = commuteConnectionBreak(journey, nowMs);
  const parts = commuteRibbon(journey, { brokenIndex: broken?.index ?? null });
  return {
    phase: progress.phase,
    phaseLabel: COMMUTE_PHASE_LABEL[progress.phase],
    heading: progress.phase === 'upcoming' ? 'Tracking' : 'You are here',
    source: progress.source,
    ride,
    rideIndex: progress.rideIndex,
    connectionRideIndex: nextConnectionIndex(journey, progress.phase, progress.rideIndex),
    title: ride.towards ? `${ride.line} to ${ride.towards}` : `${ride.line} to ${ride.to}`,
    lead: leadLine(progress.phase, ride),
    leadEstimate: leadEstimateLabel(progress.phase, ride),
    // Past the last alighting there is no connection to make, and a card that
    // goes on offering one is describing a journey that ended.
    connections: connectionsAhead(
      journey,
      nextConnectionIndex(journey, progress.phase, progress.rideIndex),
      broken,
      alternatives,
    ),
    broken,
    parts,
    progress: commuteRibbonProgress(parts, nowMs),
  };
}
