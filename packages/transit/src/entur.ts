import { decodePolyline, type LatLng } from '@atlas/core';
import type {
  TransitLeg,
  TransitLine,
  TransitMode,
  TransitPlace,
  TransitQuery,
  TransitResult,
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
export const ENTUR_TRIP_QUERY = `query Trip($from:Location!,$to:Location!,$dateTime:DateTime,$arriveBy:Boolean!,$num:Int!,$walkSpeed:Float,$modes:Modes){
 trip(from:$from,to:$to,dateTime:$dateTime,arriveBy:$arriveBy,numTripPatterns:$num,walkSpeed:$walkSpeed,modes:$modes){
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
   }}}}`;

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 10;
const DEFAULT_WALK_SPEED_MPS = 1.3;

/**
 * Atlas ride modes as Entur's `TransportMode` enum values. `coach` and `bus`
 * are distinct upstream, so a traveller excluding buses keeps long-distance
 * coaches unless they exclude those too — which is how the operators sell them.
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
  const transportModes = modes.flatMap((mode) => {
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
    data?: { trip?: { tripPatterns?: unknown } | null } | null;
  } | null;

  if (Array.isArray(root?.errors) && root.errors.length > 0) {
    const first = root.errors[0]?.message;
    throw new TransitError(typeof first === 'string' ? first : 'journey planner error');
  }
  const patterns = root?.data?.trip?.tripPatterns;
  if (!Array.isArray(patterns)) return { trips: [] };

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
  return { trips };
}
