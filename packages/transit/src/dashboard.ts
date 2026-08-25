/**
 * The commute dashboard: a personal timetable, derived once for both clients.
 *
 * This is the model behind ROADMAP §6.4, and it exists because the surface it
 * replaces was a *configuration form with a result list stapled underneath*.
 * Opening the commute board meant reading three stop pickers, two time fields,
 * seven day chips and a wall of line chips before reaching the only two
 * questions a commuter actually has:
 *
 *   1. If I take this departure, when do I arrive?
 *   2. What is the next departure on the leg I am on right now?
 *
 * Four decisions run through everything below, and each one is a reversal of
 * what the old board did:
 *
 *  - **The scheduled time is the primary number; the live estimate is a labelled
 *    secondary.** The old rows printed `trip.startMs`, which is the *expected*
 *    time, so a delayed 08:41 silently became "08:43" — the departure board at
 *    the station still says 08:41, the timetable still says 08:41, and the one
 *    screen that disagreed was ours. Every clock time here comes from an
 *    `aimed*` field, with the estimate beside it saying what it is.
 *  - **The connection is computed, never left to the reader.** Bus in at 09:02,
 *    train out at 09:11 is a nine-minute change, and the traveller should not
 *    have to subtract two numbers on a platform to learn that.
 *  - **A colour may only come from what a service *is*.** Same rule the
 *    home-screen widget learned in v0.176.0, same vocabulary
 *    (`TransitWidgetRowState`), one value added for the bus that turns up where
 *    a train was booked.
 *  - **Times are Norwegian wall-clock times** (`norwayClock`), not the device's.
 *    A Norwegian departure time *is* a Norwegian clock time, and the same board
 *    renders on a phone, in a browser and — through the widget — on a container
 *    whose clock is UTC.
 */

import { norwayClock, norwayDateLabel, norwayDayNote, type TransitWeekday } from './clock.js';
import {
  DELAY_THRESHOLD_MS,
  TRANSIT_MODE_LABEL,
  legTimeParts,
  quayLabel,
  transfersLabel,
  type LegTimeParts,
} from './labels.js';
import { isRideMode, type TransitCommuteDirection } from './model.js';
import type {
  TransitCommutePlace,
  TransitCommuteQuery,
  TransitLeg,
  TransitMode,
  TransitResult,
  TransitSeverity,
  TransitSituation,
  TransitTrip,
} from './model.js';
import type { TransitWidgetRowState } from './widget.js';

// ---------------------------------------------------------------- status ---

/**
 * What a service *is* — the only thing a client may pick a colour from.
 *
 * Deliberately the widget's own vocabulary plus one value: `replacement`, which
 * a widget row has nowhere to say but a dashboard does. `live` is a realtime
 * departure running to time; `scheduled` is one with no live prediction at all,
 * which is a weaker promise and should read as one.
 */
export type CommuteServiceState = TransitWidgetRowState | 'replacement';

/** The word for a state, so two clients cannot label the same colour differently. */
export const COMMUTE_STATE_LABEL: Record<CommuteServiceState, string> = {
  cancelled: 'Cancelled',
  replacement: 'Replacement service',
  delayed: 'Delayed',
  early: 'Early',
  live: 'On time',
  scheduled: 'Timetable',
};

/**
 * How a disruption reads — §4's "distinct statuses", limited to what the wire
 * actually says.
 *
 * Four of the spec's five are real signals: a cancellation flag on the boarding
 * call, a replacement submode on the leg, a measurable delay, and Entur's
 * `reportType: general` for work announced in advance. The fifth — *route
 * change* — has **no field**. Probed against the live schema on 2026-08-25,
 * `PtSituationElement` exposes only `reportType`, `severity`, `priority`,
 * `validityPeriod` and free text; there is no consequence or reason enum behind
 * it. So a diversion arrives here as `incident` carrying the operator's own
 * sentence, and is shown as that sentence. Guessing it out of Norwegian
 * substrings ("omkjøring", "endret trasé") would be a status the data cannot
 * support, on the one screen whose job is to be trustworthy at 07:40.
 */
export type CommuteDisruptionKind =
  'cancellation' | 'replacement' | 'delay' | 'planned' | 'incident';

export const COMMUTE_DISRUPTION_LABEL: Record<CommuteDisruptionKind, string> = {
  cancellation: 'Cancelled',
  replacement: 'Replacement service',
  delay: 'Delayed',
  planned: 'Planned disruption',
  incident: 'Disruption',
};

/** One disruption notice, classified and ready to paint under its own service. */
export interface CommuteDisruption {
  /** Stable within a journey, so a list key never collides across legs. */
  key: string;
  kind: CommuteDisruptionKind;
  /** {@link COMMUTE_DISRUPTION_LABEL} — the heading, e.g. "Planned disruption". */
  kindLabel: string;
  severity: TransitSeverity;
  /** The operator's headline. */
  summary: string;
  /** What they want you to *do*, or the longer text when there is no advice. */
  detail: string | null;
  url: string | null;
}

/**
 * Classify one situation. `kind` leans on the leg's own facts first: a
 * cancelled boarding call and a replacement submode are stronger evidence than
 * anything in the prose, and an operator who publishes "Innstilt" as a `general`
 * report should still be read as a cancellation.
 */
function commuteDisruption(
  situation: TransitSituation,
  index: number,
  leg: { cancelled?: boolean; replacement?: boolean },
): CommuteDisruption {
  const kind: CommuteDisruptionKind = leg.cancelled
    ? 'cancellation'
    : leg.replacement
      ? 'replacement'
      : situation.planned
        ? 'planned'
        : 'incident';
  return {
    key: situation.id ?? `${index}`,
    kind,
    kindLabel: COMMUTE_DISRUPTION_LABEL[kind],
    severity: situation.severity,
    summary: situation.summary,
    detail: situation.advice ?? situation.description ?? null,
    url: situation.url ?? null,
  };
}

/**
 * A delay is *not* turned into a disruption notice here, though an earlier cut
 * of this file did exactly that.
 *
 * Driven against the live Engelsrud board on 2026-08-25, a three-minute delay
 * on the 71 rendered as: an amber left edge on the row, "09:11 est." on the meta
 * line, "09:11 est." under the leg's scheduled time — and then a warning box
 * reading "DELAYED · Running 3 min behind the timetable · Timetabled 09:09, now
 * expected 09:11". Four statements of one fact, the fattest of them pushing the
 * next journey's scan line off the panel. `delay` survives in
 * {@link CommuteDisruptionKind} because a *situation* about a delay is real
 * operator prose worth showing; the measurement itself is carried by
 * `state` and `commuteEstimateLabel`, which is where a number belongs.
 */

function serviceState(leg: TransitLeg, parts: LegTimeParts): CommuteServiceState {
  if (leg.cancelled) return 'cancelled';
  if (leg.replacement) return 'replacement';
  if (parts.tone === 'late') return 'delayed';
  if (parts.tone === 'early') return 'early';
  return leg.realtime ? 'live' : 'scheduled';
}

/** The worst of a set of states — what a collapsed row must warn at. */
const STATE_RANK: Record<CommuteServiceState, number> = {
  cancelled: 5,
  replacement: 4,
  delayed: 3,
  early: 2,
  scheduled: 1,
  live: 0,
};

function worstState(states: readonly CommuteServiceState[]): CommuteServiceState {
  let worst: CommuteServiceState = 'live';
  for (const state of states) if (STATE_RANK[state] > STATE_RANK[worst]) worst = state;
  return worst;
}

// ---------------------------------------------------------------- pieces ---

/** One vehicle inside a journey, expanded. */
export interface CommuteRide {
  key: string;
  mode: TransitMode;
  /** "Bus", "Train" — the same words the mode filter uses. */
  modeLabel: string;
  /** `"270"`, `"L1"` — what is on the front of the vehicle. */
  line: string;
  /** Where this particular departure is headed, when the call said. */
  towards: string | null;
  operator: string | null;
  /** Boarding and alighting stop names. */
  from: string;
  to: string;
  /** `"plat. 3"`, or null at a stop with no platform to name. */
  fromQuay: string | null;
  toQuay: string | null;
  departure: LegTimeParts;
  arrival: LegTimeParts;
  /**
   * `"08:36 → 09:02"` — when this particular vehicle leaves and when it gets in,
   * on the timetable's own numbers.
   *
   * This is what makes a *collapsed* journey row answer the question a two-leg
   * commute actually asks. "🚌 270 🚆 L1" says a train is involved and says
   * nothing about when it leaves Asker or when it reaches town, so the reader
   * has to expand a row to learn the thing they opened the board for. Every
   * vehicle now states its own window on the row itself.
   */
  window: string;
  /** `"3 stops · 12 min"` — what the ride costs, without expanding further. */
  ride: string;
  state: CommuteServiceState;
  disruptions: CommuteDisruption[];
}

/**
 * A change between two vehicles, with the number the traveller would otherwise
 * have to work out. `tight` is a statement about slack, not a colour: Entur
 * planned the connection, so it is legal — but four minutes across Asker with a
 * train already running late is worth flagging before you rely on it.
 */
export interface CommuteConnection {
  key: string;
  /** Where you change. */
  at: string;
  /** Scheduled arrival of the vehicle you leave, and departure of the one you board. */
  arrive: string;
  depart: string;
  waitMs: number;
  /** `"9 min"`. */
  label: string;
  tight: boolean;
  /** Metres on foot between the two platforms, when the planner walked you. */
  walkM: number;
  /** `"250 m walk"`, or null when the change is a platform step. */
  walk: string | null;
  /** `"9 min at Asker stasjon"` — the change as the collapsed leg strip states it. */
  chip: string;
  /**
   * `"Change at Asker stasjon · 9 min · 250 m walk · tight"` — the whole line an
   * expanded journey shows between two vehicles. Composed here so the two
   * clients cannot describe one change with two different sentences; `tight`
   * stays a flag beside it because the *colour* is a paint decision.
   */
  summary: string;
}

/** A connection under this is worth naming as tight. Two minutes is a platform change. */
const TIGHT_CONNECTION_MS = 4 * 60_000;

/**
 * Metres between two platforms, phrased only when they are worth walking.
 *
 * Under twenty is the same platform measured with a router's precision, and a
 * "12 m walk" under a nine-minute change is noise on the one screen that must
 * stay scannable. Rounded to ten metres because that is the accuracy the number
 * actually has.
 */
function changeWalkLabel(walkM: number): string | null {
  if (walkM < 20) return null;
  if (walkM < 1000) return `${Math.round(walkM / 10) * 10} m walk`;
  return `${(walkM / 1000).toFixed(1)} km walk`;
}

/** One complete door-to-door option, with nothing left for the reader to compute. */
export interface CommuteJourney {
  key: string;
  /** The journey itself, for a client that wants to draw it on a map. */
  trip: TransitTrip;
  /** Epoch ms of the scheduled departure — what a countdown ticks towards. */
  startMs: number;
  /** Epoch ms of the scheduled arrival, so two options leaving together can be ranked. */
  endMs: number;
  /** Scheduled departure of the first vehicle (or of the walk, for an all-walk trip). */
  departure: LegTimeParts;
  /** Scheduled arrival at the far end. */
  arrival: LegTimeParts;
  /** `"48 min"`. */
  duration: string;
  /** `"1 change"` / `"direct"`. */
  transfers: string;
  /** `"08:36 → 09:24 · 48 min"` — the one line §12 says must be scannable. */
  scan: string;
  rides: CommuteRide[];
  connections: CommuteConnection[];
  /** `"6 min walk"` across the whole journey, or null when there is none worth saying. */
  walk: string | null;
  state: CommuteServiceState;
  /** Every notice on the journey, deduped — the collapsed row's warning. */
  disruptions: CommuteDisruption[];
  /** `"Tomorrow"` / `"Thursday 27 August"` when this is not today's departure. */
  dayNote: string | null;
}

/** The walk legs' total time, phrased only when it is worth a line. */
function walkLabel(trip: TransitTrip): string | null {
  const ms = trip.legs
    .filter((leg) => !isRideMode(leg.mode))
    .reduce((total, leg) => total + leg.durationMs, 0);
  const minutes = Math.round(ms / 60_000);
  return minutes >= 1 ? `${minutes} min walk` : null;
}

/** `"48 min"` / `"1 h 12 min"` — durations as a timetable prints them. */
export function commuteDurationLabel(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

const departureParts = (leg: TransitLeg): LegTimeParts =>
  legTimeParts({
    aimedMs: leg.aimedStartMs,
    expectedMs: leg.expectedStartMs,
    realtime: leg.realtime,
    predictionInaccurate: leg.startPredictionInaccurate,
  });

const arrivalParts = (leg: TransitLeg): LegTimeParts =>
  legTimeParts({
    aimedMs: leg.aimedEndMs,
    expectedMs: leg.expectedEndMs,
    realtime: leg.realtime,
    predictionInaccurate: leg.endPredictionInaccurate,
  });

/**
 * The whole journey, broken into what the dashboard states.
 *
 * The ends are read off the *ride* legs, not the trip: a journey that starts
 * with a three-minute walk to the stop begins, for timetable purposes, when the
 * bus leaves — that is the number printed at the stop, on the ticket and in
 * every other app. The walk is quoted separately as what it is.
 */
export function commuteJourney(trip: TransitTrip, nowMs: number, index = 0): CommuteJourney {
  const rideLegs = trip.legs.filter((leg) => isRideMode(leg.mode));
  const first = rideLegs[0] ?? trip.legs[0];
  const last = rideLegs[rideLegs.length - 1] ?? trip.legs[trip.legs.length - 1];

  const rides: CommuteRide[] = rideLegs.map((leg, rideIndex) => {
    const departure = departureParts(leg);
    const arrival = arrivalParts(leg);
    const key = `${leg.aimedStartMs}:${leg.line?.id ?? leg.mode}:${rideIndex}`;
    const stops = leg.intermediateStops.length;
    const notices = leg.situations.map((situation, situationIndex) =>
      commuteDisruption(situation, situationIndex, leg),
    );
    return {
      key,
      mode: leg.mode,
      modeLabel: TRANSIT_MODE_LABEL[leg.mode],
      line: leg.line?.publicCode || TRANSIT_MODE_LABEL[leg.mode],
      towards: leg.line?.headsign ?? null,
      operator: leg.line?.operator ?? null,
      from: leg.from.name,
      to: leg.to.name,
      fromQuay: quayLabel(leg.from),
      toQuay: quayLabel(leg.to),
      departure,
      arrival,
      window: `${departure.aimed} → ${arrival.aimed}`,
      ride: `${stops} ${stops === 1 ? 'stop' : 'stops'} · ${commuteDurationLabel(leg.durationMs)}`,
      state: serviceState(leg, departure),
      disruptions: notices,
    };
  });

  // A change is the gap between one vehicle's scheduled arrival and the next
  // one's scheduled departure — which is *not* the walk leg's duration between
  // them: the planner leaves slack, and the slack is the part that decides
  // whether a delayed train still connects.
  const connections: CommuteConnection[] = rides.slice(1).map((ride, changeIndex) => {
    const before = rideLegs[changeIndex]!;
    const after = rideLegs[changeIndex + 1]!;
    const waitMs = Math.max(0, after.aimedStartMs - before.aimedEndMs);
    const walkM = trip.legs
      .filter(
        (leg) =>
          !isRideMode(leg.mode) &&
          leg.aimedStartMs >= before.aimedEndMs &&
          leg.aimedEndMs <= after.aimedStartMs,
      )
      .reduce((total, leg) => total + leg.distanceM, 0);
    const at = before.to.name || after.from.name;
    const label = commuteDurationLabel(waitMs);
    const tight = waitMs < TIGHT_CONNECTION_MS;
    const walk = changeWalkLabel(walkM);
    return {
      key: `${ride.key}:change`,
      at,
      arrive: norwayClock(before.aimedEndMs),
      depart: norwayClock(after.aimedStartMs),
      waitMs,
      label,
      tight,
      walkM: Math.round(walkM),
      walk,
      chip: `${label} at ${at}`,
      summary: [`Change at ${at}`, label, walk, tight ? 'tight' : null].filter(Boolean).join(' · '),
    };
  });

  const departure = first
    ? departureParts(first)
    : legTimeParts({
        aimedMs: trip.startMs,
        expectedMs: trip.startMs,
        realtime: false,
      });
  const arrival = last
    ? arrivalParts(last)
    : legTimeParts({
        aimedMs: trip.endMs,
        expectedMs: trip.endMs,
        realtime: false,
      });
  const startMs = first?.aimedStartMs ?? trip.startMs;
  const endMs = last?.aimedEndMs ?? trip.endMs;
  // Duration between the *scheduled* ends, for the same reason the ends are
  // scheduled: "48 min" has to be the sum of the times printed beside it, or the
  // three numbers on the scan line contradict each other.
  const duration = commuteDurationLabel(endMs - startMs);

  const seen = new Set<string>();
  const disruptions = rides
    .flatMap((ride) => ride.disruptions)
    .filter((disruption) => {
      // One situation is attached to every leg it affects; a journey that rides
      // two legs of the same delayed line must not warn about it twice.
      if (seen.has(disruption.key)) return false;
      seen.add(disruption.key);
      return true;
    });

  return {
    key: `${startMs}:${index}`,
    trip,
    startMs,
    endMs,
    departure,
    arrival,
    duration,
    transfers: transfersLabel(Math.max(0, rides.length - 1)),
    scan: `${departure.aimed} → ${arrival.aimed} · ${duration}`,
    rides,
    connections,
    walk: walkLabel(trip),
    state: worstState(rides.map((ride) => ride.state)),
    disruptions,
    dayNote: norwayDayNote(nowMs, startMs),
  };
}

// -------------------------------------------------------------- segments ---

/**
 * One directed hop along the corridor: with stops A, B, C the dashboard shows
 * A→B, B→C, C→B and B→A, exactly as §8 asks.
 */
export interface CommuteSegment {
  /** `"outbound-0"` — stable across refreshes, so a board keeps its identity. */
  id: string;
  direction: TransitCommuteDirection;
  /** Position along that direction, 0-based. */
  index: number;
  from: TransitCommutePlace;
  to: TransitCommutePlace;
  /** `"Engelsrud terrasse → Asker stasjon"`. */
  label: string;
}

/**
 * The per-leg boards a commute generates, from its stops rather than from
 * hard-coded routes.
 *
 * A commute with **no interchange generates none**, and that is the point
 * rather than a gap: its only leg is the journey itself, so a "A→B" board
 * beneath a "next journeys" list of the same departures would be the same
 * timetable printed twice. The boards earn their place exactly when there is a
 * change — which is also when the traveller is mid-journey and wants only the
 * next leg.
 */
export function commuteSegments(query: TransitCommuteQuery): CommuteSegment[] {
  const stops = [query.from, ...query.via, query.to];
  if (stops.length < 3) return [];
  const hop = (
    direction: TransitCommuteDirection,
    index: number,
    from: TransitCommutePlace,
    to: TransitCommutePlace,
  ): CommuteSegment => ({
    id: `${direction}-${index}`,
    direction,
    index,
    from,
    to,
    label: `${from.name} → ${to.name}`,
  });
  const outbound = stops
    .slice(0, -1)
    .map((from, index) => hop('outbound', index, from, stops[index + 1]!));
  const back = [...stops].reverse();
  const inbound = back
    .slice(0, -1)
    .map((from, index) => hop('inbound', index, from, back[index + 1]!));
  return [...outbound, ...inbound];
}

/** One row of a per-leg departure board. */
export interface CommuteBoardRow {
  key: string;
  /** Epoch ms of the scheduled departure. */
  whenMs: number;
  /** **The** time — as the timetable prints it. Never replaced by an estimate. */
  aimed: string;
  /** Scheduled arrival at the far end of this hop. */
  arrival: string;
  /**
   * The live line beneath it: `"08:43 est."`, `"On time"`, `"Cancelled"` or
   * `"Timetable"` for a service with no live feed at all. Always present, so the
   * absence of live data reads as a fact rather than as an omission.
   */
  estimate: string;
  mode: TransitMode;
  line: string;
  towards: string | null;
  quay: string | null;
  /** `"in 6 min"`. */
  countdown: string;
  state: CommuteServiceState;
  disruptions: CommuteDisruption[];
  dayNote: string | null;
}

/** `"in 6 min"` / `"now"` / `"in 1 h 5 min"` — what a commuter actually reads. */
export function commuteCountdown(whenMs: number, nowMs: number): string {
  const minutes = Math.round((whenMs - nowMs) / 60_000);
  if (minutes <= 0) return 'now';
  return `in ${commuteDurationLabel(minutes * 60_000)}`;
}

/**
 * The live line under a scheduled time — §3's whole rule in one function.
 *
 * "08:41 / 08:43 est." and "08:41 / On time" say different things and both are
 * useful; "08:43" alone destroys the reference point the traveller is comparing
 * against, which is why this returns a label to put *beside* the time rather
 * than a replacement for it.
 */
export function commuteEstimateLabel(parts: LegTimeParts, cancelled: boolean): string {
  if (cancelled) return COMMUTE_STATE_LABEL.cancelled;
  if (parts.confidence === 'timetable') return COMMUTE_STATE_LABEL.scheduled;
  if (parts.delay) return `${parts.expected} est.`;
  return parts.confidence === 'uncertain' ? 'Live estimate uncertain' : COMMUTE_STATE_LABEL.live;
}

/**
 * One hop's journeys as a departure board.
 *
 * A row is built from a *trip* rather than from a raw departure call, which is
 * what lets it carry the arrival at the far end: an Entur stop board answers
 * "the 270 leaves at 08:36" and stops there, while the hop A→B knows it reaches
 * Asker at 09:02. The traveller never has to hold the second number in their
 * head, which is §12's core principle applied one level down.
 */
export function commuteBoardRows(
  result: TransitResult,
  nowMs: number,
  limit = 5,
): CommuteBoardRow[] {
  return (
    result.trips
      .map((trip) => {
        const ride = trip.legs.find((leg) => isRideMode(leg.mode));
        const lastRide = [...trip.legs].reverse().find((leg) => isRideMode(leg.mode));
        return { trip, ride, lastRide };
      })
      // An all-walk answer is a true answer to "how do I get from A to B", but it
      // is not a departure and belongs nowhere on a timetable board.
      .filter((entry): entry is { trip: TransitTrip; ride: TransitLeg; lastRide: TransitLeg } =>
        Boolean(entry.ride && entry.lastRide),
      )
      .map(({ trip, ride, lastRide }, index) => {
        const departure = departureParts(ride);
        const cancelled = ride.cancelled === true;
        const notices = ride.situations.map((situation, situationIndex) =>
          commuteDisruption(situation, situationIndex, ride),
        );
        return {
          key: `${ride.aimedStartMs}:${ride.line?.id ?? ride.mode}:${index}`,
          whenMs: ride.aimedStartMs,
          aimed: departure.aimed,
          arrival: norwayClock(lastRide.aimedEndMs),
          estimate: commuteEstimateLabel(departure, cancelled),
          mode: ride.mode,
          line: ride.line?.publicCode || TRANSIT_MODE_LABEL[ride.mode],
          towards: ride.line?.headsign ?? null,
          quay: ride.from.quay?.publicCode ?? null,
          countdown: cancelled
            ? COMMUTE_STATE_LABEL.cancelled
            : commuteCountdown(ride.aimedStartMs, nowMs),
          state: serviceState(ride, departure),
          disruptions: notices,
          dayNote: norwayDayNote(nowMs, ride.aimedStartMs),
          trip,
        };
      })
      // Entur returns journey options ranked, not chronologically — a B→C answer
      // measured on 2026-08-25 listed 08:49, 08:59, 09:09, **09:04**, 09:19. A
      // timetable out of time order is not a timetable.
      .sort((a, b) => a.whenMs - b.whenMs)
      .slice(0, limit)
      .map(({ trip: _trip, ...row }) => row)
  );
}

// ------------------------------------------------------------------ list ---

/**
 * The journeys as a board lists them: in time order, one row per departure.
 *
 * Both halves were measured against the live Engelsrud ↔ Nationaltheatret
 * corridor on 2026-08-25, and both are Entur answering a slightly different
 * question than a timetable asks.
 *
 *  - **In time order.** The planner returns options *ranked*, not chronological:
 *    that run listed 20:42, 20:29, 20:42, 20:59, 21:22. A list whose second row
 *    leaves before its first is not a timetable, and the reader who scans down
 *    it for "the one after that" is reading noise. (`commuteBoardRows` learned
 *    the same thing one level down.)
 *  - **One row per departure.** Two of those five were the same 20:42 bus,
 *    differing only in which train they caught at Asker — so the board printed
 *    "20:42" twice, once arriving 21:17 and once 21:35. That is not a choice
 *    anyone makes at Engelsrud: you board the same vehicle either way, and the
 *    later arrival is strictly worse. The earliest arrival stands for the
 *    departure, and the row's own legs say which train it means. A *different*
 *    first vehicle at the same minute is a real alternative and is kept, which
 *    is why the key is the vehicle and not just the clock.
 */
export function commuteJourneyList(journeys: readonly CommuteJourney[]): CommuteJourney[] {
  const ordered = [...journeys].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const seen = new Set<string>();
  return ordered.filter((journey) => {
    const first = journey.rides[0];
    const key = `${journey.startMs}:${first?.line ?? 'walk'}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ------------------------------------------------------------- leave now ---

/**
 * §11 — what you would catch by walking out of the door now, and what follows
 * it.
 *
 * The split is the dashboard's whole shape: `next` is the headline answer, and
 * `later` is the list beneath it. They were one list before, so the board
 * announced the 08:36 in full and then opened its journey list with the 08:36 —
 * the same departure twice on one screen, the duplicate sitting exactly where
 * "and if I miss it?" should have been.
 *
 * Both halves are filtered the same way, which is the other half of the point:
 * a journey that has already gone is not an option in a headline *or* in a
 * list, and the list used to show departures ten minutes into the past.
 */
export interface CommuteLeaveNow {
  next: CommuteJourney | null;
  /** Every catchable journey after `next`, in departure order. */
  later: CommuteJourney[];
}

export function commuteLeaveNow(
  journeys: readonly CommuteJourney[],
  nowMs: number,
): CommuteLeaveNow {
  // Compared against the *expected* departure, not the scheduled one: a bus
  // running four minutes late at 08:36 is still catchable at 08:38, and telling
  // someone otherwise sends them to a stop the vehicle has not reached.
  const upcoming = journeys.filter((journey) => journey.trip.startMs >= nowMs - DELAY_THRESHOLD_MS);
  return { next: upcoming[0] ?? null, later: upcoming.slice(1) };
}

// ---------------------------------------------------------------- header ---

/** `"Tuesday 25 August · 08:32"` — where the dashboard says when it is. */
export function commuteNowLabel(nowMs: number): string {
  return `${norwayDateLabel(nowMs)} · ${norwayClock(nowMs)}`;
}

/**
 * Whether the commute is one this weekday runs, and how to say it.
 *
 * A Saturday glance at a Mon–Fri commute must not read as "nothing runs" — the
 * timetable is fine, the commute simply is not today's. Returns null when there
 * is nothing to explain.
 */
export function commuteOffDayNote(
  days: readonly TransitWeekday[],
  weekday: TransitWeekday,
): string | null {
  if (days.length === 0 || days.includes(weekday)) return null;
  return 'This commute is not saved for today — showing the next departures anyway.';
}
