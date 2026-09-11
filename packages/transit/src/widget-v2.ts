/**
 * The **v2** home-screen widget's board — docs/TRANSIT.md §W1–§W7.
 *
 * ---
 * **Which widget is this?** Atlas ships two home-screen commute widgets side by
 * side, and they are different products rather than two versions of one file:
 *
 *  - **v1 — "Atlas commute"** — {@link file://./widget.ts}, painted by
 *    `CommuteWidgetProvider`. One instance answers *one board*: a direction,
 *    both directions, or one hop, chosen in its ⚙ and fixed until changed.
 *  - **v2 — "Atlas commute (live)" (this file)**, painted by
 *    `CommuteWidgetV2Provider`. One instance holds *the whole commute*.
 *
 * v1 stays the fallback and the reference until v2 has been commuted with
 * (TRANSIT.md §W7), so nothing there is bent to suit this file. What helps is reused by
 * importing it — `TransitWidgetRow` and `tripWidgetRow` build the rows,
 * `commuteRefreshAtMs` and `windowOpensAtMs` schedule the asking, and
 * `commuteJourney` is still the one derivation of what a journey costs.
 * ---
 *
 * **What v2 is for.** v1 answers one board well and cannot follow you: an
 * instance is pointed at a direction or a hop and stays there, so the way out
 * and the way home are two pinned widgets, and the one reading
 * "Engelsrud → Asker" at 08:55 is showing the leg you are already sitting on.
 * The unit worth pinning is the *commute*, so a v2 instance carries both
 * directions behind a compact selector and shows the part of it you are in.
 *
 * **How it knows where you are, and what it deliberately does not do.** TRANSIT.md §W2
 * shrinks that question to four tiers, and a lower one may never override a
 * higher one:
 *
 *  1. **A tap** — {@link TransitWidgetV2Commit}. The user picks the journey they
 *     are actually taking. Not a new interaction imposed on them: it is the
 *     decision they already make when they glance at the widget and choose which
 *     bus to run for.
 *  2. **The published record** — `TransitLeg.actualStartMs` / `actualEndMs`.
 *     Whether a departure has *happened* is a fact operators publish, and it was
 *     measured before it was scoped (§W2: the `/trace_attributes` lesson): on
 *     2026-08-27 past calls carried it on 20/20 Ruter buses, 9/9 trams, 11/11
 *     metros and 27/28 Vy trains, and a `trip()` asked with a past `dateTime`
 *     returns the departed journey with both fields set. Its **absence is not
 *     evidence** — a service with no live feed never publishes one — so a
 *     missing record silently falls through to the clock rather than asserting
 *     that the bus is still standing there.
 *  3. **The clock, against the committed journey** — a pure function of `nowMs`
 *     and the leg windows. No sensor, no permission, no battery, and right
 *     whenever the traveller did what the timetable said.
 *  4. **Time of day** — `defaultCommuteDirection`, which is what `auto` already
 *     means on v1, and what AUTO falls back to when nothing above has an answer.
 *
 * Beside the ladder and never load-bearing: a cached coarse fix
 * ({@link TransitWidgetV2Place}) may choose AUTO's *presentation* — which
 * blocks are drawn — and never the journey, the state or the committed leg. The
 * widget must be fully usable with location switched off, which is why it is one
 * optional argument here and not a permission anywhere.
 *
 * Not built, and why: activity recognition cannot tell your bus from the car
 * behind it; a continuous fix costs nav's foreground service and its permanent
 * notification, because a WorkManager refresh has no useful background location;
 * matching against live vehicle positions inherits that cost to answer what a
 * tap answers. The argument for spending taps instead of sensors is that a wrong
 * guess is cheap — think you are on the bus when you are not and the widget
 * shows the train leg, one tap from right.
 */

import type { LatLng } from '@atlas/core';
import { haversineM } from '@atlas/core';

import { norwayClock, norwayInstant, norwayTime } from './clock.js';
import type { CommuteEmptyReason } from './commute.js';
import { commuteLineFilter, commuteTransitQueries, defaultCommuteDirection } from './commute.js';
import {
  commuteCountdown,
  commuteDurationLabel,
  commuteJourney,
  commuteJourneyList,
  commuteOrigins,
  commuteSegments,
  type CommuteJourney,
  type CommuteOriginId,
  type CommuteServiceState,
} from './dashboard.js';
import { transitModeGlyph } from './labels.js';
import { isRideMode } from './model.js';
import type {
  TransitCommuteDirection,
  TransitCommuteQuery,
  TransitLeg,
  TransitQuery,
  TransitResult,
  TransitTrip,
} from './model.js';
import {
  commuteDirectionLabel,
  commuteRefreshAtMs,
  commuteRouteLabel,
  emptyDirectionNote,
  tripWidgetRow,
  widgetCheckedLabel,
  widgetSourceLabel,
  widgetStatusLine,
  windowOpensAtMs,
  type TransitWidgetRow,
} from './widget.js';

// ------------------------------------------------------------ the ladder ---

/**
 * Where in a committed journey the traveller is — TRANSIT.md §W2's ladder, and one of
 * the two axes the widget renders (§W6). The other is the direction; conflating
 * them is what makes a widget need a special case per combination.
 */
export type CommuteJourneyPhase =
  /** The journey has not started and is not imminent. */
  | 'upcoming'
  /** Close enough that the next thing to do is leave, walk or stand there. */
  | 'boarding'
  /** Aboard a vehicle. */
  | 'riding'
  /** Off one vehicle, not yet on the next — the change. */
  | 'interchange'
  /** Past the last alighting. */
  | 'arrived';

/** The short word for a phase — the state chip, never a sentence. */
export const COMMUTE_PHASE_LABEL: Record<CommuteJourneyPhase, string> = {
  upcoming: 'Upcoming',
  boarding: 'Boarding soon',
  riding: 'On board',
  interchange: 'At interchange',
  arrived: 'Arrived',
};

/**
 * How far ahead of a departure the useful answer stops being "when" and becomes
 * "go". Ten minutes is a walk to the stop plus the minute nobody wants to run.
 */
const BOARDING_LEAD_MS = 10 * 60_000;

/**
 * The least time a change can take when the planner walked you no distance at
 * all — stepping across a platform still is not instant, and a connection with
 * literally zero slack is one the numbers should call broken.
 */
const MIN_TRANSFER_MS = 60_000;

/**
 * Which tier of TRANSIT.md §W2 answered. Reported so a wrong answer can be
 * traced to its source.
 */
export type CommutePhaseSource = 'record' | 'clock';

/** Where the traveller is in one journey, and what said so. */
export interface CommuteJourneyProgress {
  phase: CommuteJourneyPhase;
  /**
   * The ride this is about: the vehicle being ridden, the one about to be
   * boarded, or — once arrived — the last one. Indexes {@link CommuteJourney.rides}.
   */
  rideIndex: number;
  /** {@link CommutePhaseSource} — `record` only where an operator actually published one. */
  source: CommutePhaseSource;
}

/** The ride legs of a trip, in the order `commuteJourney` lists its rides. */
function rideLegs(trip: TransitTrip): TransitLeg[] {
  return trip.legs.filter((leg) => isRideMode(leg.mode));
}

/**
 * Has this vehicle left? Tier 2 first, then tier 3.
 *
 * The asymmetry is the whole point: a published `actualStartMs` *proves*
 * departure, while its absence proves nothing — most services publish one and a
 * service with no live feed never will. So absence falls through to the clock
 * rather than asserting the bus is still standing at the stop.
 */
function legDeparted(leg: TransitLeg, nowMs: number): boolean {
  if (leg.actualStartMs !== undefined) return leg.actualStartMs <= nowMs;
  return nowMs >= leg.expectedStartMs;
}

function legArrived(leg: TransitLeg, nowMs: number): boolean {
  if (leg.actualEndMs !== undefined) return leg.actualEndMs <= nowMs;
  return nowMs >= leg.expectedEndMs;
}

/** Whether the record — not the clock — is what decided this leg's state. */
function legOnRecord(leg: TransitLeg): boolean {
  return leg.actualStartMs !== undefined || leg.actualEndMs !== undefined;
}

/**
 * Walk the journey's vehicles and say where the traveller is.
 *
 * Read off the *legs* rather than off `CommuteRide`, because the ladder needs
 * epoch milliseconds and the published record, and a ride carries formatted
 * clock parts. The two lists are the same legs in the same order.
 */
export function commuteJourneyProgress(
  journey: CommuteJourney,
  nowMs: number,
): CommuteJourneyProgress {
  const legs = rideLegs(journey.trip);
  if (legs.length === 0) {
    // An all-walk journey has no vehicle to be aboard. It still has a window,
    // so the clock alone places the traveller in it.
    const trip = journey.trip;
    const phase: CommuteJourneyPhase =
      nowMs >= trip.endMs
        ? 'arrived'
        : nowMs >= trip.startMs
          ? 'riding'
          : trip.startMs - nowMs <= BOARDING_LEAD_MS
            ? 'boarding'
            : 'upcoming';
    return { phase, rideIndex: 0, source: 'clock' };
  }

  // The last vehicle that has left is the one the traveller is on or has just
  // got off; everything after it is still ahead.
  let boarded = -1;
  for (let index = 0; index < legs.length; index += 1) {
    if (legDeparted(legs[index]!, nowMs)) boarded = index;
  }

  if (boarded < 0) {
    const first = legs[0]!;
    const phase: CommuteJourneyPhase =
      first.expectedStartMs - nowMs <= BOARDING_LEAD_MS ? 'boarding' : 'upcoming';
    return { phase, rideIndex: 0, source: legOnRecord(first) ? 'record' : 'clock' };
  }

  const current = legs[boarded]!;
  const source: CommutePhaseSource = legOnRecord(current) ? 'record' : 'clock';
  if (!legArrived(current, nowMs)) return { phase: 'riding', rideIndex: boarded, source };
  if (boarded === legs.length - 1) return { phase: 'arrived', rideIndex: boarded, source };
  // Off one vehicle and the next has not left: standing at the change, which is
  // the moment a commuter most wants their home screen to say something useful.
  return { phase: 'interchange', rideIndex: boarded + 1, source };
}

// ------------------------------------------------------------ the break ----

/**
 * A connection the numbers say no longer holds — TRANSIT.md §W4.
 *
 * Computed, never sensed: leg *n*'s expected arrival plus the change's own
 * transfer time is later than leg *n+1*'s expected departure. Both values are
 * already on the journey, so this is arithmetic on data the board already has.
 */
export interface CommuteConnectionBreak {
  /** The connection that broke: between `rides[index - 1]` and `rides[index]`. */
  index: number;
  /** Where it broke: `"Asker stasjon"`. */
  at: string;
  /** `"Connection missed"` — the heading. */
  label: string;
  /** `"08:04 arrival misses the 08:02"` — the two numbers that say so. */
  detail: string;
  /** How much time the change is short by. */
  shortfallMs: number;
}

/**
 * The transfer this change actually needs: what the planner walked you, or a
 * floor when it walked you nowhere. A change with literally zero slack is one a
 * traveller misses, and calling it intact would be the widget's one confident
 * lie.
 */
function transferFloorMs(trip: TransitTrip, fromLeg: TransitLeg, toLeg: TransitLeg): number {
  const between = trip.legs.filter(
    (leg) =>
      !isRideMode(leg.mode) &&
      leg.aimedStartMs >= fromLeg.aimedEndMs &&
      leg.aimedEndMs <= toLeg.aimedStartMs,
  );
  const walkMs = between.reduce((total, leg) => total + leg.durationMs, 0);
  return Math.max(walkMs, MIN_TRANSFER_MS);
}

/** When this vehicle really got in, or the best live estimate of it. */
function arrivalMs(leg: TransitLeg): number {
  return leg.actualEndMs ?? leg.expectedEndMs;
}

function departureMs(leg: TransitLeg): number {
  return leg.actualStartMs ?? leg.expectedStartMs;
}

/**
 * The first change on this journey that the numbers have broken, or null.
 *
 * Only changes still ahead count: a connection the traveller has already made —
 * the next vehicle has left with them on it — is not a warning, it is history,
 * and re-announcing it every refresh is how a widget cries wolf.
 */
export function commuteConnectionBreak(
  journey: CommuteJourney,
  nowMs: number,
): CommuteConnectionBreak | null {
  const legs = rideLegs(journey.trip);
  for (let index = 1; index < legs.length; index += 1) {
    const previous = legs[index - 1]!;
    const next = legs[index]!;
    if (legDeparted(next, nowMs)) continue;
    const needed = arrivalMs(previous) + transferFloorMs(journey.trip, previous, next);
    const shortfallMs = needed - departureMs(next);
    if (shortfallMs <= 0) continue;
    const ride = journey.rides[index];
    const at = journey.connections[index - 1]?.at ?? previous.to.name;
    return {
      index,
      at,
      label: 'Connection missed',
      detail: `${journey.rides[index - 1]?.arrival.expected ?? '--:--'} arrival misses the ${
        ride?.departure.expected ?? '--:--'
      }`,
      shortfallMs,
    };
  }
  return null;
}

// -------------------------------------------------------- the substitute ---
//
// The replacement for a connection the numbers have broken — TRANSIT.md §W4, the half
// that had to wait for real commuting because a leg offered from a board asked
// seconds earlier is a promise about a connection nobody has stood at yet.
//
// **The journey is replaced, not the ladder.** The trap that decides this
// design: when the change breaks and the traveller takes a different train, the
// *original* leg 2 still publishes `actualStartMs` — so tier 2, the strongest
// rung of the ladder, would read `riding` on a vehicle nobody boarded,
// confidently and with the operator's own record behind it. Patching the phase
// enum around that is how a widget grows ten special cases. Splicing the
// substitute into the committed trip instead means every derivation downstream
// — phase, action, arrival, detail, expiry — is right without knowing that a
// substitution happened at all.

/**
 * The upstream question that re-plans the rest of a journey from the
 * interchange the connection broke at.
 *
 * Anchored on the corridor's own stops rather than on the leg's coordinates:
 * `commuteSegments` is already the one definition of what a corridor's hops
 * are and its places carry `stopId`, which is the difference between asking
 * about Asker stasjon and asking about a point 40 metres from one of its
 * entrances. Everything after the break that the corridor names stays a `via`,
 * so a three-hop commute re-plans generically rather than by a rule about the
 * one interchange this was written for.
 */
export function commuteSubstituteQuery(
  query: TransitCommuteQuery,
  direction: TransitCommuteDirection,
  journey: CommuteJourney,
  broken: CommuteConnectionBreak,
  nowMs: number,
): TransitQuery | null {
  const legs = rideLegs(journey.trip);
  const previous = legs[broken.index - 1];
  const next = legs[broken.index];
  if (!previous || !next) return null;
  // The same arithmetic the break itself used — same legs, same helper — so the
  // question cannot be asked about a moment the warning did not mean.
  const readyMs = arrivalMs(previous) + transferFloorMs(journey.trip, previous, next);
  const hops = commuteSegments(query).filter((hop) => hop.direction === direction);
  const stops = hops.length > 0 ? [...hops.map((hop) => hop.from), hops[hops.length - 1]!.to] : [];
  const at = stops.findIndex((stop) => stop.name === broken.at);
  // A change at a stop the commute does not name — a planner's own idea of how
  // to get there — has no corridor place to anchor on, so the leg's arrival
  // point stands in. Worse, and still much better than not offering a way on.
  const from = at >= 0 ? stops[at]! : previous.to.position;
  const to = stops.at(-1) ?? (direction === 'outbound' ? query.to : query.from);
  const via = at >= 0 ? stops.slice(at + 1, -1) : [];
  const lineFilter = commuteLineFilter(query.filter);
  return {
    from,
    to,
    ...(via.length > 0 ? { via } : {}),
    // Never earlier than now: a substitute is something still catchable, and a
    // `dateTime` in the past is what returns journeys that have already gone.
    // The two differ exactly when the missed change has already happened, which
    // is the case this is most likely to be read in.
    dateTimeMs: Math.max(readyMs, nowMs),
    limit: 3,
    ...(query.filter.modes.length > 0 ? { modes: query.filter.modes } : {}),
    ...(lineFilter ? { lineFilter } : {}),
  };
}

/**
 * The substitute worth offering out of an answer: the earliest journey that
 * leaves after the traveller can be standing there.
 *
 * Through `commuteJourneyList` rather than down `result.trips`, for the reason
 * `findCommittedTrip` is: Entur's answer is *ranked*, not ordered, so its first
 * trip is not its earliest — and the two surfaces of one commute must not come
 * to different ideas of which journey is next.
 */
export function commuteSubstituteTrip(
  result: TransitResult,
  notBeforeMs: number,
  nowMs: number,
): TransitTrip | null {
  for (const journey of commuteJourneyList(
    result.trips.map((trip, index) => commuteJourney(trip, nowMs, index)),
  )) {
    const first = rideLegs(journey.trip)[0];
    if (!first) continue;
    if ((first.actualStartMs ?? first.expectedStartMs) >= notBeforeMs) return journey.trip;
  }
  return null;
}

/**
 * The committed journey with its remaining legs replaced by the substitute's.
 *
 * The commitment survives the splice and keeps naming the *original* journey:
 * `commuteCommitId` is the first ride's scheduled departure and line, both of
 * which are kept here. This is the same commitment re-planned, not a new one,
 * and a commitment that renamed itself mid-journey would release the pin it is
 * holding.
 *
 * Null when there is nothing to splice — no ride before the break, or an empty
 * substitute — because the caller's fallback is v0.182.0's behaviour, which is
 * the break stated and no replacement offered.
 */
export function commuteSpliceTrip(
  committed: TransitTrip,
  substitute: TransitTrip,
  breakIndex: number,
): TransitTrip | null {
  const substituteStartMs = substitute.legs[0]?.aimedStartMs;
  if (substituteStartMs === undefined || breakIndex < 1) return null;

  const kept: TransitLeg[] = [];
  let rides = 0;
  for (const leg of committed.legs) {
    if (isRideMode(leg.mode)) {
      if (rides >= breakIndex) break;
      rides += 1;
      kept.push(leg);
      continue;
    }
    // The walk across the platform still happens and is kept; the walk out of
    // the far station belongs to the journey that replaced this one, and
    // keeping both would count the same minutes twice.
    if (rides >= breakIndex && leg.aimedStartMs >= substituteStartMs) break;
    kept.push(leg);
  }
  if (rides < breakIndex) return null;

  const legs = [...kept, ...substitute.legs];
  const startMs = legs[0]?.aimedStartMs ?? committed.startMs;
  const endMs = legs.at(-1)?.aimedEndMs ?? substitute.endMs;
  return {
    startMs,
    endMs,
    durationMs: endMs - startMs,
    walkDistanceM: legs
      .filter((leg) => !isRideMode(leg.mode))
      .reduce((total, leg) => total + leg.distanceM, 0),
    // Only when both halves carry one: a figure that silently covers half a
    // journey is worse than none beside a mode comparison.
    ...(committed.co2Grams !== undefined && substitute.co2Grams !== undefined
      ? { co2Grams: committed.co2Grams + substitute.co2Grams }
      : {}),
    legs,
  };
}

/**
 * What a spliced journey says instead of the warning it replaced.
 *
 * Carried beside the journey rather than derived from it, because a spliced
 * journey is — deliberately — indistinguishable from one that always looked
 * like this: that is the whole point of replacing the journey the ladder runs
 * on. The board needs to be *told* a substitution happened to be able to say so.
 */
export interface CommuteConnectionReplacement {
  /** Where the original connection broke: `"Asker stasjon"`. */
  at: string;
  /** Which ride of the spliced journey is the replacement — `rides[index]`. */
  index: number;
}

// -------------------------------------------------------- the commitment ---

/**
 * The journey the user tapped — TRANSIT.md §W2 tier 1, and §W3's per-instance,
 * expiring commitment.
 *
 * Identified by the *scheduled* departure and the first line rather than by any
 * id Entur hands out, because the point of a commitment is that it survives
 * refreshes: `expectedStartMs` moves when the bus is delayed, and a commitment
 * keyed on it would release itself the moment the thing it is about went wrong.
 */
export interface TransitWidgetV2Commit {
  direction: TransitCommuteDirection;
  /** Epoch ms of the *scheduled* departure — `CommuteJourney.startMs`. */
  departureMs: number;
  /** The first vehicle's public code, so two services leaving at one minute stay distinct. */
  line: string;
  /** Epoch ms the tap happened, for the audit the store keeps. */
  committedAtMs?: number;
  /**
   * Where the committed journey starts — `door` (the commute's own end) or the
   * corridor's last `interchange`, TRANSIT.md §13's middle ground.
   *
   * Optional, and absent means `door`: every commitment made before the board
   * could start anywhere else was one, including those already sitting in a
   * widget's `SharedPreferences`. It is part of the identity because it decides
   * which question re-reads the journey — the train home from Asker is not in
   * an answer asked from Engelsrud — and {@link commuteCommitKey} therefore
   * keeps the door form byte-identical to what it always was.
   */
  origin?: CommuteOriginId;
}

/**
 * A journey's commitment id: `"outbound:1756276200000:280"`.
 *
 * One string, because it crosses a JSON boundary into a `SharedPreferences` key
 * and back, and a widget comparing three fields in Kotlin would be a second
 * definition of what "the same journey" means.
 */
export function commuteCommitId(
  direction: TransitCommuteDirection,
  journey: CommuteJourney,
  origin: CommuteOriginId = 'door',
): string {
  return `${commitScope(direction, origin)}:${journey.startMs}:${journey.rides[0]?.line ?? 'walk'}`;
}

/**
 * What the id's first field names: the direction, and — only when the journey
 * starts somewhere other than the commute's own end — where from.
 *
 * A door commitment keeps the bare `"outbound"` it has always had, so a key
 * written by an older build still matches the journey it named.
 */
function commitScope(direction: TransitCommuteDirection, origin: CommuteOriginId): string {
  return origin === 'door' ? direction : `${direction}@${origin}`;
}

/** The same id from a stored commitment, so the two can be compared as strings. */
export function commuteCommitKey(commit: TransitWidgetV2Commit): string {
  return `${commitScope(commit.direction, commit.origin ?? 'door')}:${commit.departureMs}:${
    commit.line
  }`;
}

/**
 * How far before its own scheduled departure the committed journey is asked
 * for.
 *
 * A board asked "from now" cannot contain a journey that has already left, so a
 * commitment mid-morning would simply vanish from the answer. Entur *does*
 * return departed journeys when `dateTime` is in the past — measured on this
 * corridor on 2026-08-27, the 280 that left Engelsrud at 22:44 came back with
 * `actualDepartureTime 22:44:24` and `actualArrivalTime 23:02:00` — and that one
 * call is also what brings the ladder's tier 2 back. Five minutes of lead so a
 * journey brought *forward* by a live update is still in the window.
 */
const COMMIT_LOOKBACK_MS = 5 * 60_000;

/**
 * The upstream question that re-reads one committed journey.
 *
 * Built here rather than in the backend for the same reason the rows are: the
 * backend is an adapter, and "which question re-reads a commitment" is a fact
 * about commitments. `arriveBy` is dropped deliberately — the commitment names a
 * departure, and asking "arrive by 07:10" would answer with something else
 * entirely.
 */
export function commuteCommitQuery(
  query: TransitCommuteQuery,
  commit: TransitWidgetV2Commit,
  limit = 4,
): TransitQuery {
  // Through `commuteOrigins`, so "which question is this board asking" has one
  // answer: a journey committed to from the interchange is re-read from the
  // interchange, and one committed to from the door is re-read exactly as it
  // always was.
  const origins = commuteOrigins(query, commit.direction);
  const origin = origins.find((option) => option.id === (commit.origin ?? 'door')) ?? origins[0]!;
  return {
    from: origin.from,
    via: origin.via,
    to: origin.to,
    limit,
    dateTimeMs: commit.departureMs - COMMIT_LOOKBACK_MS,
    ...(query.filter.modes.length > 0 ? { modes: query.filter.modes } : {}),
    ...(commuteLineFilter(query.filter) ? { lineFilter: commuteLineFilter(query.filter)! } : {}),
  };
}

/**
 * The upstream questions a v2 board is built from — one per direction shown.
 *
 * Almost `commuteTransitQueries`, with one deliberate difference that only
 * applies to v2: **a direction you are committed to is asked from now, not at
 * the commute's saved time.** The saved time resolves to the *next* occurrence,
 * so at 07:40 mid-journey the outbound board would answer with tomorrow morning
 * — right for "when does my commute leave", wrong for the widget whose focus is
 * "what do I do next", and worst exactly where the list under it should be
 * answering "and if I miss the connection?".
 *
 * The uncommitted directions keep the saved time, which is what makes an
 * evening glance show tomorrow's 07:10 rather than nothing at all.
 */
export function commuteWidgetV2Queries({
  query,
  directions,
  commit,
  nowMs,
  maxRows,
}: {
  query: TransitCommuteQuery;
  directions: readonly TransitCommuteDirection[];
  commit: TransitWidgetV2Commit | null;
  nowMs: number;
  maxRows: number;
}): { key: TransitCommuteDirection; query: TransitQuery }[] {
  const base = commuteTransitQueries({ ...query, limit: maxRows }, nowMs);
  return directions.map((key) => {
    const asked = base[key];
    if (!commit || commit.direction !== key) return { key, query: asked };
    const { dateTimeMs: _dateTimeMs, arriveBy: _arriveBy, ...fromNow } = asked;
    return { key, query: fromNow };
  });
}

/**
 * The committed journey inside an answer, or null when it is not there.
 *
 * Null is a real outcome, not a failure to report: an operator can withdraw a
 * departure, and a commitment to a journey that no longer exists must release
 * rather than freeze the widget on a plan nothing will run. The widget then
 * shows the timetable again, which is correct and useful on its own.
 */
export function findCommittedTrip(
  result: TransitResult,
  commit: TransitWidgetV2Commit,
  nowMs: number,
): TransitTrip | null {
  const key = commuteCommitKey(commit);
  // Through `commuteJourneyList`, not down `result.trips`, and that is not a
  // tidiness point — it is what makes "the same journey" mean one thing.
  //
  // A commit id is the departure and the first vehicle, so two journeys that
  // board the same bus and change onto different trains share it. Measured on
  // the live corridor: the 23:42 280 came back twice, once arriving 00:21 and
  // once 00:39. The board dedupes those and keeps the earliest arrival, so its
  // row says 00:21 — while a raw scan of Entur's *ranked* answer could match the
  // 00:39 one first, and the focus would then follow a different train from the
  // row the reader tapped. Same list, same order, same survivor.
  for (const journey of commuteJourneyList(
    result.trips.map((trip, index) => commuteJourney(trip, nowMs, index)),
  )) {
    if (commuteCommitId(commit.direction, journey, commit.origin ?? 'door') === key) {
      return journey.trip;
    }
  }
  return null;
}

/**
 * Slack after the scheduled arrival before a commitment lets go — TRANSIT.md §W3's
 * "releases at the journey's scheduled arrival plus slack".
 *
 * Twenty minutes: long enough that a delayed run still ends under its own
 * commitment, short enough that nothing holds into the next thing you do.
 */
const COMMIT_SLACK_MS = 20 * 60_000;

/** Whether a commitment is still about something that has not finished happening. */
export function commuteCommitHolds(journey: CommuteJourney, nowMs: number): boolean {
  return nowMs <= journey.endMs + COMMIT_SLACK_MS;
}

// ---------------------------------------------------------- the selector ---

/** What the selector is set to. `auto` is the default and the thing one tap returns to. */
export type TransitWidgetV2Selector = TransitCommuteDirection | 'auto';

/**
 * A coarse, cached idea of where the phone is — AUTO's *presentation* only.
 *
 * Written by the app when it happens to be in the foreground, read by the widget
 * from its own store; the widget never asks for a fix of its own, and a stale
 * one is simply not consulted. It may decide which blocks are drawn and nothing
 * else: never the journey, never the state, never the committed leg.
 */
export type TransitWidgetV2Place = 'home' | 'interchange' | 'away' | 'unknown';

/**
 * Which end of the commute a coarse position is at — TRANSIT.md §W2's cached fix,
 * decided here rather than in Kotlin because "what counts as being at the
 * interchange" is a fact about the commute, not a paint decision.
 *
 * The radius is generous on purpose. This answer may only ever choose AUTO's
 * *presentation* — never the journey, never the state, never the committed leg —
 * so a false "at the interchange" costs one extra block on screen, while a
 * radius tight enough to miss the far end of a station car park costs the
 * feature. Anything not near a named stop is `away`, which is the honest reading
 * of "somewhere else entirely".
 */
const PLACE_RADIUS_M = 600;

export function commutePlaceAt(query: TransitCommuteQuery, point: LatLng): TransitWidgetV2Place {
  const near = (place: { lat: number; lng: number }) =>
    haversineM(point, { lat: place.lat, lng: place.lng }) <= PLACE_RADIUS_M;
  if (query.via.some(near)) return 'interchange';
  if (near(query.from)) return 'home';
  if (near(query.to)) return 'away';
  return 'unknown';
}

/** One option in the compact direction selector. */
export interface TransitWidgetV2Option {
  key: TransitWidgetV2Selector;
  /** `"Whichever is next"` — the full phrasing, for the chooser and the reader. */
  label: string;
  /** `"AUTO"`, `"TO OSLO"`, `"TO HOME"` — what fits on the widget's own chip. */
  short: string;
}

/** The selector as the widget paints it, with the pin's own expiry stated. */
export interface TransitWidgetV2SelectorState {
  mode: TransitWidgetV2Selector;
  /** The chip's text: the chosen option's `short`. */
  label: string;
  options: TransitWidgetV2Option[];
  /**
   * `"Pinned until 15:30"`, or null on AUTO.
   *
   * TRANSIT.md §W1: a pinned direction that never expires is wrong for half of every
   * day. It says when it lets go rather than flipping silently, and returning to
   * AUTO is one tap.
   */
  note: string | null;
  /** Epoch ms the pin releases at, or null when nothing is pinned. */
  releasesAtMs: number | null;
}

/**
 * The last instant of the Norwegian service day a pin may survive into.
 *
 * 03:00 rather than midnight: a night bus at 00:40 belongs to the evening it
 * started, and a pin releasing under someone standing at a stop is the failure
 * an expiry exists to avoid.
 */
function endOfServiceDayMs(nowMs: number): number {
  const now = norwayTime(nowMs);
  const today = norwayInstant(now.year, now.month, now.day, 3 * 60);
  return today > nowMs ? today : norwayInstant(now.year, now.month, now.day + 1, 3 * 60);
}

/**
 * When a pin on `direction` releases: the moment the *other* direction's window
 * opens, or the end of the service day when the commute saves no times.
 *
 * "The other direction's window" is the honest trigger — a widget pinned to the
 * way out is right until the way home becomes the question, which is exactly the
 * instant the return time comes round.
 */
export function commuteDirectionPinReleaseMs(
  query: TransitCommuteQuery,
  direction: TransitCommuteDirection,
  pinnedAtMs: number,
): number {
  const other = direction === 'outbound' ? query.inboundTime : query.outboundTime;
  const dayEnd = endOfServiceDayMs(pinnedAtMs);
  if (other.minutesOfDay === null) return dayEnd;
  const opens = windowOpensAtMs(
    // Only the other direction's time may end this pin, so the pin's own
    // direction is blanked rather than competing with it.
    {
      ...query,
      outboundTime: direction === 'outbound' ? { minutesOfDay: null, arriveBy: false } : other,
      inboundTime: direction === 'outbound' ? other : { minutesOfDay: null, arriveBy: false },
    },
    pinnedAtMs,
  );
  return Math.min(opens, dayEnd);
}

/**
 * How wide a chip's place name may be before it is cut.
 *
 * The chips share one row with the ↻, so on a four-cell instance each has
 * roughly 60dp — about eight characters at 10sp bold. The cut is made here
 * rather than left to `ellipsize` alone so the *string* is honest about being
 * short: a screen reader gets the full direction from the chip's
 * `contentDescription`, which is `label`.
 */
const CHIP_NAME_MAX = 12;

/** `"TO OSLO"` — the far end of the direction, as a chip has room for. */
function directionShort(query: TransitCommuteQuery, direction: TransitCommuteDirection): string {
  const name = direction === 'outbound' ? query.to.name : query.from.name;
  // The first word is the place; "Nationaltheatret stasjon" and "Oslo S" both
  // want their first token and nothing after it.
  const first = name.split(/[,·]/)[0]!.trim().split(/\s+/)[0]!.toUpperCase();
  const short = first.length > CHIP_NAME_MAX ? `${first.slice(0, CHIP_NAME_MAX)}…` : first;
  return `TO ${short}`;
}

/** Every option the selector offers, in the order it draws them. */
export function commuteSelectorOptions(query: TransitCommuteQuery): TransitWidgetV2Option[] {
  return [
    { key: 'auto', label: 'Whichever is next', short: 'AUTO' },
    {
      key: 'outbound',
      label: commuteDirectionLabel(query, 'outbound'),
      short: directionShort(query, 'outbound'),
    },
    {
      key: 'inbound',
      label: commuteDirectionLabel(query, 'inbound'),
      short: directionShort(query, 'inbound'),
    },
  ];
}

/** Which direction(s) a v2 instance is about right now, and what decided it. */
export interface TransitWidgetV2Resolution {
  /** One direction, or both — the interchange is the only case that draws two. */
  directions: TransitCommuteDirection[];
  /** Which rule chose them, so the widget can say so rather than look arbitrary. */
  reason: 'pinned' | 'committed' | 'interchange' | 'clock';
  /** The pin, when one still holds. Null once it has expired — it is not re-applied. */
  pin: { direction: TransitCommuteDirection; releasesAtMs: number } | null;
}

/**
 * The direction question, answered once and used twice: the backend asks
 * upstream with it, and the board is rendered with it. Two answers to this would
 * be a widget titled for one direction listing the other's departures.
 *
 * The tiers in order, and a lower one never overrides a higher one:
 *  - a pin that still holds (a tap on the selector),
 *  - a live commitment (a tap on a row),
 *  - standing at the interchange with nothing committed — where either direction
 *    is genuinely live, so AUTO draws both rather than guessing (TRANSIT.md §W5),
 *  - the clock (`defaultCommuteDirection`).
 */
export function resolveCommuteV2Directions({
  query,
  selector,
  pinnedAtMs,
  commit,
  place,
  nowMs,
}: {
  query: TransitCommuteQuery;
  selector: TransitWidgetV2Selector;
  /** Epoch ms the selector was last set by hand; 0 when it never was. */
  pinnedAtMs: number;
  commit: TransitWidgetV2Commit | null;
  place: TransitWidgetV2Place | null;
  nowMs: number;
}): TransitWidgetV2Resolution {
  if (selector !== 'auto') {
    const releasesAtMs = commuteDirectionPinReleaseMs(query, selector, pinnedAtMs || nowMs);
    if (nowMs < releasesAtMs) {
      return {
        directions: [selector],
        reason: 'pinned',
        pin: { direction: selector, releasesAtMs },
      };
    }
  }
  // A commitment is a tap on a row, which is a stronger statement about
  // direction than anything the clock knows.
  if (commit) return { directions: [commit.direction], reason: 'committed', pin: null };
  // Presentation only, and only where nothing above had an answer: standing at
  // the change, "the mode that is not the one you arrived on" is the real
  // question, and the widget declines to guess which.
  if (place === 'interchange') {
    return { directions: ['outbound', 'inbound'], reason: 'interchange', pin: null };
  }
  return { directions: [defaultCommuteDirection(query, nowMs)], reason: 'clock', pin: null };
}

// ------------------------------------------------------------- the board ---

/** One journey on a v2 block — a v1 row, plus what a *tappable* journey needs. */
export interface TransitWidgetV2Row extends TransitWidgetRow {
  /** {@link commuteCommitId} — what a tap on this row commits to. */
  id: string;
  /** Whether this is the journey currently committed to. */
  committed: boolean;
}

/** One direction's departures. */
export interface TransitWidgetV2Block {
  key: TransitCommuteDirection;
  /** `"Engelsrud → Nationaltheatret"`. */
  label: string;
  /** `"TO OSLO"` — the same word the selector chip uses for this direction. */
  short: string;
  rows: TransitWidgetV2Row[];
  /** Why `rows` is empty, in words, or null when it is not. */
  note: string | null;
}

/**
 * The one thing the widget says loudest — TRANSIT.md §W6, "next action first".
 *
 * Ordered by what to do next: the direction and state chips, then the action,
 * then the time until it, then the transfer information, then the detail. The
 * three questions it answers at a glance are where am I in the commute, which
 * information is relevant now, and what do I do next.
 */
export interface TransitWidgetV2Focus {
  /** The direction axis — never merged with {@link phase}. */
  direction: TransitCommuteDirection;
  directionLabel: string;
  /** The state axis. Null when nothing is committed and there is only a timetable. */
  phase: CommuteJourneyPhase | null;
  /** {@link COMMUTE_PHASE_LABEL}, or null with no phase. */
  phaseLabel: string | null;
  /** Which tier of TRANSIT.md §W2 placed the traveller, for the same reason a log has a source. */
  phaseSource: CommutePhaseSource | null;
  /** `"Board the 280"` / `"Change at Asker stasjon"` — the imperative. */
  action: string;
  /**
   * The clock time that action happens at, **as the timetable prints it**:
   * `"07:10"`. Null when there is none.
   *
   * The scheduled time, never the live estimate — the same rule the commute
   * board and the v1 row keep, and for the same reason: a focus reading "Board
   * 🚌 280 · 23:43" directly above a row reading "23:42 (+1 min)" is one widget
   * contradicting itself, and the reader has no way to tell which half to
   * believe. The correction rides beside it in {@link whenDelay}, and the
   * countdown — which *is* measured against the estimate — answers "when must I
   * be there".
   */
  when: string | null;
  /** `"+1 min"` / `"-2 min"` beside {@link when}, or null when nothing is off schedule. */
  whenDelay: string | null;
  /** The instant {@link countdown} runs to: the live estimate, not the timetable. */
  whenMs: number | null;
  /** `"in 6 min"` — the one number here that a client may re-render on a tick. */
  countdown: string | null;
  /** `"plat. 2"`, or null. What you need in your hand, not in a submenu. */
  platform: string | null;
  /** `"arrives 08:14 · 64 min"` — the journey behind the action. */
  detail: string | null;
  /** The broken connection or the disruption headline — nothing else may sit here. */
  alert: string | null;
  /** The colour source, exactly as a v1 row's `state` is. */
  state: CommuteServiceState;
  /** The whole focus on one line, for a screen reader and a surface with one row. */
  text: string;
}

/** Everything one v2 instance needs, with nothing left to compute. */
export interface TransitWidgetV2Board {
  /** The wire's own discriminator: a client holding a stored board must know which kind it is. */
  variant: 'v2';
  /** `"Engelsrud ↔ Nationaltheatret · via Asker stasjon"`. */
  route: string;
  selector: TransitWidgetV2SelectorState;
  focus: TransitWidgetV2Focus;
  blocks: TransitWidgetV2Block[];
  /**
   * The committed journey's id, echoed back so the widget can tell a commitment
   * that is still live from one the board has let go of. Null when nothing is
   * committed — including when a stored commitment has expired, which is how the
   * client learns to drop it.
   */
  commitId: string | null;
  /** `"Committed to the 07:10 · until 08:34"`, or null. */
  commitNote: string | null;
  checkedMs: number;
  source: string;
  checked: string;
  status: string;
  nextRefreshMs: number;
}

/**
 * While a commitment is live the ladder itself moves, so the board is asked
 * again on the ladder's cadence rather than the timetable's. Bounded by the
 * commitment, which expires — this can never become a permanent two-minute poll.
 */
const COMMITTED_REFRESH_MS = 2 * 60_000;

/** The journeys of one direction, ordered and trimmed exactly as v1 orders them. */
function directionJourneys(
  result: TransitResult,
  nowMs: number,
  maxRows: number,
): CommuteJourney[] {
  return commuteJourneyList(
    result.trips.map((trip, index) => commuteJourney(trip, nowMs, index)),
  ).slice(0, maxRows);
}

/** `"arrives 08:14 · 64 min"` — the journey behind whatever the action is. */
function journeyDetail(journey: CommuteJourney): string {
  return `arrives ${journey.arrival.aimed} · ${journey.duration}`;
}

function joinLine(parts: readonly (string | null)[]): string {
  return parts.filter((part): part is string => Boolean(part)).join(' · ');
}

/**
 * The headline, built from the phase rather than from a special case per
 * combination of phase and direction — TRANSIT.md §W6's second bullet, in code.
 */
function focusOf({
  query,
  direction,
  journey,
  progress,
  broken,
  replaced,
  nowMs,
}: {
  query: TransitCommuteQuery;
  direction: TransitCommuteDirection;
  journey: CommuteJourney | null;
  /**
   * Null when nothing is committed — which is not the same as "upcoming".
   * TRANSIT.md §W3: no commitment is invented, so with no tap the widget stays a
   * timetable and says nothing at all about where the traveller is. An assumed
   * commitment that is wrong is the one failure mode with no visible cause.
   */
  progress: CommuteJourneyProgress | null;
  broken: CommuteConnectionBreak | null;
  /** Set when this journey's own connection was re-planned — TRANSIT.md §W4. */
  replaced: CommuteConnectionReplacement | null;
  nowMs: number;
}): TransitWidgetV2Focus {
  const directionLabel = commuteDirectionLabel(query, direction);
  const empty: TransitWidgetV2Focus = {
    direction,
    directionLabel,
    phase: null,
    phaseLabel: null,
    phaseSource: null,
    action: 'Nothing upcoming',
    when: null,
    whenDelay: null,
    whenMs: null,
    countdown: null,
    platform: null,
    detail: null,
    alert: null,
    state: 'scheduled',
    text: `${directionLabel} · Nothing upcoming`,
  };
  if (!journey) return empty;

  const phase = progress?.phase ?? null;
  const rideIndex = progress?.rideIndex ?? 0;
  const ride = journey.rides[rideIndex] ?? journey.rides[0] ?? null;
  // The same vehicle as a leg, for the epoch milliseconds a countdown needs.
  // `rides` and the trip's ride legs are one list in one order, which is the
  // invariant `commuteJourneyProgress` already walks.
  const rideLeg = rideLegs(journey.trip)[rideIndex] ?? null;
  const glyph = ride ? `${transitModeGlyph(ride.mode)} ` : '';
  const connection = journey.connections[rideIndex - 1] ?? null;

  // What to do next, and the time it happens — one pair per rung of the ladder,
  // and the un-committed timetable falls in with `boarding`'s "go and board it",
  // which is what a departure list says without claiming anything more.
  const next = ((): {
    action: string;
    when: string | null;
    whenDelay: string | null;
    whenMs: number | null;
    platform: string | null;
  } => {
    switch (phase) {
      case 'riding':
        return {
          action: ride ? `On ${glyph}${ride.line} to ${ride.to}` : 'On the way',
          when: ride?.arrival.aimed ?? null,
          whenDelay: ride?.arrival.delay ?? null,
          // Nothing to count down to: the arrival is already on the line, and a
          // second copy of it ticking is the column v1 removed for good reason.
          whenMs: null,
          platform: null,
        };
      case 'interchange':
        return {
          action: ride ? `Change to ${glyph}${ride.line}` : 'Change here',
          when: ride?.departure.aimed ?? null,
          whenDelay: ride?.departure.delay ?? null,
          // The train you have not boarded is worth a countdown; the one you
          // are sitting on is not. Against the *estimate*, because a countdown
          // is the one number here that is about being there in time.
          whenMs: rideLeg?.expectedStartMs ?? null,
          platform: ride?.fromQuay ?? null,
        };
      case 'arrived':
        return {
          action: 'Arrived',
          when: journey.arrival.aimed,
          whenDelay: journey.arrival.delay,
          whenMs: null,
          platform: null,
        };
      default:
        return {
          action: ride ? `Board ${glyph}${ride.line}` : 'Leave now',
          when: ride?.departure.aimed ?? null,
          whenDelay: ride?.departure.delay ?? null,
          whenMs: rideLeg?.expectedStartMs ?? journey.startMs,
          platform: ride?.fromQuay ?? null,
        };
    }
  })();

  // The transfer information §W6 puts fourth: how long the change is, or — once
  // the numbers have broken it — that it is gone, and then which vehicle takes
  // over instead (§W4). A disruption headline takes the same slot when there is
  // neither, because all three answer "is this plan still true" and a widget has
  // room for one of them.
  //
  // The break outranks the replacement deliberately: a substitute's *own*
  // connection can break in turn, and that is the more urgent of the two things
  // to say.
  const replacedRide = replaced ? (journey.rides[replaced.index] ?? null) : null;
  const replacedChange = replaced ? (journey.connections[replaced.index - 1] ?? null) : null;
  const alert = broken
    ? `${broken.label} at ${broken.at} — ${broken.detail}`
    : replaced && replacedRide
      ? `Connection replaced at ${replaced.at} — ${replacedRide.departure.aimed} ${
          replacedRide.line
        }${replacedChange ? `, ${replacedChange.label} change` : ''}`
      : (journey.disruptions[0]?.summary ?? null);
  const detail =
    phase === 'interchange' && connection
      ? joinLine([connection.label, journeyDetail(journey)])
      : journeyDetail(journey);

  return {
    direction,
    directionLabel,
    phase,
    phaseLabel: phase ? COMMUTE_PHASE_LABEL[phase] : null,
    phaseSource: progress?.source ?? null,
    action: next.action,
    when: next.when,
    whenDelay: next.whenDelay,
    whenMs: next.whenMs,
    countdown:
      next.whenMs !== null && next.whenMs > nowMs ? commuteCountdown(next.whenMs, nowMs) : null,
    platform: next.platform,
    detail,
    alert,
    // A broken connection is the journey's state whatever its legs say: the
    // vehicles may all be running perfectly and the plan still be gone.
    state: broken ? 'delayed' : journey.state,
    text: joinLine([
      directionLabel,
      phase ? COMMUTE_PHASE_LABEL[phase] : null,
      next.when
        ? `${next.action} ${next.when}${next.whenDelay ? ` (${next.whenDelay})` : ''}`
        : next.action,
      next.platform,
      detail,
      alert,
    ]),
  };
}

/**
 * `"Pinned until 15:30"` — an expiry stated rather than left to surprise
 * someone. TRANSIT.md §W1: a pin that never expires is wrong for half of every day, and
 * one that flips silently is worse than one that says when it will.
 */
function pinNote(releasesAtMs: number, nowMs: number): string {
  // Past the service day's end the honest word is not a clock time: "pinned
  // until 03:00" reads as three in the morning to someone glancing at 22:40.
  return releasesAtMs >= endOfServiceDayMs(nowMs)
    ? 'Pinned for today'
    : `Pinned until ${norwayClock(releasesAtMs)}`;
}

/**
 * Assemble the board one v2 instance renders.
 *
 * `committedJourney` is passed in rather than found here: a journey that has
 * already left is not in a board asked "from now", so the backend re-reads it
 * with a `dateTime` around its own departure — which is the call that also
 * brings back the published record the ladder's tier 2 rests on.
 */
export function commuteWidgetV2Board({
  query,
  results,
  resolution,
  selector,
  commit,
  committedTrip,
  replaced = null,
  nowMs,
  maxRows = 3,
}: {
  query: TransitCommuteQuery;
  results: readonly {
    key: TransitCommuteDirection;
    result: TransitResult;
    emptyReason: CommuteEmptyReason;
  }[];
  resolution: TransitWidgetV2Resolution;
  selector: TransitWidgetV2Selector;
  commit: TransitWidgetV2Commit | null;
  /** The committed journey re-read at its own departure time, when there is one. */
  committedTrip: TransitTrip | null;
  /**
   * Set when `committedTrip` is a *spliced* journey — TRANSIT.md §W4. A spliced
   * journey is deliberately indistinguishable from one that always looked like
   * this, so the board has to be told in order to say so.
   */
  replaced?: CommuteConnectionReplacement | null;
  nowMs: number;
  maxRows?: number;
}): TransitWidgetV2Board {
  const commitKey = commit ? commuteCommitKey(commit) : null;

  // Derived once per direction and kept: the focus needs the *journey* behind
  // the leading row, and re-deriving it from the same trips would be a second
  // answer to what the first departure is.
  const prepared = results.map(({ key, result, emptyReason }) => {
    const journeys = directionJourneys(result, nowMs, maxRows);
    const rows: TransitWidgetV2Row[] = journeys.map((journey) => {
      const id = commuteCommitId(key, journey);
      return { ...tripWidgetRow(journey.trip, nowMs), id, committed: id === commitKey };
    });
    return {
      journeys,
      block: {
        key,
        label: commuteDirectionLabel(query, key),
        short: directionShort(query, key),
        rows,
        note: rows.length === 0 && emptyReason !== 'none' ? emptyDirectionNote(emptyReason) : null,
      } satisfies TransitWidgetV2Block,
    };
  });
  const blocks = prepared.map((entry) => entry.block);

  // The journey the focus is about: the committed one while it still holds,
  // otherwise none — and then the focus falls back to the leading block's next
  // departure, stated as a timetable rather than as a claim about where anyone
  // is standing.
  const committedJourney = committedTrip ? commuteJourney(committedTrip, nowMs) : null;
  const holds = committedJourney !== null && commuteCommitHolds(committedJourney, nowMs);
  // A commitment drives the *focus* only while its own direction is on screen.
  // The selector is a manual instruction and §W1 says it wins, so someone who
  // pins the way home while riding out gets the way home — but the commitment is
  // not released for it: it stays live, stays echoed back, and the focus returns
  // to it the moment AUTO does. A focus about a direction with no block under it
  // is the one incoherence this guards against.
  const commitShown = holds && commit ? resolution.directions.includes(commit.direction) : false;
  const focusDirection =
    (commitShown && commit ? commit.direction : resolution.directions[0]) ?? 'outbound';
  const lead = prepared.find((entry) => entry.block.key === focusDirection) ?? prepared[0] ?? null;
  const focusJourney = commitShown ? committedJourney : (lead?.journeys[0] ?? null);
  const progress =
    commitShown && committedJourney ? commuteJourneyProgress(committedJourney, nowMs) : null;
  const broken =
    commitShown && committedJourney ? commuteConnectionBreak(committedJourney, nowMs) : null;

  const focus = focusOf({
    query,
    direction: focusDirection,
    journey: focusJourney,
    progress,
    broken,
    replaced: commitShown ? replaced : null,
    nowMs,
  });

  const allRows = blocks.flatMap((block) => block.rows);
  const source = widgetSourceLabel(
    allRows.length > 0,
    blocks.find((block) => block.note)?.note ?? null,
  );
  const options = commuteSelectorOptions(query);
  const timetableRefreshMs = commuteRefreshAtMs(
    query,
    [...allRows].sort((a, b) => a.whenMs - b.whenMs),
    nowMs,
  );

  return {
    variant: 'v2',
    route: commuteRouteLabel(query),
    selector: {
      mode: selector,
      label: options.find((option) => option.key === selector)?.short ?? 'AUTO',
      options,
      note: resolution.pin ? pinNote(resolution.pin.releasesAtMs, nowMs) : null,
      releasesAtMs: resolution.pin?.releasesAtMs ?? null,
    },
    focus,
    blocks,
    // Echoed back rather than assumed: a stored commitment the board has let go
    // of comes back null, which is how the client learns to drop it instead of
    // holding one overnight.
    commitId: holds && commitKey ? commitKey : null,
    // Phrased here, whole, rather than wrapped in a sentence by the client:
    // Kotlin formats nothing, and "tap it again to release" is only true while
    // the committed row is one of the rows on screen.
    commitNote:
      !holds || !committedJourney
        ? null
        : commitShown
          ? `Committed to the ${committedJourney.departure.aimed} · tap it again to release`
          : `Still committed to the ${committedJourney.departure.aimed} · ${commuteDirectionLabel(
              query,
              commit?.direction ?? 'outbound',
            )}`,
    checkedMs: nowMs,
    source,
    checked: widgetCheckedLabel(nowMs),
    status: widgetStatusLine(source, nowMs),
    // A live commitment moves through the ladder on its own, so the board is
    // asked again on the ladder's cadence rather than the timetable's — bounded,
    // because the commitment itself expires.
    nextRefreshMs:
      holds && progress && progress.phase !== 'arrived'
        ? Math.min(timetableRefreshMs, nowMs + COMMITTED_REFRESH_MS)
        : timetableRefreshMs,
  };
}

/** `"9 min"` — a shortfall said the way every other duration on the board is said. */
export function commuteShortfallLabel(shortfallMs: number): string {
  return commuteDurationLabel(shortfallMs);
}
