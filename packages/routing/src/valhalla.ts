import { decodePolyline, haversineM, type LatLng } from '@atlas/core';
import type { TrackPoint } from '@atlas/gpx';
import { defaultRoutePreferences } from './model.js';
import type {
  RoutePreferences,
  LaneDirection,
  RouteLane,
  ExitSign,
  RouteInstruction,
  RoutePath,
  RouteQuery,
  RouteResult,
  RoutingProfile,
  VerbalInstruction,
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
    case 'run':
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

/** Compass bearing (deg, 0 = north, clockwise) from `a` to `b`. */
function bearingBetween(a: LatLng, b: LatLng): number {
  const φ1 = (a.lat * Math.PI) / 180;
  const φ2 = (b.lat * Math.PI) / 180;
  const Δλ = ((b.lng - a.lng) * Math.PI) / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Shortest signed difference b − a, in (−180, 180]. */
function angleDelta(a: number, b: number): number {
  return ((((b - a + 180) % 360) + 360) % 360) - 180;
}

/** Ignore shape vertices this close together — their bearing is noise. */
const HEADING_SPAN_M = 8;

/**
 * Direction of travel through `index`: `forward` gives the road leaving it,
 * otherwise the road arriving at it. Vertices nearer than `HEADING_SPAN_M` are
 * skipped, so a cluster of near-identical shape points can't yield a
 * meaningless bearing. Null when the shape runs out before that span.
 */
function headingAlong(points: LatLng[], index: number, forward: boolean): number | null {
  const here = points[index];
  if (!here) return null;
  const step = forward ? 1 : -1;
  for (let i = index + step; i >= 0 && i < points.length; i += step) {
    const other = points[i]!;
    if (haversineM(here, other) < HEADING_SPAN_M) continue;
    return forward ? bearingBetween(here, other) : bearingBetween(other, here);
  }
  return null;
}

/**
 * How far a roundabout turns the traveller: the departing road's heading minus
 * the approaching road's. Valhalla reports the exit *count* and nothing about
 * direction, yet the direction is what the icon has to draw — a "2nd exit" is
 * straight on at one roundabout and a hard right at the next.
 */
function roundaboutExitAngle(
  points: LatLng[],
  enterIndex: number,
  exitIndex: number,
): number | undefined {
  const approach = headingAlong(points, enterIndex, false);
  const departure = headingAlong(points, exitIndex, true);
  if (approach === null || departure === null) return undefined;
  return Math.round(angleDelta(approach, departure));
}

/** A point on a synthesized loop, and whether the traveller asked for it. */
export interface RoundTripStop {
  pos: LatLng;
  /**
   * True for the start and for stops the traveller planned — these are real
   * stops (Valhalla `break` locations). False for the shaping points invented
   * to give the loop its length, which are `through` locations: the route must
   * pass them, but they split no leg and allow no u-turn.
   */
  required: boolean;
}

/** Straight-line length of a polyline, in metres. */
function crowLengthM(points: readonly LatLng[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += haversineM(points[i - 1]!, points[i]!);
  return total;
}

/**
 * Shaping points that turn a straight run from `from` to `to` into an arc of
 * roughly `targetM`, bulging to one side.
 *
 * This is what lets a loop honour a destination *and* a distance: the way out
 * is the traveller's own plan, and the way home is stretched to fill whatever
 * distance is left over. The offsets follow a half sine so the detour eases in
 * and out instead of doubling back at a corner, and the height is solved for
 * numerically — the arc's length grows monotonically with it, so a bisection
 * converges in a few steps and needs no closed form.
 */
function bulgedReturn(from: LatLng, to: LatLng, targetM: number, side: 1 | -1): LatLng[] {
  const chordM = haversineM(from, to);
  const perpendicular = (bearingBetween(from, to) + side * 90 + 360) % 360;
  // Fractions along the chord, and how much of the full height each carries.
  const shape: readonly [number, number][] = [
    [0.25, 0.7],
    [0.5, 1],
    [0.75, 0.7],
  ];
  const arcFor = (height: number): LatLng[] =>
    shape.map(([along, share]) =>
      project(
        project(from, chordM * along, bearingBetween(from, to)),
        height * share,
        perpendicular,
      ),
    );

  let low = 0;
  let high = Math.max(targetM, chordM);
  for (let i = 0; i < 24; i++) {
    const mid = (low + high) / 2;
    if (crowLengthM([from, ...arcFor(mid), to]) < targetM) low = mid;
    else high = mid;
  }
  return arcFor((low + high) / 2);
}

/**
 * Valhalla has no round-trip algorithm (that was a GraphHopper feature), so
 * loops are synthesized in app code — the same way for the online service and
 * the on-device engine.
 *
 * With nothing but a start, the loop is a circle whose circumference is the
 * requested distance, anchored at the start; the seed picks its direction, so a
 * new seed gives a different loop of the same length.
 *
 * With stops planned (a destination, or several), those are kept: the loop runs
 * through them in order and comes home along an arc stretched to whatever
 * distance is left over. Turning "round trip" on used to discard everything but
 * the starting point, which quietly threw away the destination the traveller
 * had just entered — a 40 km loop from home instead of a 40 km loop *by way of
 * the lake*. If the planned stops already exceed the requested distance the way
 * home is direct: the stops are the plan, the distance is the wish.
 */
export function roundTripLocations(
  points: readonly LatLng[],
  distanceM: number,
  seed = 0,
): RoundTripStop[] {
  const start = points[0];
  if (!start) return [];
  const planned = points.slice(1).filter((point) => haversineM(start, point) > 1);

  if (planned.length === 0) {
    // Scramble the seed so consecutive seeds give well-separated headings.
    const heading = (seed * 137.508) % 360; // golden-angle steps
    const radius = distanceM / (2 * Math.PI);
    const center = project(start, radius, heading);
    // The start sits on the circle at the opposite bearing; three more stops a
    // quarter-turn apart make the route trace the whole loop.
    const back = (heading + 180) % 360;
    const vias = [90, 180, 270].map((step) => project(center, radius, (back + step) % 360));
    return [
      { pos: start, required: true },
      ...vias.map((pos) => ({ pos, required: false })),
      { pos: start, required: true },
    ];
  }

  const outbound = [start, ...planned];
  const last = planned[planned.length - 1]!;
  const chordM = haversineM(last, start);
  // What is left of the requested distance once the planned stops are visited.
  // The 5 % margin keeps a barely-longer target from inventing a wobble that
  // no road can follow anyway.
  const returnM = distanceM - crowLengthM(outbound);
  const detour =
    returnM > chordM * 1.05
      ? bulgedReturn(last, start, returnM, seed % 2 === 0 ? 1 : -1)
      : ([] as LatLng[]);
  return [
    ...outbound.map((pos) => ({ pos, required: true })),
    ...detour.map((pos) => ({ pos, required: false })),
    { pos: start, required: true },
  ];
}

/** Body for a Valhalla `POST /route` request. */
export function buildValhallaRequest(query: RouteQuery): Record<string, unknown> {
  // Round trips route start -> planned stops -> synthesized vias -> start. Only
  // the traveller's own points are stops; the synthesized ones are `through`
  // locations: shaping points the route must pass, not stops (no leg split, no
  // u-turn allowed at them).
  const locations: { lat: number; lon: number; type?: string; heading?: number }[] = query.roundTrip
    ? roundTripLocations(query.points, query.roundTrip.distanceM, query.roundTrip.seed ?? 0).map(
        (stop) => ({
          lat: stop.pos.lat,
          lon: stop.pos.lng,
          type: stop.required ? 'break' : 'through',
        }),
      )
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
  } else if (query.profile === 'car') {
    // Valhalla imports OSM turn:lanes into its graph, but deliberately omits
    // them from its native JSON serializer unless this top-level option is
    // set. This is route guidance data, so only navigation requests pay for it.
    body['turn_lanes'] = true;
  }
  // Ferries are a *ride*, not a walk or a pedal: by default Valhalla will route
  // a hiker onto a fjord crossing, drawing a line over water that the traveller
  // cannot walk. Choosing Walk should mean walking, so non-car profiles ask for
  // `use_ferry: 0`.
  //
  // Measured against our own tiles: this is a strong preference, not a
  // prohibition. Oslo → Nesoddtangen by bike drops the ferry and takes the
  // 50 km land route; Horten → Moss keeps it, because there is no crossing for
  // ~100 km and Valhalla would rather sail than fail. Routes that keep a ferry
  // are therefore flagged (`RoutePath.hasFerry`) and said out loud in the UI.
  //
  // Driving keeps ferries at Valhalla's default: in Norway they are part of the
  // road network, sign-posted as such, and E39 is unusable without them.
  const defaults = defaultRoutePreferences(query.profile);
  const preferences: RoutePreferences = { ...defaults, ...query.preferences };
  const costingOptions: Record<string, Record<string, unknown>> = {};
  const costing = costingFor(query.profile);
  if (preferences.avoidFerries) {
    costingOptions[costing] = { use_ferry: 0 };
  } else if (query.profile !== 'car' && query.preferences?.avoidFerries === false) {
    // Non-car Atlas defaults avoid ferries; an explicit custom-profile choice
    // restores Valhalla's ordinary willingness instead of merely removing a key
    // that the defaulting layer would add again.
    costingOptions[costing] = { use_ferry: 0.5 };
  }
  if (query.profile === 'car') {
    if (preferences.avoidHighways || preferences.avoidTolls) {
      costingOptions['auto'] = {
        ...costingOptions['auto'],
        ...(preferences.avoidHighways ? { use_highways: 0 } : {}),
        ...(preferences.avoidTolls ? { use_tolls: 0 } : {}),
      };
    }
  } else if (query.profile === 'bike') {
    costingOptions['bicycle'] = {
      ...costingOptions['bicycle'],
      ...(preferences.avoidHills ? { use_hills: 0 } : {}),
      ...(preferences.preferTrails
        ? { bicycle_type: 'mountain', use_roads: 0.1, avoid_bad_surfaces: 0 }
        : {}),
    };
  } else {
    costingOptions['pedestrian'] = {
      ...costingOptions['pedestrian'],
      ...(query.profile === 'run' ? { walking_speed: 10 } : {}),
      ...(preferences.avoidHills ? { use_hills: 0 } : {}),
      ...(preferences.preferTrails ? { use_tracks: 1, walkway_factor: 0.8 } : {}),
    };
  }
  // `hike` is pedestrian costing that also allows mountain hiking paths (sac_scale).
  if (query.profile === 'hike') {
    costingOptions['pedestrian'] = { ...costingOptions['pedestrian'], max_hiking_difficulty: 6 };
  }
  if (Object.keys(costingOptions).length > 0) {
    body['costing_options'] = costingOptions;
  }
  // Closures (and any other hard avoid) are exclude_locations: Valhalla removes
  // the edge nearest each point from the graph, so the search routes around a
  // shut road instead of over it. Distinct from the costing preferences above —
  // those bias the search, this forbids specific places outright. Empty means
  // "no avoids", so the key is only emitted when there is something to exclude.
  if (query.excludeLocations && query.excludeLocations.length > 0) {
    body['exclude_locations'] = query.excludeLocations.map((p) => ({ lat: p.lat, lon: p.lng }));
  }
  // Valhalla returns alternates for point-to-point queries only.
  if (!query.roundTrip && query.alternatives && query.points.length === 2) {
    body['alternates'] = 2;
  }
  return body;
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

/** One element of a Valhalla maneuver `sign` array (`{text, consecutive_count}`). */
interface ValhallaSignElement {
  text?: string;
  consecutive_count?: number;
}

interface ValhallaSign {
  exit_number_elements?: ValhallaSignElement[];
  exit_branch_elements?: ValhallaSignElement[];
  exit_toward_elements?: ValhallaSignElement[];
  exit_name_elements?: ValhallaSignElement[];
}

interface ValhallaManeuver {
  type?: number;
  instruction?: string;
  verbal_succinct_transition_instruction?: string;
  verbal_transition_alert_instruction?: string;
  verbal_pre_transition_instruction?: string;
  verbal_post_transition_instruction?: string;
  verbal_multi_cue?: boolean;
  street_names?: string[];
  length?: number;
  time?: number;
  begin_shape_index?: number;
  end_shape_index?: number;
  roundabout_exit_count?: number;
  sign?: ValhallaSign;
  lanes?: ValhallaLane[];
}

interface ValhallaLane {
  /** Bit mask from baldr/turnlanes.h. */
  directions?: number;
  /** Preferred direction bit when this is the active lane. */
  active?: number;
  /** Carrying direction bit when this is another valid lane. */
  valid?: number;
}

const LANE_DIRECTION_BITS: readonly [number, LaneDirection][] = [
  [1, 'none'],
  [2, 'straight'],
  [4, 'sharp-left'],
  [8, 'left'],
  [16, 'slight-left'],
  [32, 'slight-right'],
  [64, 'right'],
  [128, 'sharp-right'],
  [256, 'u-turn'],
  [512, 'merge-left'],
  [1024, 'merge-right'],
];

/** Decode Valhalla's stable TurnLanes bit mask into app-domain directions. */
function laneDirections(mask: unknown): LaneDirection[] {
  if (typeof mask !== 'number' || !Number.isInteger(mask) || mask <= 0) return [];
  return LANE_DIRECTION_BITS.filter(([bit]) => (mask & bit) !== 0).map(
    ([, direction]) => direction,
  );
}

/** Keep only complete, useful lane rows; malformed optional guidance is dropped. */
function parseLanes(lanes: unknown): RouteLane[] | undefined {
  if (!Array.isArray(lanes) || lanes.length < 2) return undefined;
  const parsed: RouteLane[] = [];
  for (const raw of lanes as ValhallaLane[]) {
    const directions = laneDirections(raw?.directions);
    if (directions.length === 0) return undefined;
    const active = laneDirections(raw?.active)[0];
    const valid = laneDirections(raw?.valid)[0];
    const lane: RouteLane = {
      directions,
      state: active ? 'active' : valid ? 'valid' : 'invalid',
    };
    if (active ?? valid) lane.recommendedDirection = active ?? valid;
    parsed.push(lane);
  }
  // A row with no carrying lane is not guidance; do not encourage the driver
  // to infer meaning from arrows the engine could not activate.
  return parsed.some((lane) => lane.state !== 'invalid') ? parsed : undefined;
}

/** Preserve the non-empty spoken variants Valhalla authored for a maneuver. */
function parseVerbal(maneuver: ValhallaManeuver): VerbalInstruction | undefined {
  const verbal: VerbalInstruction = {};
  const add = (key: 'succinct' | 'alert' | 'pre' | 'post', value: unknown): void => {
    if (typeof value === 'string' && value.trim().length > 0) verbal[key] = value;
  };
  add('succinct', maneuver.verbal_succinct_transition_instruction);
  add('alert', maneuver.verbal_transition_alert_instruction);
  add('pre', maneuver.verbal_pre_transition_instruction);
  add('post', maneuver.verbal_post_transition_instruction);
  if (typeof maneuver.verbal_multi_cue === 'boolean') {
    verbal.multiCue = maneuver.verbal_multi_cue;
  }
  return Object.keys(verbal).length > 0 ? verbal : undefined;
}

/** Non-empty `.text` values of a sign element array, in the order given. */
function signTexts(elements?: ValhallaSignElement[]): string[] | undefined {
  if (!Array.isArray(elements)) return undefined;
  const texts = elements
    .map((e) => e.text)
    .filter((t): t is string => typeof t === 'string' && t.length > 0);
  return texts.length > 0 ? texts : undefined;
}

/** A Valhalla `sign` object as an `ExitSign`, or undefined when it carries nothing. */
function parseSign(sign?: ValhallaSign): ExitSign | undefined {
  if (!sign) return undefined;
  const numbers = signTexts(sign.exit_number_elements);
  const branches = signTexts(sign.exit_branch_elements);
  const toward = signTexts(sign.exit_toward_elements);
  if (!numbers && !branches && !toward) return undefined;
  const out: ExitSign = {};
  if (numbers) out.numbers = numbers;
  if (branches) out.branches = branches;
  if (toward) out.toward = toward;
  return out;
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

  for (let legIndex = 0; legIndex < legs.length; legIndex++) {
    const leg = legs[legIndex]!;
    if (typeof leg.shape !== 'string') continue;
    const shape = decodePolyline(leg.shape);
    if (shape.length === 0) continue;
    // Global index of this leg's local index 0: for the first leg it's 0; for
    // later legs it's the shared vertex already present as the last point.
    const offset = points.length === 0 ? 0 : points.length - 1;
    const startIdx = points.length === 0 ? 0 : 1; // drop the duplicated join vertex
    for (let i = startIdx; i < shape.length; i++) {
      points.push({ lat: shape[i]![0], lng: shape[i]![1] });
    }
    // The roundabout-enter maneuver is the one the banner shows, but the angle
    // it turns through is only known once its matching exit arrives — hold it
    // open until then (both carry sign 6, so both want the angle).
    let ring: { instruction: RouteInstruction; index: number } | null = null;
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
      const exitSign = parseSign(m.sign);
      if (exitSign) instruction.exitSign = exitSign;
      const verbal = parseVerbal(m);
      if (verbal) instruction.verbal = verbal;
      // Valhalla splits a multi-stop trip into legs and ends every leg with a
      // destination maneuver — worded as *the* destination, because it doesn't
      // know the trip continues. Mid-trip those are via arrivals: give them
      // Atlas's via sign (5) and honest wording, or navigation would announce
      // "you have arrived" at every stop along the way.
      if (legIndex < legs.length - 1 && (m.type === 4 || m.type === 5 || m.type === 6)) {
        instruction.sign = 5;
        instruction.text = 'Arrive at via point';
        instruction.verbal = {
          alert: 'You will arrive at your via point',
          pre: 'You will arrive at your via point',
          succinct: 'You have arrived at your via point',
        };
      }
      const lanes = parseLanes(m.lanes);
      if (lanes) instruction.lanes = lanes;
      if (m.type === 26) {
        if (typeof m.roundabout_exit_count === 'number') {
          instruction.exitNumber = m.roundabout_exit_count;
        }
        ring = { instruction, index: offset + begin };
      } else if (m.type === 27 && ring) {
        const angle = roundaboutExitAngle(points, ring.index, offset + begin);
        if (angle !== undefined) {
          ring.instruction.exitAngleDeg = angle;
          instruction.exitAngleDeg = angle;
        }
        ring = null;
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
  // A ferry is the one part of a route the traveller cannot simply follow: it
  // has a timetable, and on foot or by bike it is the difference between a
  // walkable line and a line drawn across water. Flag it so the panel can say
  // so even when the shape alone looks like an ordinary crossing.
  if (instructions.some((i) => i.kind === 'ferry')) path.hasFerry = true;
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
