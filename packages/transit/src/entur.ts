import { decodePolyline, type LatLng } from '@atlas/core';
import { expandModeFilter } from './model.js';
import type {
  TransitBooking,
  TransitBookingMethod,
  TransitDeparture,
  TransitDeparturesQuery,
  TransitDeparturesResult,
  TransitLeg,
  TransitLine,
  TransitMode,
  TransitPlace,
  TransitProblem,
  TransitProblemCode,
  TransitQuery,
  TransitResult,
  TransitSeverity,
  TransitSituation,
  TransitTrip,
} from './model.js';

/**
 * Entur Journey Planner v3 adapter — Norway's national journey planner
 * (`https://api.entur.io/journey-planner/v3/graphql`), covering every operator
 * with real-time data, free under NLOD and requiring **no API key**. The one
 * hard requirement is an `ET-Client-Name` header identifying the consumer;
 * Entur throttles callers who omit it, which is why the request is proxied by
 * the backend (see `backend/src/transit-api.ts`) rather than issued from the
 * browser — the header and the rate limit stay ours to control.
 *
 * Wire notes:
 *  - Times are **ISO 8601 strings with a zone offset**, parsed to epoch ms here
 *    so nothing downstream has to think about Oslo's summer time.
 *  - Distances are metres, durations **seconds**; durations become ms.
 *  - Leg geometry is `pointsOnLink.points`, a **precision-5** Google polyline —
 *    not Valhalla's precision 6. Decoding it at 6 puts Asker in the Atlantic.
 *  - `tripPatterns: []` is a valid answer meaning "no service then", not a
 *    failure. Only a transport or GraphQL error throws.
 */

/** GraphQL document. Kept as one string so the recorded fixtures pin the exact field set. */
export const ENTUR_TRIP_QUERY = `query Trip($from:Location!,$to:Location!,$via:[TripViaLocationInput!],$dateTime:DateTime,$arriveBy:Boolean!,$num:Int!,$walkSpeed:Float,$modes:Modes,$searchWindow:Int,$pageCursor:String){
 trip(from:$from,to:$to,via:$via,dateTime:$dateTime,arriveBy:$arriveBy,numTripPatterns:$num,walkSpeed:$walkSpeed,modes:$modes,searchWindow:$searchWindow,pageCursor:$pageCursor){
  nextPageCursor previousPageCursor
  routingErrors{ code inputField }
  tripPatterns{ expectedStartTime expectedEndTime duration walkDistance emission{co2}
   legs{ mode distance duration realtime
    aimedStartTime expectedStartTime aimedEndTime expectedEndTime
    pointsOnLink{points}
    line{ publicCode name presentation{colour textColour} }
    authority{name}
    fromEstimatedCall{ destinationDisplay{frontText} }
    fromPlace{ name latitude longitude quay{id publicCode name} }
    toPlace{ name latitude longitude quay{id publicCode name} }
    intermediateEstimatedCalls{ aimedDepartureTime expectedDepartureTime quay{id publicCode name latitude longitude} }
    situations{ situationNumber severity reportType summary{value language} description{value language} advice{value language} infoLinks{uri} }
    bookingArrangements{ bookingMethods latestBookingTime latestBookingDay bookingNote bookingContact{phone url} }
   }}}}`;

const DEPARTURE_FIELDS = `id name latitude longitude
 estimatedCalls(startTime:$start,timeRange:3600,numberOfDepartures:$limit,arrivalDeparture:departures,includeCancelledTrips:true){
  aimedDepartureTime expectedDepartureTime realtime cancellation forBoarding
  destinationDisplay{frontText}
  quay{id publicCode name}
  serviceJourney{id publicCode transportMode line{publicCode name presentation{colour textColour} operator{name}}}
  situations{ situationNumber severity reportType summary{value language} description{value language} advice{value language} infoLinks{uri} }
 }`;

/** Exact-stop board: used when an Entur search result retained its NSR StopPlace id. */
export const ENTUR_STOP_DEPARTURES_QUERY = `query StopDepartures($id:String!,$start:DateTime,$limit:Int!){
 stopPlace(id:$id){${DEPARTURE_FIELDS}}
}`;

/**
 * Coordinate fallback for map pins, saved places and ordinary search results.
 * `nearest` selects a StopPlace rather than one quay so the answer includes
 * every platform/stand at an interchange, not whichever side of the road was
 * a few metres closer.
 */
export const ENTUR_NEAREST_DEPARTURES_QUERY = `query NearestDepartures($lat:Float!,$lng:Float!,$start:DateTime,$limit:Int!){
 nearest(latitude:$lat,longitude:$lng,maximumDistance:1500,maximumResults:1,filterByPlaceTypes:[stopPlace],filterByInUse:true,first:1){
  edges{node{distance place{... on StopPlace{${DEPARTURE_FIELDS}}}}}
 }
}`;

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 10;
const DEFAULT_DEPARTURE_LIMIT = 30;
const MAX_DEPARTURE_LIMIT = 50;
const DEFAULT_WALK_SPEED_MPS = 1.3;

/**
 * Atlas ride modes as Entur's `TransportMode` enum values. `coach` and `bus`
 * stay distinct here because the wire keeps them distinct; they are merged into
 * one *control* by `expandModeFilter`, not by flattening the vocabulary.
 */
const WIRE_MODE: Partial<Record<TransitMode, string>> = {
  bus: 'bus',
  coach: 'coach',
  tram: 'tram',
  metro: 'metro',
  rail: 'rail',
  water: 'water',
  air: 'air',
  funicular: 'funicular',
  cableway: 'cableway',
};

/**
 * The `modes` argument for a ride-mode selection, or null to let Entur use all
 * of them. Access, egress and direct modes stay `foot`: choosing transit means
 * "walking *and* vehicles", and the walk to the stop is not negotiable.
 *
 * An empty selection is treated as no filter rather than as "no transport at
 * all" — a filter that can silently return nothing is a trap, and the UI
 * prevents it too by refusing to unselect the last mode.
 */
function modesArgument(modes: readonly TransitMode[] | undefined): Record<string, unknown> | null {
  if (!modes || modes.length === 0) return null;
  const transportModes = expandModeFilter(modes).flatMap((mode) => {
    const wire = WIRE_MODE[mode];
    return wire ? [{ transportMode: wire }] : [];
  });
  if (transportModes.length === 0) return null;
  return { accessMode: 'foot', egressMode: 'foot', directMode: 'foot', transportModes };
}

/** Prefer an exact NSR stop, retaining coordinates in Atlas for fallback and coverage only. */
function locationArgument(location: TransitQuery['from']): Record<string, unknown> {
  return location.stopId
    ? { place: location.stopId }
    : { coordinates: { latitude: location.lat, longitude: location.lng } };
}

/** Build the GraphQL request body for a journey query. */
export function buildEnturRequest(query: TransitQuery): {
  query: string;
  variables: Record<string, unknown>;
} {
  const limit = Math.min(Math.max(Math.trunc(query.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
  return {
    query: ENTUR_TRIP_QUERY,
    variables: {
      from: locationArgument(query.from),
      to: locationArgument(query.to),
      via:
        query.via && query.via.length > 0
          ? query.via.map((place) => ({
              visit: {
                ...(place.stopId
                  ? { stopLocationIds: [place.stopId] }
                  : { coordinate: { latitude: place.lat, longitude: place.lng } }),
                minimumWaitTime: 'PT0S',
              },
            }))
          : null,
      // Omitted entirely when unset so Entur applies its own "now".
      dateTime: query.dateTimeMs === undefined ? null : new Date(query.dateTimeMs).toISOString(),
      arriveBy: query.arriveBy ?? false,
      num: limit,
      walkSpeed: query.walkSpeedMps ?? DEFAULT_WALK_SPEED_MPS,
      modes: modesArgument(query.modes),
      // Null lets Entur pick its own (dynamic, a few hours). Widened only on a
      // retry — see WIDE_SEARCH_WINDOW_MINUTES.
      searchWindow: query.searchWindowMinutes ?? null,
      pageCursor: query.pageCursor ?? null,
    },
  };
}

/** Build a next-hour departure-board request, preferring an exact NSR stop id. */
export function buildEnturDeparturesRequest(query: TransitDeparturesQuery): {
  query: string;
  variables: Record<string, unknown>;
} {
  const limit = Math.min(
    Math.max(Math.trunc(query.limit ?? DEFAULT_DEPARTURE_LIMIT), 1),
    MAX_DEPARTURE_LIMIT,
  );
  // `startTime` must be *absent*, not null, when we mean "now". `trip(dateTime:)`
  // tolerates an explicit null; `estimatedCalls(startTime:)` does not — Entur's
  // resolver reads the argument unconditionally and a null one crashes it
  // server-side, which arrives as a GraphQL error and would make every board
  // ("Departures" on a card, with no time chosen) look like a network failure.
  const common: Record<string, unknown> = { limit };
  if (query.startTimeMs !== undefined) {
    common.start = new Date(query.startTimeMs).toISOString();
  }
  return query.stopId
    ? {
        query: ENTUR_STOP_DEPARTURES_QUERY,
        variables: { ...common, id: query.stopId },
      }
    : {
        query: ENTUR_NEAREST_DEPARTURES_QUERY,
        variables: { ...common, lat: query.lat, lng: query.lng },
      };
}

/** Entur transport modes Atlas renders; anything else degrades to `unknown`. */
const MODES: Record<string, TransitMode> = {
  foot: 'foot',
  bus: 'bus',
  coach: 'coach',
  tram: 'tram',
  metro: 'metro',
  rail: 'rail',
  water: 'water',
  air: 'air',
  funicular: 'funicular',
  cableway: 'cableway',
  lift: 'cableway',
};

function toMode(value: unknown): TransitMode {
  return (typeof value === 'string' && MODES[value.toLowerCase()]) || 'unknown';
}

/** Parse an ISO timestamp to epoch ms; `NaN`-safe, falling back to `fallback`. */
function toMs(value: unknown, fallback = 0): number {
  if (typeof value !== 'string') return fallback;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : fallback;
}

function toNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Entur sends colours as bare hex (`"DF2027"`); CSS needs the `#`. */
function toColour(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const hex = value.trim().replace(/^#/, '');
  return /^[0-9a-fA-F]{6}$/.test(hex) ? `#${hex}` : undefined;
}

interface WirePlace {
  name?: unknown;
  latitude?: unknown;
  longitude?: unknown;
  quay?: { id?: unknown; publicCode?: unknown; name?: unknown } | null;
}

function toPlace(wire: WirePlace | null | undefined): TransitPlace {
  const quay = wire?.quay;
  const place: TransitPlace = {
    name: typeof wire?.name === 'string' ? wire.name : '',
    position: { lat: toNumber(wire?.latitude), lng: toNumber(wire?.longitude) },
  };
  if (quay) {
    const parsed = {
      ...(typeof quay.id === 'string' ? { id: quay.id } : {}),
      ...(typeof quay.publicCode === 'string' ? { publicCode: quay.publicCode } : {}),
      ...(typeof quay.name === 'string' ? { name: quay.name } : {}),
    };
    if (Object.keys(parsed).length > 0) place.quay = parsed;
  }
  return place;
}

function toLine(wire: unknown, authority: unknown): TransitLine | undefined {
  if (!wire || typeof wire !== 'object') return undefined;
  const line = wire as {
    publicCode?: unknown;
    name?: unknown;
    presentation?: { colour?: unknown; textColour?: unknown } | null;
  };
  const operator = (authority as { name?: unknown } | null)?.name;
  // A line with no public code is unnameable in a UI; fall back to its long
  // name so the leg still says *something* rather than rendering an empty chip.
  const publicCode =
    typeof line.publicCode === 'string' && line.publicCode.trim()
      ? line.publicCode
      : typeof line.name === 'string'
        ? line.name
        : '';
  return {
    publicCode,
    ...(typeof line.name === 'string' ? { name: line.name } : {}),
    ...(typeof operator === 'string' ? { operator } : {}),
    ...(toColour(line.presentation?.colour) ? { colour: toColour(line.presentation?.colour) } : {}),
    ...(toColour(line.presentation?.textColour)
      ? { textColour: toColour(line.presentation?.textColour) }
      : {}),
  };
}

function toQuay(wire: unknown): TransitDeparture['quay'] {
  const quay = (wire ?? {}) as { id?: unknown; publicCode?: unknown; name?: unknown };
  return {
    ...(typeof quay.id === 'string' ? { id: quay.id } : {}),
    ...(typeof quay.publicCode === 'string' && quay.publicCode.trim()
      ? { publicCode: quay.publicCode }
      : {}),
    ...(typeof quay.name === 'string' && quay.name.trim() ? { name: quay.name } : {}),
  };
}

/**
 * Pick a language out of Entur's `MultilingualString` list. Norwegian first,
 * English next, then whatever exists: operators publish `no` reliably and `en`
 * only sometimes, and an untranslated Norwegian warning beats no warning.
 */
function toText(wire: unknown): string | undefined {
  // Not everything Entur calls text is multilingual — `bookingNote` is a bare
  // String while `summary` is a list of translations.
  if (typeof wire === 'string') return wire.trim() ? wire : undefined;
  if (!Array.isArray(wire)) {
    const single = (wire as { value?: unknown } | null)?.value;
    return typeof single === 'string' && single.trim() ? single : undefined;
  }
  const strings = wire.filter(
    (item): item is { value: string; language?: string } =>
      typeof (item as { value?: unknown })?.value === 'string' &&
      (item as { value: string }).value.trim().length > 0,
  );
  const pick =
    strings.find((s) => s.language === 'no' || s.language === 'nb' || s.language === 'nn') ??
    strings.find((s) => s.language === 'en') ??
    strings[0];
  return pick?.value;
}

/**
 * Entur's eight-value `Severity` folded onto the three Atlas paints. `noImpact`
 * and the two "slight" grades are information; `normal` and below are a warning;
 * only `severe`/`verySevere` earn red. `unknown`/`undefined` land on `warning`
 * rather than `info`: an unclassified notice from an operator is more often a
 * cancellation than a footnote, and under-warning is the costlier mistake.
 */
function toSeverity(value: unknown): TransitSeverity {
  switch (value) {
    case 'noImpact':
    case 'verySlight':
    case 'slight':
      return 'info';
    case 'severe':
    case 'verySevere':
      return 'severe';
    default:
      return 'warning';
  }
}

function toSituations(wire: unknown): TransitSituation[] {
  if (!Array.isArray(wire)) return [];
  return wire.flatMap((item) => {
    const s = item as Record<string, unknown>;
    const summary = toText(s.summary) ?? toText(s.description);
    // A notice with nothing to read is not worth an alarm icon.
    if (!summary) return [];
    const description = toText(s.description);
    const advice = toText(s.advice);
    const uri = Array.isArray(s.infoLinks)
      ? (s.infoLinks as { uri?: unknown }[]).map((l) => l?.uri).find((u) => typeof u === 'string')
      : undefined;
    return [
      {
        ...(typeof s.situationNumber === 'string' ? { id: s.situationNumber } : {}),
        summary,
        // The description often just repeats the summary; drop it when it does,
        // so an expanded notice does not read as a stutter.
        ...(description && description !== summary ? { description } : {}),
        ...(advice ? { advice } : {}),
        severity: toSeverity(s.severity),
        ...(typeof uri === 'string' ? { url: uri } : {}),
      },
    ];
  });
}

const BOOKING_METHODS: readonly TransitBookingMethod[] = [
  'callDriver',
  'callOffice',
  'online',
  'phoneAtStop',
  'text',
];

function toBooking(wire: unknown): TransitBooking | undefined {
  if (!wire || typeof wire !== 'object') return undefined;
  const b = wire as Record<string, unknown>;
  const methods = (Array.isArray(b.bookingMethods) ? b.bookingMethods : []).filter(
    (m): m is TransitBookingMethod => BOOKING_METHODS.includes(m as TransitBookingMethod),
  );
  const note = toText(b.bookingNote);
  const contact = (b.bookingContact ?? null) as { phone?: unknown; url?: unknown } | null;
  const latestTime = typeof b.latestBookingTime === 'string' ? b.latestBookingTime : undefined;
  // Entur sends an (often empty) arrangement on ordinary legs too. Only a leg
  // that says *how* or *by when* to book actually requires booking; anything
  // less would slap a "must be booked" warning on every scheduled bus.
  if (methods.length === 0 && !note && !latestTime) return undefined;
  const dayOffset = b.latestBookingDay;
  return {
    methods,
    ...(note ? { note } : {}),
    ...(typeof contact?.phone === 'string' ? { phone: contact.phone } : {}),
    ...(typeof contact?.url === 'string' ? { url: contact.url } : {}),
    ...(latestTime ? { latestTime } : {}),
    ...(typeof dayOffset === 'number' ? { latestDayOffset: dayOffset } : {}),
  };
}

const PROBLEM_CODES: readonly TransitProblemCode[] = [
  'locationNotFound',
  'noStopsInRange',
  'noTransitConnection',
  'noTransitConnectionInSearchWindow',
  'outsideBounds',
  'outsideServicePeriod',
  'walkingBetterThanTransit',
];

function toProblems(wire: unknown): TransitProblem[] {
  if (!Array.isArray(wire)) return [];
  return wire.map((item) => {
    const e = item as { code?: unknown; inputField?: unknown };
    const code = PROBLEM_CODES.includes(e.code as TransitProblemCode)
      ? (e.code as TransitProblemCode)
      : 'unknown';
    const field = e.inputField;
    return {
      code,
      ...(field === 'from' || field === 'to' || field === 'dateTime' ? { inputField: field } : {}),
    };
  });
}

/**
 * `emission { co2 }` in grams of CO₂ per passenger, or null when Entur has no
 * figure for the services involved. Negative or non-finite values are treated
 * as no answer: they can only be a data fault, and a journey advertised as
 * carbon-negative would be a lie that reads as a feature.
 */
function toCo2(wire: unknown): number | null {
  const co2 = (wire as { co2?: unknown } | null)?.co2;
  return typeof co2 === 'number' && Number.isFinite(co2) && co2 >= 0 ? co2 : null;
}

function toPoints(wire: unknown): LatLng[] {
  const encoded = (wire as { points?: unknown } | null)?.points;
  if (typeof encoded !== 'string' || !encoded) return [];
  // Precision 5 — Entur uses the classic Google encoding, not Valhalla's 6.
  return decodePolyline(encoded, 5).map(([lat, lng]) => ({ lat, lng }));
}

function toLeg(wire: Record<string, unknown>): TransitLeg {
  const aimedStartMs = toMs(wire.aimedStartTime);
  const aimedEndMs = toMs(wire.aimedEndTime);
  const line = toLine(wire.line, wire.authority);
  const headsign = (
    wire.fromEstimatedCall as { destinationDisplay?: { frontText?: unknown } | null } | null
  )?.destinationDisplay?.frontText;
  if (line && typeof headsign === 'string' && headsign.trim()) line.headsign = headsign;

  const calls = Array.isArray(wire.intermediateEstimatedCalls)
    ? wire.intermediateEstimatedCalls
    : [];
  const booking = toBooking(wire.bookingArrangements);
  return {
    mode: toMode(wire.mode),
    distanceM: toNumber(wire.distance),
    durationMs: toNumber(wire.duration) * 1000,
    aimedStartMs,
    // Real-time fields fall back to the timetable rather than to 0 — a missing
    // live update means "on time as far as anyone knows", not "epoch".
    expectedStartMs: toMs(wire.expectedStartTime, aimedStartMs),
    aimedEndMs,
    expectedEndMs: toMs(wire.expectedEndTime, aimedEndMs),
    realtime: wire.realtime === true,
    from: toPlace(wire.fromPlace as WirePlace),
    to: toPlace(wire.toPlace as WirePlace),
    ...(line ? { line } : {}),
    intermediateStops: calls.map((call) => {
      const quay = (call as { quay?: WirePlace } | null)?.quay;
      return toPlace({ ...quay, quay: quay ?? null });
    }),
    points: toPoints(wire.pointsOnLink),
    situations: toSituations(wire.situations),
    ...(booking ? { booking } : {}),
  };
}

/** Thrown when Entur cannot be reached or answers with GraphQL errors. */
export class TransitError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'TransitError';
  }
}

/**
 * Entur's way of saying the coordinate has no stop near it: a resolver error on
 * the `nearest` field carrying OTP's LOCATION_NOT_FOUND. Matched on the field
 * *and* the code so a genuine upstream fault still reaches the user as one.
 */
function isNoStopNearbyError(error: { message?: unknown; path?: unknown }): boolean {
  const onNearest = Array.isArray(error.path) && error.path[0] === 'nearest';
  return (
    onNearest && typeof error.message === 'string' && error.message.includes('LOCATION_NOT_FOUND')
  );
}

/**
 * Map either exact-stop or nearest-stop Entur GraphQL output onto one board.
 * Drop-off-only calls are excluded: a departure a traveller cannot board is
 * operationally real but does not belong on their board.
 */
export function parseEnturDeparturesResponse(body: unknown): TransitDeparturesResult {
  const root = body as {
    errors?: { message?: unknown; path?: unknown }[];
    data?: {
      stopPlace?: unknown;
      nearest?: { edges?: unknown } | null;
    } | null;
  } | null;
  if (Array.isArray(root?.errors) && root.errors.length > 0) {
    // "There is no stop within 1500 m" is not a failure, but Entur reports it as
    // one: `nearest` raises LOCATION_NOT_FOUND instead of resolving to an empty
    // edge list. Left as a thrown error it would tell someone standing on a
    // mountain to check their connection, so it becomes the empty board the
    // cards already have copy for.
    if (root.errors.every(isNoStopNearbyError)) return { stop: null, departures: [] };
    const first = root.errors[0]?.message;
    throw new TransitError(typeof first === 'string' ? first : 'departure board error');
  }

  let distanceM: number | undefined;
  let stopWire = root?.data?.stopPlace;
  if (!stopWire) {
    const edges = root?.data?.nearest?.edges;
    const node = Array.isArray(edges)
      ? ((edges[0] as { node?: { distance?: unknown; place?: unknown } } | undefined)?.node ?? null)
      : null;
    stopWire = node?.place;
    if (typeof node?.distance === 'number' && Number.isFinite(node.distance)) {
      distanceM = node.distance;
    }
  }
  if (!stopWire || typeof stopWire !== 'object') return { stop: null, departures: [] };

  const wire = stopWire as Record<string, unknown>;
  const id = typeof wire.id === 'string' ? wire.id : '';
  const name = typeof wire.name === 'string' ? wire.name : '';
  const calls = Array.isArray(wire.estimatedCalls) ? wire.estimatedCalls : [];
  const departures = calls.flatMap((item): TransitDeparture[] => {
    if (!item || typeof item !== 'object') return [];
    const call = item as Record<string, unknown>;
    if (call.forBoarding === false) return [];
    const aimedDepartureMs = toMs(call.aimedDepartureTime);
    const service = (call.serviceJourney ?? {}) as Record<string, unknown>;
    const line = toLine(
      service.line,
      (service.line as { operator?: unknown } | null)?.operator,
    ) ?? {
      publicCode:
        typeof service.publicCode === 'string' && service.publicCode.trim()
          ? service.publicCode
          : '—',
    };
    const destination = (call.destinationDisplay as { frontText?: unknown } | null)?.frontText;
    const quay = toQuay(call.quay);
    const serviceId = typeof service.id === 'string' ? service.id : line.publicCode;
    return [
      {
        id: `${serviceId}:${quay.id ?? ''}:${aimedDepartureMs}`,
        mode: toMode(service.transportMode),
        aimedDepartureMs,
        expectedDepartureMs: toMs(call.expectedDepartureTime, aimedDepartureMs),
        realtime: call.realtime === true,
        cancelled: call.cancellation === true,
        destination:
          typeof destination === 'string' && destination.trim()
            ? destination
            : 'Destination unknown',
        line,
        quay,
        situations: toSituations(call.situations),
      },
    ];
  });
  departures.sort((a, b) => a.expectedDepartureMs - b.expectedDepartureMs);
  return {
    stop: {
      id,
      name,
      position: { lat: toNumber(wire.latitude), lng: toNumber(wire.longitude) },
      ...(distanceM === undefined ? {} : { distanceM }),
    },
    departures,
  };
}

/**
 * Map an Entur GraphQL response onto the shared trip model. Throws
 * `TransitError` on a GraphQL-level error; an empty `tripPatterns` is passed
 * through as an empty result, because "nothing runs at 01:00" is an answer.
 */
export function parseEnturResponse(body: unknown): TransitResult {
  const root = body as {
    errors?: { message?: unknown }[];
    data?: {
      trip?: {
        tripPatterns?: unknown;
        routingErrors?: unknown;
        nextPageCursor?: unknown;
        previousPageCursor?: unknown;
      } | null;
    } | null;
  } | null;

  if (Array.isArray(root?.errors) && root.errors.length > 0) {
    const first = root.errors[0]?.message;
    throw new TransitError(typeof first === 'string' ? first : 'journey planner error');
  }
  const trip = root?.data?.trip;
  const problems = toProblems(trip?.routingErrors);
  const cursors = {
    ...(typeof trip?.nextPageCursor === 'string' ? { nextCursor: trip.nextPageCursor } : {}),
    ...(typeof trip?.previousPageCursor === 'string'
      ? { previousCursor: trip.previousPageCursor }
      : {}),
  };
  const patterns = trip?.tripPatterns;
  if (!Array.isArray(patterns)) return { trips: [], problems, ...cursors };

  const trips: TransitTrip[] = patterns.map((pattern) => {
    const p = pattern as Record<string, unknown>;
    const legs = (Array.isArray(p.legs) ? p.legs : []).map((leg) =>
      toLeg(leg as Record<string, unknown>),
    );
    const co2 = toCo2(p.emission);
    return {
      // Prefer the legs' own times: the pattern-level fields agree with them,
      // and deriving keeps a trip internally consistent if Entur ever disagrees.
      startMs: legs[0]?.expectedStartMs ?? toMs(p.expectedStartTime),
      endMs: legs[legs.length - 1]?.expectedEndMs ?? toMs(p.expectedEndTime),
      durationMs: toNumber(p.duration) * 1000,
      walkDistanceM: toNumber(p.walkDistance),
      // Entur only knows the emission of some services; a journey it cannot
      // account for is left absent rather than quoted as a suspiciously green
      // zero. Walk legs carry no figure at all, which is why an all-walk trip
      // has none either — "0 g" would be true but is not what null means here.
      ...(co2 === null ? {} : { co2Grams: co2 }),
      legs,
    };
  });
  return { trips, problems, ...cursors };
}
