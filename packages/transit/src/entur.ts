import { decodePolyline, type LatLng } from '@atlas/core';
import { expandModeFilter } from './model.js';
import type {
  TransitBooking,
  TransitBookingMethod,
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
export const ENTUR_TRIP_QUERY = `query Trip($from:Location!,$to:Location!,$dateTime:DateTime,$arriveBy:Boolean!,$num:Int!,$walkSpeed:Float,$modes:Modes,$searchWindow:Int,$pageCursor:String){
 trip(from:$from,to:$to,dateTime:$dateTime,arriveBy:$arriveBy,numTripPatterns:$num,walkSpeed:$walkSpeed,modes:$modes,searchWindow:$searchWindow,pageCursor:$pageCursor){
  nextPageCursor previousPageCursor
  routingErrors{ code inputField }
  tripPatterns{ expectedStartTime expectedEndTime duration walkDistance
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

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 10;
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

/** Build the GraphQL request body for a journey query. */
export function buildEnturRequest(query: TransitQuery): {
  query: string;
  variables: Record<string, unknown>;
} {
  const limit = Math.min(Math.max(Math.trunc(query.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
  return {
    query: ENTUR_TRIP_QUERY,
    variables: {
      from: { coordinates: { latitude: query.from.lat, longitude: query.from.lng } },
      to: { coordinates: { latitude: query.to.lat, longitude: query.to.lng } },
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
    return {
      // Prefer the legs' own times: the pattern-level fields agree with them,
      // and deriving keeps a trip internally consistent if Entur ever disagrees.
      startMs: legs[0]?.expectedStartMs ?? toMs(p.expectedStartTime),
      endMs: legs[legs.length - 1]?.expectedEndMs ?? toMs(p.expectedEndTime),
      durationMs: toNumber(p.duration) * 1000,
      walkDistanceM: toNumber(p.walkDistance),
      legs,
    };
  });
  return { trips, problems, ...cursors };
}
