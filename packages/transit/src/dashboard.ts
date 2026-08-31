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
  expectedTimeLabel,
  quayLabel,
  transfersLabel,
  type LegTimeParts,
} from './labels.js';
import { isRideMode, type TransitCommuteDirection } from './model.js';
import type {
  TransitCommutePlace,
  TransitCommuteQuery,
  TransitCommuteResult,
  TransitLeg,
  TransitLine,
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
 * The two colours a line badge is painted in — the operator's own, when they
 * publish them.
 *
 * **This is identity, not status, and the distinction is the whole reason it is
 * a separate channel.** §10's rule — a colour may only come from what a service
 * *is* — was written about state, and a reader who learns that "red means
 * trouble" on this board would misread every Ruter bus in Oslo. So the two are
 * given different surfaces and never trade places: the badge's *fill* is the
 * line (the 280 is red because Ruter paints it red, delayed or not), and state
 * paints the badge's edge and the text beside it. A cancelled service is the one
 * case where identity yields, because a line you cannot board has no identity
 * worth advertising.
 *
 * Entur publishes `presentation.colour` for most Norwegian operators and a
 * `textColour` with it more often than not. Where the fill is published without
 * a legible foreground, one is chosen by luminance rather than defaulted to
 * white — Ruter's own yellow-on-white would otherwise be unreadable at 11 px.
 */
export interface CommuteLineBadge {
  /** `#RRGGBB` background. */
  fill: string;
  /** `#RRGGBB` foreground that is legible on {@link fill}. */
  text: string;
}

/**
 * The badge for a line with no published colours.
 *
 * Deliberately one neutral rather than a per-mode palette: a mode already has a
 * glyph, and inventing "bus red / train green" would put made-up branding next
 * to the real branding of every operator that does publish theirs — on the one
 * board whose job is to be trusted at 07:40.
 */
const NEUTRAL_LINE_BADGE: CommuteLineBadge = { fill: '#5a636c', text: '#ffffff' };

/**
 * Relative luminance, sRGB, as WCAG defines it — enough to choose between black
 * and white text on a colour an operator chose for a printed timetable.
 */
function luminance(hex: string): number {
  const channel = (offset: number) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

const HEX = /^#[0-9a-f]{6}$/i;

export function commuteLineBadge(line: TransitLine | undefined): CommuteLineBadge {
  const fill = line?.colour;
  if (!fill || !HEX.test(fill)) return NEUTRAL_LINE_BADGE;
  const text = line.textColour;
  if (text && HEX.test(text)) return { fill, text };
  return { fill, text: luminance(fill) > 0.45 ? '#101418' : '#ffffff' };
}

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
  /**
   * How long this vehicle is ridden, in ms — the ribbon's weight for this leg.
   *
   * A formatted `ride` string cannot be laid out proportionally, and a client
   * that parsed "12 min" back out of one would be a second implementation of
   * this number in a language that never sees the wire.
   */
  durationMs: number;
  /**
   * Scheduled departure and arrival as instants, beside the clock faces.
   *
   * Everything that has to *place* a ride in time — where "now" falls on the
   * ribbon, whether a board row is the one this journey already names — was
   * otherwise re-deriving them by filtering `trip.legs` for ride modes and
   * hoping the two lists stayed in step. They are the same legs in the same
   * order, so the instants belong on the ride.
   */
  startMs: number;
  endMs: number;
  /** {@link commuteLineBadge} — the operator's colours, or the neutral pair. */
  badge: CommuteLineBadge;
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

/**
 * The same journey on live times — what will actually happen, said as its own
 * labelled line rather than folded into the timetable's.
 *
 * §3 puts the scheduled time first and keeps the estimate beside it, and the
 * board honoured that for every clock *face* and for nothing else: a row's
 * travel time is scheduled arrival minus scheduled departure, so a delayed
 * journey printed `08:36 → 09:24 · 48 min` above a `+3` on its bus and left the
 * reader to work out whether the 48 already had the three minutes in it. It did
 * not, and could not — both its ends are timetable numbers — and there was
 * nothing on the row that said so either way.
 *
 * Stating the live window separately answers it without touching the primary
 * line: `48 min` is what the timetable promises, `08:39 → 09:27 est. · 48 min`
 * is what the feed says the same journey now is. Null when no feed corrects
 * either end, which is most journeys and exactly where a second line would be
 * noise.
 */
export interface CommuteJourneyLive {
  /** `"08:39"` — the expected departure of the first vehicle. */
  departure: string;
  /** `"09:27"` — the expected arrival of the last one. */
  arrival: string;
  /**
   * `"48 min"` — expected arrival minus expected departure: the travel time
   * **with the delay in it**, which is the number the scheduled one cannot be.
   */
  duration: string;
  /** `"08:39 → 09:27 est. · 48 min"` — the whole secondary line, composed once. */
  scan: string;
  /** The journey now takes longer than the timetable says it does. */
  slower: boolean;
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
  /**
   * The same two instants on live times — what {@link commuteJourneyList}
   * orders by, and what {@link live} is phrased from.
   *
   * Deliberately not `trip.startMs`, which is the *door*: that instant belongs
   * to the walk leg, and a walk does not move when the bus it feeds is nine
   * minutes late. A list ordered by it puts a delayed departure above one that
   * will physically leave first — the reordering that made this necessary.
   */
  expectedStartMs: number;
  expectedEndMs: number;
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
  /** {@link CommuteJourneyLive} — the same three numbers live, or null. */
  live: CommuteJourneyLive | null;
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

/**
 * The live window, or null when nothing is known to have moved.
 *
 * Both ends are checked, not just the departure: a bus that leaves three
 * minutes late and still makes its connection arrives on time, and the reader
 * asking "is the 48 minutes with or without the delay" is asking about exactly
 * that case.
 */
function journeyLive(
  departure: LegTimeParts,
  arrival: LegTimeParts,
  expectedStartMs: number,
  expectedEndMs: number,
  scheduledMs: number,
): CommuteJourneyLive | null {
  if (!departure.delay && !arrival.delay) return null;
  const liveMs = Math.max(0, expectedEndMs - expectedStartMs);
  const duration = commuteDurationLabel(liveMs);
  return {
    departure: departure.expected,
    arrival: arrival.expected,
    duration,
    // The "est." marks the pair of times, once — it is the same claim about
    // both, and repeating it on each would say there are two estimates here.
    scan: `${departure.expected} → ${expectedTimeLabel(arrival.expected)} · ${duration}`,
    slower: liveMs > scheduledMs,
  };
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
      durationMs: leg.durationMs,
      startMs: leg.aimedStartMs,
      endMs: leg.aimedEndMs,
      badge: commuteLineBadge(leg.line),
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
  const expectedStartMs = first?.expectedStartMs ?? trip.startMs;
  const expectedEndMs = last?.expectedEndMs ?? trip.endMs;
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
    expectedStartMs,
    expectedEndMs,
    departure,
    arrival,
    duration,
    transfers: transfersLabel(Math.max(0, rides.length - 1)),
    scan: `${departure.aimed} → ${arrival.aimed} · ${duration}`,
    live: journeyLive(departure, arrival, expectedStartMs, expectedEndMs, endMs - startMs),
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

/**
 * Where a direction's journey list starts — ROADMAP §6.4 §13, the middle
 * ground between the two ends of a saved commute.
 *
 * A commute is stored door to door, so the board could answer two questions:
 * Engelsrud → Nationaltheatret and back. But the day is full of the third one —
 * standing at Asker at 16:20, wanting the train in or the bus home, having not
 * started from either door. The Departures view already showed *that* hop as a
 * stop board; what it could not do is answer it the way the board answers
 * everything else, with a journey, a ribbon, a connection and something to
 * track.
 *
 * **It costs no upstream call.** The journeys from the interchange are the
 * corridor's last hop in that direction, which the dashboard already asks for
 * (`commuteSegmentQueries`) — so `segmentId` names the answer already in hand
 * rather than a question to go and ask.
 *
 * That is also the honest limit of it: the *last* hop is the only partial the
 * corridor's own boards contain. A commute through two interchanges would need
 * its own question to be asked from the first of them, and none is asked here.
 * Today's saved commute holds one `via`, so the last interchange is the only
 * one there is.
 */
export type CommuteOriginId = 'door' | 'interchange';

/** One choice of where the board starts, and the question that answers it. */
export interface CommuteOrigin {
  id: CommuteOriginId;
  /** Where the journeys start, where they must call, and where they end. */
  from: TransitCommutePlace;
  via: readonly TransitCommutePlace[];
  to: TransitCommutePlace;
  /** `"Asker stasjon → Nationaltheatret"` — the header for this board. */
  label: string;
  /** `"Asker stasjon"` — what the chip says, which is the stop it starts from. */
  chip: string;
  /**
   * The per-leg board its journeys are read from, or null for the whole
   * commute, which has an answer of its own.
   */
  segmentId: string | null;
}

/** The direction's stops in travel order: outbound as saved, inbound reversed. */
function directionStops(
  query: TransitCommuteQuery,
  direction: TransitCommuteDirection,
): TransitCommutePlace[] {
  const stops = [query.from, ...query.via, query.to];
  return direction === 'outbound' ? stops : [...stops].reverse();
}

/**
 * The starting points a direction offers: the commute's own end, and its last
 * interchange when it has one. A commute with no interchange offers a single
 * origin — the control is then a choice of one, and both clients hide it.
 */
export function commuteOrigins(
  query: TransitCommuteQuery,
  direction: TransitCommuteDirection,
): CommuteOrigin[] {
  const stops = directionStops(query, direction);
  const to = stops[stops.length - 1]!;
  const door: CommuteOrigin = {
    id: 'door',
    from: stops[0]!,
    via: stops.slice(1, -1),
    to,
    label: `${stops[0]!.name} → ${to.name}`,
    chip: stops[0]!.name,
    segmentId: null,
  };
  if (stops.length < 3) return [door];
  const from = stops[stops.length - 2]!;
  return [
    door,
    {
      id: 'interchange',
      from,
      via: [],
      to,
      label: `${from.name} → ${to.name}`,
      chip: from.name,
      // The corridor's last hop in this direction — `commuteSegments` numbers
      // its hops by the stop they leave, so the last one leaves the last
      // interchange. Derived from the same list rather than asserted, because
      // two definitions of a hop id is one definition too many.
      segmentId: `${direction}-${stops.length - 2}`,
    },
  ];
}

/**
 * The three ways to read one commute — ROADMAP §6.4 §13.
 *
 * This started as two controls: a direction (`Outbound` / `Return`) and, under
 * it, where the list starts (`Engelsrud Terrasse` / `Asker stasjon`). Two axes
 * is four states, and the two that matter are not opposite ends of either one.
 * Standing on the platform at Asker the question is not "which direction, read
 * from which end" — it is *what leaves from here*, in both directions at once:
 * the train in, and the bus home, which are the same glance.
 *
 * So the axes collapse into three modes. `outbound` and `inbound` are the
 * commute door to door as they always were; `interchange` is one mode that
 * lists **both** directions from the change, apart from each other, because a
 * list mixing a train towards Oslo with a bus towards home is a list nobody can
 * read. Two lists, one view — {@link commuteListings} is what draws them.
 */
export type CommuteMode = 'outbound' | 'interchange' | 'inbound';

/** `Outbound` / `Interchange` / `Return` — what the mode tab says. */
export function commuteModeChip(mode: CommuteMode): string {
  return mode === 'outbound' ? 'Outbound' : mode === 'inbound' ? 'Return' : 'Interchange';
}

/**
 * The modes a commute offers. The middle one needs an interchange to be *at*,
 * so a two-stop commute offers the two it always had — and both clients draw
 * exactly what comes back, rather than deciding for themselves.
 */
export function commuteModes(query: TransitCommuteQuery): CommuteMode[] {
  return query.via.length > 0 ? ['outbound', 'interchange', 'inbound'] : ['outbound', 'inbound'];
}

/**
 * One journey list the board draws: a direction, read from one of its ends.
 *
 * A door mode has exactly one; the interchange has two. Everything downstream
 * — the header, "if I leave now", the ribbon, the connections, the tracking —
 * follows the listing rather than a direction, which is what lets two of them
 * sit on one screen without either lying about what it contains.
 */
export interface CommuteListing {
  /** `"outbound:interchange"` — stable, and unique across the listings shown. */
  key: string;
  direction: TransitCommuteDirection;
  origin: CommuteOriginId;
  from: TransitCommutePlace;
  to: TransitCommutePlace;
  /** `"Asker stasjon → Nationaltheatret"` — the whole route this list answers. */
  label: string;
  /**
   * `"Towards Nationaltheatret"` — the heading a reader separates two lists by.
   *
   * Named by its destination and not by its direction word: at the interchange
   * "outbound" and "return" are the app's words for the commute, while the two
   * platforms are labelled with the places the vehicles are going to.
   */
  heading: string;
  /**
   * The eyebrow above the §11 card. You are not leaving the house from the
   * interchange — you are already standing on it, and a card that says "if I
   * leave now" over the next train from Asker is answering the wrong question.
   */
  leadLabel: string;
  /** The per-leg board its journeys are read from, or null for the whole commute. */
  segmentId: string | null;
}

/**
 * The lists a mode shows, in the order they are read.
 *
 * The interchange's pair is ordered by the clock, exactly as the board's own
 * direction is (`defaultCommuteDirection`): before the outbound departure the
 * way in comes first, after it the way home does. `primary` is that direction,
 * passed in rather than re-derived so the whole board agrees about what time
 * of day it is.
 */
export function commuteListings(
  query: TransitCommuteQuery,
  mode: CommuteMode,
  primary: TransitCommuteDirection,
): CommuteListing[] {
  const directions: TransitCommuteDirection[] =
    mode !== 'interchange'
      ? [mode]
      : primary === 'inbound'
        ? ['inbound', 'outbound']
        : ['outbound', 'inbound'];
  const wanted: CommuteOriginId = mode === 'interchange' ? 'interchange' : 'door';
  return directions.flatMap((direction) => {
    // Through `commuteOrigins`, never by re-deriving the stops: which hop the
    // interchange list reads from is one fact, and two ways of computing it is
    // one too many.
    const origin = commuteOrigins(query, direction).find((option) => option.id === wanted);
    if (!origin) return [];
    return [
      {
        key: `${direction}:${origin.id}`,
        direction,
        origin: origin.id,
        from: origin.from,
        to: origin.to,
        label: origin.label,
        heading: `Towards ${origin.to.name}`,
        leadLabel: origin.id === 'door' ? 'If I leave now' : 'Next from here',
        segmentId: origin.segmentId,
      },
    ];
  });
}

/**
 * The panel header for a mode: the route for a door mode, the stop you are
 * standing at for the interchange — whose two lists carry their own headings
 * and would otherwise have to be summarised into a route that is not one.
 */
export function commuteModeTitle(
  query: TransitCommuteQuery,
  mode: CommuteMode,
  primary: TransitCommuteDirection,
): string {
  const listings = commuteListings(query, mode, primary);
  if (listings.length === 0) return 'Commute';
  return mode === 'interchange' ? `From ${listings[0]!.from.name}` : listings[0]!.label;
}

/**
 * The stop every answered journey changes at, or null when they do not agree.
 *
 * §13's middle ground and §5's per-leg boards both hang off the saved `via`, so
 * a commute saved end to end has neither — and a corridor that changes at Asker
 * on every single journey offers no way to be read *from* Asker, with nothing
 * on screen to say why. This reads the interchange back off the answer the
 * board already holds, so the app can offer to save what the journeys have been
 * saying all along instead of waiting to be told.
 *
 * Unanimous or nothing, because a `via` is a *constraint* on the planner and
 * not an annotation: offering one that only most journeys use would quietly
 * delete the rest. A direct journey, or one that changes somewhere else, is
 * proof that this corridor's change is not a fact about the corridor. Two
 * changes in one journey are refused for the reason `commuteOrigins` stops at
 * one interchange — the saved commute holds a single `via`.
 *
 * No `stopId`: a trip answer names its places, it does not identify them. The
 * caller resolves the name against the stop search before saving it, which is
 * also what keeps the line picker working (it can only ask a stop for its
 * lines, never a coordinate).
 */
export function commuteInterchange(
  result: Pick<TransitCommuteResult, 'outbound' | 'inbound'> | null | undefined,
): TransitCommutePlace | null {
  const trips = [...(result?.outbound.trips ?? []), ...(result?.inbound.trips ?? [])];
  if (trips.length === 0) return null;
  let found: TransitCommutePlace | null = null;
  for (const trip of trips) {
    const rides = trip.legs.filter((leg) => isRideMode(leg.mode));
    if (rides.length !== 2) return null;
    const change = rides[0]!.to;
    // Both halves must name the same stop. A "change" whose arrival and
    // departure are at different places is a walk between two stops, and there
    // is no single one of them to stand at or to save.
    if (change.name !== rides[1]!.from.name) return null;
    if (found && found.name !== change.name) return null;
    found ??= { name: change.name, lat: change.position.lat, lng: change.position.lng };
  }
  return found;
}

/** One row of a per-leg departure board. */
export interface CommuteBoardRow {
  key: string;
  /** Epoch ms of the scheduled departure. */
  whenMs: number;
  /**
   * Epoch ms of the *expected* departure — what the board is ordered by and
   * what its countdown counts to, for the same reason the journey list is
   * (`commuteJourneyList`): the clock face is the timetable's, the order is the
   * vehicles'.
   */
  expectedMs: number;
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
  /** {@link commuteLineBadge} — the same colours the journey ribbon paints. */
  badge: CommuteLineBadge;
  quay: string | null;
  /** `"in 6 min"` — to the *expected* departure, which is when it will be here. */
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
  if (parts.delay) return expectedTimeLabel(parts.expected);
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
          expectedMs: ride.expectedStartMs,
          aimed: departure.aimed,
          arrival: norwayClock(lastRide.aimedEndMs),
          estimate: commuteEstimateLabel(departure, cancelled),
          mode: ride.mode,
          line: ride.line?.publicCode || TRANSIT_MODE_LABEL[ride.mode],
          towards: ride.line?.headsign ?? null,
          badge: commuteLineBadge(ride.line),
          quay: ride.from.quay?.publicCode ?? null,
          // A countdown is not a clock face: "in 6 min" is a claim about when
          // the vehicle will be here, so it follows the live prediction while
          // `aimed` above keeps §3's printed reference point. A row reading
          // "08:41 · 08:44 est. · in 2 min" says one coherent thing; the same
          // row counting to 08:41 sends someone out of the door for a bus that
          // is three minutes away from arriving.
          countdown: cancelled
            ? COMMUTE_STATE_LABEL.cancelled
            : commuteCountdown(ride.expectedStartMs, nowMs),
          state: serviceState(ride, departure),
          disruptions: notices,
          dayNote: norwayDayNote(nowMs, ride.aimedStartMs),
          trip,
        };
      })
      // Entur returns journey options ranked, not chronologically — a B→C answer
      // measured on 2026-08-25 listed 08:49, 08:59, 09:09, **09:04**, 09:19. A
      // timetable out of time order is not a timetable. Ordered on the live
      // departure, like the journey list above it, so the top row is the next
      // vehicle rather than the next timetabled one.
      .sort((a, b) => a.expectedMs - b.expectedMs || a.whenMs - b.whenMs)
      .slice(0, limit)
      .map(({ trip: _trip, ...row }) => row)
  );
}

// ------------------------------------------------------------------ list ---

/**
 * The journeys as a board lists them: in the order the vehicles actually leave,
 * one row per departure.
 *
 * Three decisions, each measured against the live Engelsrud ↔ Nationaltheatret
 * corridor, and each one Entur answering a slightly different question than a
 * timetable asks.
 *
 *  - **In time order.** The planner returns options *ranked*, not chronological:
 *    a run on 2026-08-25 listed 20:42, 20:29, 20:42, 20:59, 21:22. A list whose
 *    second row leaves before its first is not a timetable, and the reader who
 *    scans down it for "the one after that" is reading noise. (`commuteBoardRows`
 *    learned the same thing one level down.)
 *  - **On live times, not timetabled ones.** The order is the one the vehicles
 *    leave in — `expectedStartMs` — while every printed clock face stays
 *    scheduled, which is §3 and is not in tension with this: §3 is about what a
 *    row *says*, and a row that says 08:36 is not thereby a claim about what
 *    leaves first. The board sorted by the timetable and then picked its
 *    headline off the *expected* departure (`commuteLeaveNow`), so a nine-minute
 *    delay put a bus that had not left below one that had, and the headline
 *    announced a departure listed second. Two answers to "what leaves next" on
 *    one screen is the confusion this closes; the delayed row explains its own
 *    position through {@link CommuteJourneyLive}.
 *  - **One row per departure.** Two of those five were the same 20:42 bus,
 *    differing only in which train they caught at Asker — so the board printed
 *    "20:42" twice, once arriving 21:17 and once 21:35. That is not a choice
 *    anyone makes at Engelsrud: you board the same vehicle either way, and the
 *    later arrival is strictly worse. The earliest arrival stands for the
 *    departure — earliest *live* arrival, so the survivor cannot change
 *    identity between two refreshes that agree about the timetable — and the
 *    row's own legs say which train it means. A *different* first vehicle at
 *    the same minute is a real alternative and is kept, which is why the key is
 *    the vehicle and not just the clock.
 */
export function commuteJourneyList(journeys: readonly CommuteJourney[]): CommuteJourney[] {
  const ordered = [...journeys].sort(
    (a, b) =>
      a.expectedStartMs - b.expectedStartMs ||
      a.startMs - b.startMs ||
      a.expectedEndMs - b.expectedEndMs ||
      a.endMs - b.endMs,
  );
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
  //
  // `next` is simply the first survivor, which is only the right headline
  // because the list is already in live order (`commuteJourneyList`). Filtering
  // on the live clock while ordering on the timetabled one is what used to make
  // the headline a departure the list showed second.
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

// ---------------------------------------------------------------- ribbon ---

/**
 * The journey drawn as one bar — the board's answer to "what am I actually
 * taking", before a single digit is read.
 *
 * **Why this replaced a strip of chips.** The collapsed row used to carry
 * `[🚌 280 08:36 → 09:02] [⇄ 9 min at Asker] [🚆 L1 09:11 → 09:24]`: three
 * bordered pills of near-identical text that wrapped onto two or three lines in
 * a 360 px panel. Every journey in the list then looked like every other one,
 * and the two facts a commuter reads first — *which vehicles, and how the time
 * splits between them* — had to be assembled out of six clock times. Five such
 * rows is thirty numbers to answer "the one after next".
 *
 * A ribbon states the same journey as a shape: each part is as wide as it is
 * long, the vehicles carry the operator's own colours, and the change is a
 * literal gap between them. Proportion is the information the chips could not
 * hold, and it is free — the durations were already on the model.
 *
 * The parts are generated here rather than in either client for the usual
 * reason this package exists: two hand-laid-out ribbons are two ribbons that
 * disagree about a nine-minute change on the morning it matters.
 */
export type CommuteRibbonPart = CommuteRibbonSpan &
  (
    | {
        kind: 'ride';
        mode: TransitMode;
        /** `"280"`, `"R14"` — what is on the front of the vehicle. */
        line: string;
        /** `"+3"` on the leg actually running late, or null. */
        delay: string | null;
        state: CommuteServiceState;
        badge: CommuteLineBadge;
      }
    | {
        kind: 'change';
        /** `"6m"` — the wait, short enough to sit inside the gap. */
        label: string;
        /** Planned, but with little enough slack to be worth flagging. */
        tight: boolean;
        /**
         * The numbers say this change no longer holds
         * (`commuteConnectionBreak`). Passed in rather than computed, because
         * the break lives one layer up with the commitment it is judged
         * against.
         */
        broken: boolean;
      }
  );

/** What every part of the ribbon carries: how wide it is, and what it spans. */
interface CommuteRibbonSpan {
  key: string;
  /** Minutes — the flex weight this part is laid out with. */
  weight: number;
  /** The scheduled instants this part covers, so "now" can be placed inside it. */
  fromMs: number;
  toMs: number;
}

/**
 * The smallest weight a part may claim.
 *
 * A two-minute platform change between two twenty-minute rides is 4% of the
 * bar, which rounds to nothing and leaves two vehicles apparently touching. The
 * floor costs the rides a little proportionality and buys the reader the one
 * thing the gap exists to show — that there *is* a change.
 */
const MIN_RIBBON_WEIGHT = 4;

const ribbonWeight = (ms: number) => Math.max(MIN_RIBBON_WEIGHT, Math.round(ms / 60_000));

export function commuteRibbon(
  journey: CommuteJourney,
  options: { brokenIndex?: number | null } = {},
): CommuteRibbonPart[] {
  const parts: CommuteRibbonPart[] = [];
  journey.rides.forEach((ride, index) => {
    const change = journey.connections[index - 1];
    const previous = journey.rides[index - 1];
    if (change && previous) {
      parts.push({
        kind: 'change',
        key: change.key,
        weight: ribbonWeight(change.waitMs),
        fromMs: previous.endMs,
        toMs: ride.startMs,
        // Minutes without the unit: this label sits inside a gap that is often
        // 20 px wide, and "6 min" does not fit where "6m" does.
        label: `${Math.round(change.waitMs / 60_000)}m`,
        tight: change.tight,
        broken: options.brokenIndex === index,
      });
    }
    parts.push({
      kind: 'ride',
      key: ride.key,
      weight: ribbonWeight(ride.durationMs),
      fromMs: ride.startMs,
      toMs: ride.endMs,
      mode: ride.mode,
      line: ride.line,
      // The correction belongs on the vehicle carrying it: on a bus→train
      // commute, "the bus is nine late" and "the train is nine late" are
      // different mornings, and a row-level `+9 min` cannot tell them apart.
      delay: ride.departure.delay ? ride.departure.delay.replace(' min', '') : null,
      state: ride.state,
      badge: ride.badge,
    });
  });
  return parts;
}

/**
 * How far through a journey a moment is, as a percentage of the ribbon.
 *
 * Measured on the ribbon's own weights rather than on elapsed minutes, because
 * the two disagree: `MIN_RIBBON_WEIGHT` widens short changes, so a marker
 * placed by clock time drifts off the part it is meant to be inside — and a
 * "you are here" mark standing in the wrong leg is worse than no mark.
 */
export function commuteRibbonProgress(
  parts: readonly CommuteRibbonPart[],
  nowMs: number,
): number | null {
  const total = parts.reduce((sum, part) => sum + part.weight, 0);
  const first = parts[0];
  const last = parts[parts.length - 1];
  if (total === 0 || !first || !last) return null;
  if (nowMs <= first.fromMs) return null;
  if (nowMs >= last.toMs) return 100;
  let before = 0;
  for (const part of parts) {
    if (nowMs < part.toMs) {
      const span = part.toMs - part.fromMs;
      const through = span > 0 ? (nowMs - part.fromMs) / span : 1;
      return ((before + part.weight * Math.max(0, Math.min(1, through))) / total) * 100;
    }
    before += part.weight;
  }
  return 100;
}

/**
 * The notices every listed journey carries, lifted out of the rows.
 *
 * A corridor-wide notice — "signal problems between Asker and Sandvika" — is
 * attached by the operator to every service on the corridor, so a board that
 * paints it per row prints the same amber sentence five times and pushes two
 * journeys off the screen with it. Said once, above the list, it is context;
 * said five times it is noise that hides the row-specific notice underneath.
 *
 * Only notices on *every* listed journey are lifted. One that affects three
 * departures out of five is a fact about those three, and moving it would tell
 * the reader the other two are affected too.
 */
export function commuteSharedDisruptions(journeys: readonly CommuteJourney[]): CommuteDisruption[] {
  if (journeys.length < 2) return [];
  const [first, ...rest] = journeys;
  return (first?.disruptions ?? []).filter((disruption) =>
    rest.every((journey) => journey.disruptions.some((other) => other.key === disruption.key)),
  );
}
