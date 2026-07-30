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

/**
 * How badly a disruption bites. Entur's `Severity` enum has eight values, most
 * of which no operator distinguishes in practice; they are folded into the
 * three a traveller acts on differently — read later, read now, this journey
 * may not happen.
 */
export type TransitSeverity = 'info' | 'warning' | 'severe';

/**
 * A disruption notice attached to a leg: cancelled trains, replacement buses,
 * a closed platform. Entur carries these on every ride leg and Atlas ignored
 * them until now, which is the worst failure mode a journey planner has — a
 * confident departure time for a service that has been cancelled since
 * midnight. `summary` is the headline; `advice` is what the operator wants you
 * to *do*, and is usually the only actionable sentence.
 */
export interface TransitSituation {
  /** Entur's situation number, stable enough to dedupe repeats across legs. */
  id?: string;
  summary: string;
  description?: string;
  advice?: string;
  severity: TransitSeverity;
  /** Operator's own page about the disruption, when they published one. */
  url?: string;
}

/** How a bookable service is booked, in the words a traveller needs. */
export type TransitBookingMethod = 'callDriver' | 'callOffice' | 'online' | 'phoneAtStop' | 'text';

/**
 * Booking requirements for flexible transport — Norway's `bestillingstransport`,
 * where the bus only runs if someone rings ahead. Rendering such a leg as an
 * ordinary departure is a promise the timetable cannot keep: turn up at the
 * stop without booking and nothing comes. Present only on legs that need it.
 */
export interface TransitBooking {
  methods: TransitBookingMethod[];
  /** Free-text instructions from the operator. */
  note?: string;
  phone?: string;
  url?: string;
  /** Latest clock time a booking is accepted, e.g. `"14:00"`. */
  latestTime?: string;
  /** How many days before departure `latestTime` refers to; 0 means same day. */
  latestDayOffset?: number;
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
  /** Live disruption notices for this leg; empty when the service is running normally. */
  situations: TransitSituation[];
  /** Present only when the leg must be booked in advance to run at all. */
  booking?: TransitBooking;
}

/** The worst severity anywhere in a journey — what a summary row should warn at. */
export function tripSeverity(trip: TransitTrip): TransitSeverity | null {
  const rank: Record<TransitSeverity, number> = { info: 0, warning: 1, severe: 2 };
  let worst: TransitSeverity | null = null;
  for (const leg of trip.legs) {
    for (const situation of leg.situations) {
      if (!worst || rank[situation.severity] > rank[worst]) worst = situation.severity;
    }
  }
  return worst;
}

/** Whether any leg has to be booked ahead — a journey-level caveat, not a leg detail. */
export function tripNeedsBooking(trip: TransitTrip): boolean {
  return trip.legs.some((leg) => leg.booking !== undefined);
}

/** One complete door-to-door journey option. */
export interface TransitTrip {
  /** Epoch ms, real-time adjusted — when the traveller must actually leave. */
  startMs: number;
  endMs: number;
  durationMs: number;
  /** Total metres on foot across all walk legs — the number that decides comfort. */
  walkDistanceM: number;
  /**
   * Grams of CO₂ per passenger for the whole journey, when the planner can
   * account for every service on it. Absent means "not known", never "none":
   * only a figure the operator data actually supports is worth quoting next to
   * a mode comparison that a car would otherwise win by feel.
   */
  co2Grams?: number;
  legs: TransitLeg[];
}

/** West/south/east/north extent used to frame a journey on either map. */
export type TransitTripBounds = [west: number, south: number, east: number, north: number];

/**
 * Bounds of every leg geometry, falling back to the named leg endpoints when
 * a planner omits a shape. The fallback keeps “Show on map” useful for sparse
 * timetable answers without inventing a route line that was never supplied.
 */
export function transitTripBounds(trip: TransitTrip): TransitTripBounds | null {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const leg of trip.legs) {
    const points = leg.points.length > 0 ? leg.points : [leg.from.position, leg.to.position];
    for (const point of points) {
      west = Math.min(west, point.lng);
      south = Math.min(south, point.lat);
      east = Math.max(east, point.lng);
      north = Math.max(north, point.lat);
    }
  }
  return Number.isFinite(west) && west !== east && south !== north
    ? [west, south, east, north]
    : null;
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

/**
 * One end of a journey. Coordinates are always retained for coverage checks,
 * map framing and a safe fallback; `stopId` pins the query to the exact NSR
 * StopPlace selected in Entur search instead of re-snapping that coordinate.
 */
export interface TransitLocation extends LatLng {
  stopId?: string;
}

/**
 * One departure shown on a stop board. This deliberately reuses the same line,
 * quay and disruption models as a ride leg: "R14 to Kongsvinger, platform 2,
 * six minutes late" must mean the same thing before and after a destination is
 * chosen.
 */
export interface TransitDeparture {
  /** Stable-enough row identity: service journey + quay + aimed departure. */
  id: string;
  mode: TransitMode;
  aimedDepartureMs: number;
  expectedDepartureMs: number;
  realtime: boolean;
  cancelled: boolean;
  destination: string;
  line: TransitLine;
  quay: TransitQuay;
  situations: TransitSituation[];
}

/** The stop whose board was selected, either exactly by NSR id or nearest to a coordinate. */
export interface TransitDepartureStop {
  id: string;
  name: string;
  position: LatLng;
  /** Present only for a nearest-stop lookup; exact stop selections are already at their stop. */
  distanceM?: number;
}

/**
 * A stop-board request. `stopId` wins when present; coordinates remain required
 * for Norway coverage and are the explicit fallback for pins, saved places and
 * other targets that do not carry National Stop Register identity.
 */
export interface TransitDeparturesQuery extends TransitLocation {
  /** Start of the one-hour board window; omitted means Entur's current time. */
  startTimeMs?: number;
  /** Maximum rows returned after time filtering (default 30, capped at 50). */
  limit?: number;
}

/** The next-hour board for one stop. `stop: null` means no stop was found nearby. */
export interface TransitDeparturesResult {
  stop: TransitDepartureStop | null;
  departures: TransitDeparture[];
}

/** A journey request in app terms, decoupled from Entur's GraphQL. */
export interface TransitQuery {
  from: TransitLocation;
  to: TransitLocation;
  /**
   * Ordered places the journey must visit. Unlike a visual waypoint, each one
   * is sent to the timetable planner, so a saved commute through an
   * interchange (for example Asker) cannot silently bypass it.
   */
  via?: readonly TransitLocation[];
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
  /**
   * An opaque cursor from a previous answer's `nextCursor`/`previousCursor`,
   * for paging to later or earlier departures. Strictly better than re-querying
   * at a nudged time, which is what Atlas used to do: the planner knows where
   * its own page ended, so nothing is skipped or shown twice at the seam. When
   * set, the planner ignores `dateTimeMs`, `arriveBy` and `searchWindowMinutes`.
   */
  pageCursor?: string;
}

/** A named favorite used as one end (or interchange) of a saved commute. */
export interface TransitCommutePlace extends TransitLocation {
  name: string;
}

/**
 * The deliberately narrow service filter for a regular commute. Bus lines are
 * allow-listed; trains are allowed only when none of their calls matches an
 * excluded stop. Other ride modes are rejected so an apparently suitable
 * result cannot quietly substitute a tram or ferry.
 */
export interface TransitCommuteFilter {
  allowedBusLines: readonly string[];
  excludedRailStops: readonly string[];
}

/** One saved, reversible commute between favorites. */
export interface TransitCommuteQuery extends TransitCommuteFilter {
  from: TransitCommutePlace;
  via: readonly TransitCommutePlace[];
  to: TransitCommutePlace;
  /** Journey options Entur should inspect before applying the strict filter. */
  limit?: number;
}

/** Filtered upcoming journeys in both directions. */
export interface TransitCommuteResult {
  outbound: TransitResult;
  inbound: TransitResult;
}

/**
 * Ride modes that one filter chip stands for. Entur separates `bus` from
 * `coach` because the operators sell them separately, but nobody plans a
 * journey wanting local buses and refusing the long-distance coach that runs
 * the same corridor — as a *control* it is one button, so the chip labelled
 * Bus sends both. The distinction survives in `TransitMode` and on the wire,
 * so a coach leg still says which it was.
 */
const FILTER_MEMBERS: Partial<Record<TransitMode, readonly TransitMode[]>> = {
  bus: ['bus', 'coach'],
};

/** The wire modes a chip selection means, expanding grouped chips like Bus. */
export function expandModeFilter(modes: readonly TransitMode[]): TransitMode[] {
  return modes.flatMap((mode) => FILTER_MEMBERS[mode] ?? [mode]);
}

/** The chip a leg's mode belongs under, so a coach leg lights up the Bus chip. */
export function filterModeOf(mode: TransitMode): TransitMode {
  for (const [chip, members] of Object.entries(FILTER_MEMBERS)) {
    if (members.includes(mode)) return chip as TransitMode;
  }
  return mode;
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
 *
 * `coach` is absent as a *chip* but present in the filter: see `FILTER_MEMBERS`.
 * `air` stays despite looking exotic on a map app — those 104 lines are real
 * scheduled Avinor-served flights, and on a Bodø–Tromsø query the planner
 * genuinely answers with one.
 */
export const RIDE_MODES: readonly TransitMode[] = [
  'bus',
  'tram',
  'metro',
  'rail',
  'water',
  'air',
  'cableway',
];

/**
 * Why the planner returned nothing. Entur distinguishes nine cases and they
 * call for different reactions from the traveller — "no service in this search
 * window" means try another time, "no stops in range" means walk somewhere
 * else, "outside service period" means the timetable does not reach that date
 * yet. Folding them all into "no departures found" sends people hunting for a
 * departure that was never going to exist.
 */
export type TransitProblemCode =
  | 'locationNotFound'
  | 'noStopsInRange'
  | 'noTransitConnection'
  | 'noTransitConnectionInSearchWindow'
  | 'outsideBounds'
  | 'outsideServicePeriod'
  | 'walkingBetterThanTransit'
  | 'unknown';

export interface TransitProblem {
  code: TransitProblemCode;
  /** Which end of the query it concerns, when the planner says. */
  inputField?: 'from' | 'to' | 'dateTime';
}

/**
 * A journey answer. `trips` is empty when the planner found nothing — a normal
 * outcome at 01:00, not an error, and the UI must say "no departures" rather
 * than "something went wrong". `problems` says *which* nothing it was.
 */
export interface TransitResult {
  trips: TransitTrip[];
  problems: TransitProblem[];
  /** Cursors for the Later / Earlier controls; absent when the planner has no more pages. */
  nextCursor?: string;
  previousCursor?: string;
}

/**
 * A traveller-facing sentence for an empty answer. Returns null when the
 * planner gave no reason, leaving the caller's own generic wording in place.
 */
export function transitProblemMessage(problems: readonly TransitProblem[]): string | null {
  const codes = new Set(problems.map((p) => p.code));
  if (codes.has('outsideBounds') || codes.has('locationNotFound')) {
    return 'One of the stops is outside the area the Norwegian journey planner covers.';
  }
  if (codes.has('noStopsInRange')) {
    return 'No stops within walking distance of one of the ends. Try a nearby street or town.';
  }
  if (codes.has('outsideServicePeriod')) {
    return 'The timetable does not reach that date yet. Try a date closer to today.';
  }
  if (codes.has('noTransitConnectionInSearchWindow')) {
    return 'Nothing runs at that time, though the route is served at others. Try another time.';
  }
  if (codes.has('noTransitConnection')) {
    return 'No public transport connects these two places.';
  }
  if (codes.has('walkingBetterThanTransit')) {
    return 'Walking is faster than any departure here.';
  }
  return null;
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
 * The look-ahead escalation for an empty answer, widest last.
 *
 * Measured against live Entur (Engelsrud → Nationaltheatret, asked 22:30, the
 * evening case that made this necessary): the default window costs 1.2 s and
 * finds nothing, 6 h costs 1.2 s, 12 h costs 3.3 s and a full day costs 7.5 s —
 * all three returning the *same* first journey, 03:20. Cost scales with the
 * width, so jumping straight to 24 h pays six times over for an answer a few
 * hours out and lands close enough to the proxy's 10 s upstream timeout to fail
 * intermittently. Stepping asks the cheap question first and keeps the full day
 * as the backstop for a genuinely sparse route (Å i Lofoten → Svolvær), where
 * the next departure really is tomorrow.
 */
export const SEARCH_WINDOW_RETRY_MINUTES: readonly number[] = [6 * 60, WIDE_SEARCH_WINDOW_MINUTES];

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
