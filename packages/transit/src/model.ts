import type { LatLng } from '@atlas/core';

/**
 * Public transport is a *travel mode*, not a fifth `RoutingProfile`, and this
 * file is where that decision lives. A transit journey is an ordered set of
 * timed legs alternating walk and ride — "walk 5 min to Bondi, board the 280 at
 * quay C 07:42, alight Asker 08:01, walk to track 3, R14 to Nationaltheatret" —
 * and none of that survives a `RoutePath`, which holds one geometry and one
 * duration. Three further properties separate it from routing proper:
 *
 *  - **Timetable-bound.** Every other profile answers "how do I get there".
 *    This one answers "how do I get there *leaving at 07:30*", and the answer
 *    expires. Times, not distances, are the primary quantity.
 *  - **Online-only** — a genuine, deliberate exception to Atlas's offline-first
 *    rule. A cached timetable is a lie the moment a bus is cancelled, so the
 *    absence of network must be *stated* by the UI, never papered over.
 *  - **Norway-only**, because Entur is a national planner. Per the NVDB
 *    precedent every such feature needs a defined non-Norway behaviour; here
 *    it is `transitCoverage()` below — the mode is offered only where it can
 *    answer, and is otherwise absent rather than shown-and-failing.
 */

/**
 * How a leg is travelled. `foot` is the walk to, from and between stops; the
 * rest are Entur transport modes folded into the set Atlas renders an icon for.
 * Unrecognised wire values become `unknown` rather than being dropped — a leg
 * with no icon still has a departure time worth showing.
 */
export type TransitMode =
  | 'foot'
  | 'bus'
  | 'coach'
  | 'tram'
  | 'metro'
  | 'rail'
  | 'water'
  | 'air'
  | 'funicular'
  | 'cableway'
  | 'unknown';

/** Modes that are ridden rather than walked — the legs that carry a line and a quay. */
export function isRideMode(mode: TransitMode): boolean {
  return mode !== 'foot';
}

/**
 * A boarding or alighting point. `quay` is the specific platform/track/stand —
 * the part travellers actually need ("track 3"), and the part most journey
 * planners bury. Absent for walk-leg endpoints that are just coordinates.
 */
export interface TransitPlace {
  /** Stop place name, e.g. `"Asker stasjon"`. Origin/destination legs use the query's own label. */
  name: string;
  position: LatLng;
  quay?: TransitQuay;
}

/** A platform, track or bus stand within a stop place. */
export interface TransitQuay {
  /** Stable NSR id, e.g. `"NSR:Quay:11234"` — safe to persist and re-query. */
  id?: string;
  /** What the sign says: `"2"`, `"3"`, `"C"`. The only part worth rendering large. */
  publicCode?: string;
  name?: string;
}

/** The service being ridden. */
export interface TransitLine {
  /** What the traveller calls it and what is on the front of the vehicle: `"280"`, `"R14"`. */
  publicCode: string;
  /** Full line name, e.g. `"Asker-Oslo S-Kongsvinger"`. */
  name?: string;
  /** Operating authority, e.g. `"Ruter"`, `"Vy"`. */
  operator?: string;
  /** Where the vehicle is headed — disambiguates direction at a two-way stop. */
  headsign?: string;
  /** Official line colour as `#RRGGBB` (Entur sends it bare; normalised here). */
  colour?: string;
  /** Legible foreground for `colour`, also `#RRGGBB`. */
  textColour?: string;
}

/** One leg of a journey: a walk, or a ride on one vehicle. */
export interface TransitLeg {
  mode: TransitMode;
  distanceM: number;
  durationMs: number;
  /**
   * Timetabled and real-time-adjusted departure/arrival, both epoch ms. They
   * are equal when nothing is known to be off schedule; the difference is the
   * delay, which is why both are kept rather than collapsed to one.
   */
  aimedStartMs: number;
  expectedStartMs: number;
  aimedEndMs: number;
  expectedEndMs: number;
  /** True when `expected*` is backed by a live feed rather than just echoing the timetable. */
  realtime: boolean;
  from: TransitPlace;
  to: TransitPlace;
  /** Present on ride legs only. */
  line?: TransitLine;
  /** Stops passed through without a change — for an expandable "12 stops" row. */
  intermediateStops: TransitPlace[];
  /** Leg geometry, for drawing the journey on the map. */
  points: LatLng[];
}

/** One complete door-to-door journey option. */
export interface TransitTrip {
  /** Epoch ms, real-time adjusted — when the traveller must actually leave. */
  startMs: number;
  endMs: number;
  durationMs: number;
  /** Total metres on foot across all walk legs — the number that decides comfort. */
  walkDistanceM: number;
  legs: TransitLeg[];
}

/** Departure delay against the timetable, in ms. Negative means running early. */
export function legDelayMs(leg: TransitLeg): number {
  return leg.expectedStartMs - leg.aimedStartMs;
}

/** Number of vehicle changes — ride legs minus one, and 0 for an all-walk trip. */
export function transferCount(trip: TransitTrip): number {
  const rides = trip.legs.filter((leg) => isRideMode(leg.mode)).length;
  return rides > 0 ? rides - 1 : 0;
}

/**
 * The line codes in ride order, e.g. `["280", "R14"]` — the one-line summary a
 * result list leads with, because it is how people describe the journey to
 * themselves.
 */
export function tripLineCodes(trip: TransitTrip): string[] {
  return trip.legs.flatMap((leg) => (leg.line ? [leg.line.publicCode] : []));
}

/** A journey request in app terms, decoupled from Entur's GraphQL. */
export interface TransitQuery {
  from: LatLng;
  to: LatLng;
  /**
   * Epoch ms to plan around; defaults to now at the server. Interpreted as the
   * desired *departure* unless `arriveBy` is set, in which case it is the
   * latest acceptable arrival.
   */
  dateTimeMs?: number;
  arriveBy?: boolean;
  /** How many journey options to return (default 5, capped at 10 by the client). */
  limit?: number;
  /**
   * Walking speed in m/s (default 1.3). Worth exposing: the difference between
   * 1.0 and 1.5 changes which connections are reachable at all.
   */
  walkSpeedMps?: number;
  /**
   * Ride modes the traveller will accept, e.g. `['bus', 'tram']` — omitted or
   * empty means all of them. `foot` is not listed: walking to and between stops
   * is part of every journey and cannot be excluded, which is exactly what
   * separates this mode from the `foot` routing profile.
   */
  modes?: readonly TransitMode[];
  /**
   * How far past `dateTimeMs` to look for departures, in minutes. Omitted means
   * "let the planner decide", which is a dynamic window of a few hours — fine
   * on a busy corridor, but on a sparse route it reports *no service* when the
   * next bus is simply tomorrow morning. See `WIDE_SEARCH_WINDOW_MINUTES`.
   */
  searchWindowMinutes?: number;
}

/**
 * The ride modes a filter should offer, in presentation order.
 *
 * Deliberately *not* every value of `TransitMode`: a filter chip is a promise
 * that unticking it changes the answer, so a mode with no Norwegian services
 * behind it is a dead control. Measured against Entur's `lines(transportModes:)`
 * on 2026-07-21 — bus 4160, water 257, air 104 (all Avinor), rail 50, coach 47,
 * tram 9, metro 5, cableway 1, **funicular 0**. So `funicular` is absent here
 * while remaining in `TransitMode` and the wire parser: Fløibanen and its kin
 * are registered under other modes today, and a leg that ever does arrive as
 * one must still render rather than fall through to `unknown`.
 *
 * `taxi`, `trolleybus` and `monorail` exist in Entur's enum but are likewise
 * not offered — the first is demand-responsive rather than timetabled, the
 * other two have no Norwegian services at all.
 */
export const RIDE_MODES: readonly TransitMode[] = [
  'bus',
  'coach',
  'tram',
  'metro',
  'rail',
  'water',
  'air',
  'cableway',
];

/**
 * A journey answer. `trips` is empty when the planner found nothing — a normal
 * outcome at 01:00, not an error, and the UI must say "no departures" rather
 * than "something went wrong".
 */
export interface TransitResult {
  trips: TransitTrip[];
}

/**
 * Mainland Norway, generously boxed (Lindesnes to Nordkapp, Utsira to the
 * Russian border). Deliberately excludes Svalbard and Jan Mayen: Entur has no
 * journey-planner coverage there, so offering the mode would be a promise the
 * planner cannot keep.
 */
const NORWAY_BBOX = { minLat: 57.5, maxLat: 71.4, minLng: 4.0, maxLng: 31.6 } as const;

/**
 * Whether one point is somewhere the planner can answer for. Exported because
 * a UI must decide whether to *offer* the mode before both endpoints exist:
 * "we don't know your destination yet" and "this is outside Norway" are
 * different answers, and hiding the mode for the first reads as the app having
 * no public transport at all.
 */
export function transitCoversPoint(point: LatLng): boolean {
  return (
    point.lat >= NORWAY_BBOX.minLat &&
    point.lat <= NORWAY_BBOX.maxLat &&
    point.lng >= NORWAY_BBOX.minLng &&
    point.lng <= NORWAY_BBOX.maxLng
  );
}

const inNorway = transitCoversPoint;

/**
 * The look-ahead used when the planner's own window came back empty: a full day,
 * so "nothing runs then" only ever means nothing runs in the next 24 hours.
 * Not used on the first attempt — a wide window costs the planner real work,
 * and on a busy corridor the default already answers.
 */
export const WIDE_SEARCH_WINDOW_MINUTES = 24 * 60;

/**
 * Whether a transit answer is possible for these endpoints — the defined
 * non-Norway behaviour the NVDB precedent requires. A bounding box is
 * intentionally coarse: it over-covers Sweden's and Finland's border regions,
 * where Entur genuinely does return cross-border journeys, and the honest
 * failure for a spurious hit is an empty result the UI already handles. The
 * alternative (silently offering a mode that always fails abroad) is worse.
 */
export function transitCoverage(from: LatLng, to: LatLng): boolean {
  return inNorway(from) && inNorway(to);
}
