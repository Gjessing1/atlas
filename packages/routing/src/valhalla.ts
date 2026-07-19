import type { LatLng } from '@atlas/core';
import type { TrackPoint } from '@atlas/gpx';
import type {
  RouteInstruction,
  RoutePath,
  RouteQuery,
  RouteResult,
  RoutingProfile,
} from './model.js';

/**
 * Valhalla adapter — Atlas's single routing engine. The server runs it as a
 * service (backend proxies it at /api/route) and Android embeds the same C++
 * core through a native bridge for offline routing, so online and offline
 * results agree by construction.
 *
 * Wire notes:
 *  - Geometry comes back as an **encoded polyline at precision 6** (not GeoJSON),
 *    2D only — no elevation data is built into the tiles, so `ele` is absent
 *    and ascent/descent are 0 (a conscious loss in the GraphHopper switch).
 *  - Distances are in the requested unit (we ask for kilometres) and times in
 *    **seconds**; both are converted to metres / milliseconds here.
 *  - A trip is split into one **leg per waypoint pair**; legs are concatenated
 *    into a single path (the shared vertex between consecutive legs is dropped)
 *    and each maneuver's shape indices are offset into the merged geometry.
 */

/** Map an Atlas routing profile to a Valhalla costing model. */
function costingFor(profile: RoutingProfile): string {
  switch (profile) {
    case 'car':
      return 'auto';
    case 'bike':
      return 'bicycle';
    case 'foot':
    case 'hike':
      return 'pedestrian';
  }
}

const EARTH_RADIUS_M = 6371008.8;

/** Destination point `distM` metres from `origin` along `bearingDeg` (great circle). */
function project(origin: LatLng, distM: number, bearingDeg: number): LatLng {
  const d = distM / EARTH_RADIUS_M;
  const brng = (bearingDeg * Math.PI) / 180;
  const lat1 = (origin.lat * Math.PI) / 180;
  const lng1 = (origin.lng * Math.PI) / 180;
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brng),
  );
  const lng2 =
    lng1 +
    Math.atan2(
      Math.sin(brng) * Math.sin(d) * Math.cos(lat1),
      Math.cos(d) - Math.sin(lat1) * Math.sin(lat2),
    );
  // Normalize longitude to [-180, 180).
  return {
    lat: (lat2 * 180) / Math.PI,
    lng: (((((lng2 * 180) / Math.PI + 540) % 360) + 360) % 360) - 180,
  };
}

/**
 * Valhalla has no round-trip algorithm (that was a GraphHopper feature), so
 * loops are synthesized in app code — the same way for the online service and
 * the on-device engine: put via points on a circle whose circumference is the
 * requested distance, anchored at the start. The seed picks the circle's
 * direction, so a new seed gives a different loop for the same distance.
 */
export function roundTripLocations(start: LatLng, distanceM: number, seed = 0): LatLng[] {
  // Scramble the seed so consecutive seeds give well-separated headings.
  const heading = (seed * 137.508) % 360; // golden-angle steps
  const radius = distanceM / (2 * Math.PI);
  const center = project(start, radius, heading);
  // The start sits on the circle at the opposite bearing; three more stops a
  // quarter-turn apart make the route trace the whole loop.
  const back = (heading + 180) % 360;
  const vias = [90, 180, 270].map((step) => project(center, radius, (back + step) % 360));
  return [start, ...vias, start];
}

/** Body for a Valhalla `POST /route` request. */
export function buildValhallaRequest(query: RouteQuery): Record<string, unknown> {
  // Round trips route start -> synthesized vias -> start. The vias are
  // `through` locations: shaping points the route must pass, not stops (no
  // leg split, no u-turn allowed at them).
  const locations: { lat: number; lon: number; type?: string; heading?: number }[] = query.roundTrip
    ? roundTripLocations(
        query.points[0]!,
        query.roundTrip.distanceM,
        query.roundTrip.seed ?? 0,
      ).map((p, i, all) => ({
        lat: p.lat,
        lon: p.lng,
        type: i === 0 || i === all.length - 1 ? 'break' : 'through',
      }))
    : query.points.map((p) => ({ lat: p.lat, lon: p.lng }));
  // Continue in the direction of travel: Valhalla penalizes edges leaving the
  // first location against its heading (within the default 60° tolerance), so
  // a mid-drive reroute doesn't open with "make a U-turn".
  if (!query.roundTrip && typeof query.headingDeg === 'number' && locations[0]) {
    locations[0] = { ...locations[0], heading: Math.round(((query.headingDeg % 360) + 360) % 360) };
  }
  const body: Record<string, unknown> = {
    locations,
    costing: costingFor(query.profile),
    directions_options: { units: 'kilometers', language: 'en' },
  };
  // Maneuvers are on by default in Valhalla; skip them unless asked for
  // (navigation asks, plain route planning doesn't) to keep responses lean.
  if (!query.instructions) {
    body['directions_type'] = 'none';
  }
  // `hike` is pedestrian costing that also allows mountain hiking paths (sac_scale).
  if (query.profile === 'hike') {
    body['costing_options'] = { pedestrian: { max_hiking_difficulty: 6 } };
  }
  // Valhalla returns alternates for point-to-point queries only.
  if (!query.roundTrip && query.alternatives && query.points.length === 2) {
    body['alternates'] = 2;
  }
  return body;
}

/** Decode a Valhalla-encoded polyline (default precision 6) to `[lat, lng]` pairs. */
function decodeShape(encoded: string, precision = 6): [number, number][] {
  const factor = 10 ** precision;
  const coords: [number, number][] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  while (index < encoded.length) {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;
    result = 0;
    shift = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;
    coords.push([lat / factor, lng / factor]);
  }
  return coords;
}

/**
 * Map a Valhalla maneuver `type` to the GraphHopper-style `sign` the rest of
 * Atlas already speaks (the web instruction list renders icons from it; the nav
 * engine reads only text + interval). Anything unrecognised means "continue" (0).
 * Valhalla types: 9 slight-right, 10 right, 11 sharp-right, 12/13 u-turn r/l,
 * 14 sharp-left, 15 left, 16 slight-left, 17/18/19 ramp s/r/l, 20/21 exit r/l,
 * 22/23/24 stay s/r/l, 25/37/38 merge, 26 roundabout-enter, 27 roundabout-exit,
 * 28/29 ferry enter/exit, 4/5/6 destination.
 */
const SIGN_BY_TYPE: Readonly<Record<number, number>> = {
  4: 4,
  5: 4,
  6: 4,
  9: 1,
  10: 2,
  11: 3,
  12: 8,
  13: -8,
  14: -3,
  15: -2,
  16: -1,
  17: 0, // ramp straight — the kind carries the flavor, the sign the geometry
  18: 7,
  19: -7,
  20: 7,
  21: -7,
  22: 0, // stay straight
  23: 7,
  24: -7,
  25: 0, // merge (side unknown)
  26: 6, // roundabout enter (carries the exit count)
  27: 6, // roundabout exit — still the ring, no separate arrow needed
  28: 0, // ferry board — a leg to ride; the kind carries the flavor
  29: 0, // ferry disembark
  37: 7,
  38: -7,
};

/**
 * The maneuver flavor a coarse ±7 sign hides — Valhalla distinguishes taking
 * an on-ramp, leaving via an exit, keeping a side at a fork, and merging;
 * UIs render each with its own icon (see RouteInstruction.kind).
 */
const KIND_BY_TYPE: Readonly<Record<number, 'ramp' | 'exit' | 'keep' | 'merge' | 'ferry'>> = {
  17: 'ramp',
  18: 'ramp',
  19: 'ramp',
  20: 'exit',
  21: 'exit',
  22: 'keep',
  23: 'keep',
  24: 'keep',
  25: 'merge',
  28: 'ferry',
  29: 'ferry',
  37: 'merge',
  38: 'merge',
};

interface ValhallaManeuver {
  type?: number;
  instruction?: string;
  street_names?: string[];
  length?: number;
  time?: number;
  begin_shape_index?: number;
  end_shape_index?: number;
  roundabout_exit_count?: number;
}

interface ValhallaLeg {
  shape?: string;
  maneuvers?: ValhallaManeuver[];
}

interface ValhallaTrip {
  legs?: ValhallaLeg[];
  units?: string;
  summary?: {
    length?: number;
    time?: number;
    min_lat?: number;
    min_lon?: number;
    max_lat?: number;
    max_lon?: number;
  };
}

interface ValhallaResponse {
  trip?: ValhallaTrip;
  alternates?: { trip?: ValhallaTrip }[];
}

/** Metres per requested unit — Valhalla reports lengths in km unless told otherwise. */
function metresPerUnit(trip: ValhallaTrip): number {
  return trip.units === 'miles' ? 1609.344 : 1000;
}

/** Turn one Valhalla trip (primary or alternate) into a RoutePath. */
function parseTrip(trip: ValhallaTrip): RoutePath | null {
  const legs = trip.legs;
  if (!Array.isArray(legs) || legs.length === 0) return null;
  const unit = metresPerUnit(trip);
  const points: TrackPoint[] = [];
  const instructions: RouteInstruction[] = [];

  for (const leg of legs) {
    if (typeof leg.shape !== 'string') continue;
    const shape = decodeShape(leg.shape);
    if (shape.length === 0) continue;
    // Global index of this leg's local index 0: for the first leg it's 0; for
    // later legs it's the shared vertex already present as the last point.
    const offset = points.length === 0 ? 0 : points.length - 1;
    const startIdx = points.length === 0 ? 0 : 1; // drop the duplicated join vertex
    for (let i = startIdx; i < shape.length; i++) {
      points.push({ lat: shape[i]![0], lng: shape[i]![1] });
    }
    for (const m of leg.maneuvers ?? []) {
      const begin = m.begin_shape_index;
      const end = m.end_shape_index;
      if (typeof begin !== 'number' || typeof end !== 'number') continue;
      const instruction: RouteInstruction = {
        text: m.instruction ?? '',
        distanceM: (m.length ?? 0) * unit,
        timeMs: (m.time ?? 0) * 1000,
        sign: SIGN_BY_TYPE[m.type ?? 0] ?? 0,
        interval: [offset + begin, offset + end],
      };
      const street = m.street_names?.[0];
      if (street) instruction.streetName = street;
      const kind = KIND_BY_TYPE[m.type ?? 0];
      if (kind) instruction.kind = kind;
      if (m.type === 26 && typeof m.roundabout_exit_count === 'number') {
        instruction.exitNumber = m.roundabout_exit_count;
      }
      instructions.push(instruction);
    }
  }

  if (points.length < 2) return null;

  const s = trip.summary;
  const path: RoutePath = {
    points,
    distanceM: typeof s?.length === 'number' ? s.length * unit : 0,
    timeMs: typeof s?.time === 'number' ? s.time * 1000 : 0,
    // Offline packs carry no elevation, so Valhalla returns none.
    ascentM: 0,
    descentM: 0,
  };
  if (
    s &&
    typeof s.min_lon === 'number' &&
    typeof s.min_lat === 'number' &&
    typeof s.max_lon === 'number' &&
    typeof s.max_lat === 'number'
  ) {
    path.bbox = {
      sw: { lat: s.min_lat, lng: s.min_lon },
      ne: { lat: s.max_lat, lng: s.max_lon },
    };
  }
  if (instructions.length > 0) path.instructions = instructions;
  return path;
}

/**
 * Map a Valhalla route response to a RouteResult (primary path first, then any
 * alternates). Throws on a shape without a usable trip.
 */
export function parseValhallaResponse(json: unknown): RouteResult {
  const res = json as ValhallaResponse;
  const primary = res?.trip ? parseTrip(res.trip) : null;
  if (!primary) throw new Error('routing response contains no paths');
  const paths: RoutePath[] = [primary];
  for (const alt of res.alternates ?? []) {
    const path = alt.trip ? parseTrip(alt.trip) : null;
    if (path) paths.push(path);
  }
  return { paths };
}
