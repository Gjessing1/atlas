import type { BBox, LatLng } from '@atlas/core';
import type { TrackData, TrackPoint } from '@atlas/gpx';

/** Routing profiles, mapped to Valhalla costing models in the adapter. */
export type RoutingProfile = 'car' | 'bike' | 'foot' | 'hike' | 'run';

export interface RoutingProfileInfo {
  id: RoutingProfile;
  label: string;
}

/** All profiles, in display order. */
export const ROUTING_PROFILES: readonly RoutingProfileInfo[] = [
  { id: 'car', label: 'Drive' },
  { id: 'bike', label: 'Cycle' },
  { id: 'foot', label: 'Walk' },
  { id: 'hike', label: 'Hike' },
  { id: 'run', label: 'Run' },
];

/**
 * Curated Valhalla costing controls. These are route-planning preferences, not
 * raw engine JSON: every app can safely expose the same small set, and the
 * adapter remains responsible for legal values and profile applicability.
 */
export interface RoutePreferences {
  avoidFerries: boolean;
  avoidHighways: boolean;
  avoidTolls: boolean;
  avoidHills: boolean;
  preferTrails: boolean;
  /** Prefer a paved route where the graph offers a reasonable alternative. */
  avoidUnpaved: boolean;
}

/** Atlas defaults, including the long-standing ferry avoidance off the road network. */
export function defaultRoutePreferences(profile: RoutingProfile): RoutePreferences {
  return {
    avoidFerries: profile !== 'car',
    avoidHighways: false,
    avoidTolls: false,
    avoidHills: false,
    preferTrails: false,
    avoidUnpaved: false,
  };
}

/** Which way a synthesized loop should travel around its start. */
export type RoundTripDirection = 'either' | 'clockwise' | 'counterclockwise';

/**
 * Narrow an untrusted string (a share link's hash, a restored setting) to a
 * profile this build knows — anything else must not reach the routing API.
 */
export function isRoutingProfile(value: unknown): value is RoutingProfile {
  return typeof value === 'string' && ROUTING_PROFILES.some((p) => p.id === value);
}

/** A route request in app terms, decoupled from the Valhalla wire format. */
export interface RouteQuery {
  profile: RoutingProfile;
  /** Waypoints in visiting order. Two or more — except round trips, which take exactly one. */
  points: LatLng[];
  /** Ask for alternative paths (Valhalla supports this for 2-point queries only). */
  alternatives?: boolean;
  /** Ask for turn-by-turn instructions (needed for navigation; off by default). */
  instructions?: boolean;
  /**
   * Ask the platform adapter for sampled elevation and surface attribution.
   * This is an Atlas-only flag and is never sent in the Valhalla request.
   */
  details?: boolean;
  /**
   * Travel direction (deg, 0 = north) at the first waypoint. Navigation
   * reroutes pass the current course so the new route continues the way the
   * vehicle is already pointing instead of proposing a U-turn.
   */
  headingDeg?: number;
  /** User-facing costing controls, normalised by {@link defaultRoutePreferences}. */
  preferences?: Partial<RoutePreferences>;
  /**
   * Points the route must not pass through: Valhalla drops the graph edge
   * nearest each one before searching, so a route is forced around it. This is
   * the mechanism road closures use — one point on each closed segment (fed from
   * the DATEX closure feed, §2.2), independent of any user preference. Ordinary
   * planning leaves this empty. Valhalla caps the list at its
   * `max_exclude_locations` (default 50); callers that could exceed that must
   * trim to the closures near the corridor.
   */
  excludeLocations?: LatLng[];
  /** Loop from-and-back-to the single starting point, aiming for the given length. */
  roundTrip?: {
    distanceM: number;
    /** Vary the seed to get a different loop for the same distance. */
    seed?: number;
    /** Hold the loop's travel direction while varying its shape. */
    direction?: RoundTripDirection;
  };
}

/**
 * One turn-by-turn maneuver along a path. `sign` is Atlas's turn code
 * (numbering inherited from GraphHopper: …-2 left, -1 slight left, 0 continue,
 * 1 slight right, 2 right…; 4 = finish, 5 = via reached, 6 = roundabout,
 * ±7 keep right/left, ±8 u-turn). `interval` is the inclusive
 * `[start, end]` index range into `RoutePath.points` that this maneuver spans —
 * the turn itself happens at `points[start]`.
 */
export interface RouteInstruction {
  text: string;
  distanceM: number;
  timeMs: number;
  sign: number;
  streetName?: string;
  interval: [number, number];
  /** Which exit to take, for roundabout maneuvers (`sign === 6`). */
  exitNumber?: number;
  /**
   * How far the roundabout turns the traveller, in degrees relative to the
   * approach road (−180…180, negative = left/anticlockwise of straight on).
   * Measured from the route geometry, because the exit *number* says nothing
   * about the direction: the 2nd exit can be straight on, hard right or back
   * the way you came. Icons draw the exit arrow at this angle. Roundabout
   * maneuvers only, and absent when the geometry is too short to measure.
   */
  exitAngleDeg?: number;
  /**
   * Refines the coarse `sign` for maneuvers it flattens: a highway on-ramp,
   * a highway exit, a keep-at-fork, a merge (all otherwise just ±7/0), or
   * boarding a `ferry` (sign 0 — a leg to ride, not a turn). UIs may render
   * these with distinct icons; absent for plain turns.
   */
  kind?: 'ramp' | 'exit' | 'keep' | 'merge' | 'ferry';
  /**
   * Motorway junction signage for a ramp/exit/keep, straight off the road
   * signs: exit number(s), the route branches the ramp carries, and the places
   * it is signed toward. Present only when the router supplies it; render with
   * `formatExitSign`.
   */
  exitSign?: ExitSign;
  /**
   * Router-authored text for spoken guidance. These phrases are deliberately
   * separate from `text`: Valhalla shortens the immediate cue, includes road
   * references and exit numbers in the pre-turn cue, and may append a close
   * following maneuver itself. Navigation should prefer these over rebuilding
   * speech from the display instruction.
   */
  verbal?: VerbalInstruction;
  /**
   * Left-to-right lane guidance for the approach to this maneuver. Valhalla
   * only includes it when the route request opts in and the source road has
   * `turn:lanes`; absent is the normal international/coverage fallback.
   */
  lanes?: RouteLane[];
}

/** One direction painted in a turn lane, normalised from Valhalla's bit mask. */
export type LaneDirection =
  | 'none'
  | 'straight'
  | 'sharp-left'
  | 'left'
  | 'slight-left'
  | 'slight-right'
  | 'right'
  | 'sharp-right'
  | 'u-turn'
  | 'merge-left'
  | 'merge-right';

/** One physical lane, ordered left-to-right across the carriageway. */
export interface RouteLane {
  /** Every direction the lane permits (a lane can allow both straight and right). */
  directions: LaneDirection[];
  /**
   * `active` is Valhalla's preferred carrying lane, `valid` is another lane
   * that safely carries the maneuver, and `invalid` must be visually dimmed.
   */
  state: 'active' | 'valid' | 'invalid';
  /** The direction within a multi-direction lane that carries this maneuver. */
  recommendedDirection?: LaneDirection;
}

/** Purpose-built spoken variants attached to one Valhalla maneuver. */
export interface VerbalInstruction {
  /** Short cue for the instant of the maneuver (for example, "Turn right"). */
  succinct?: string;
  /** Early warning that prepares the traveller for the maneuver. */
  alert?: string;
  /** Full cue intended immediately before the maneuver. */
  pre?: string;
  /** Confirmation intended immediately after completing the maneuver. */
  post?: string;
  /** Valhalla already appended the next maneuver to `pre` (and often `succinct`). */
  multiCue?: boolean;
}

/** The parts of a motorway exit sign — any subset may be present. */
export interface ExitSign {
  /** Exit number(s), e.g. `["43"]` or `["23A", "23B"]`. */
  numbers?: string[];
  /** Route branches the exit carries, e.g. `["E6", "Rv4"]`. */
  branches?: string[];
  /** Destinations the exit is signed toward, e.g. `["Oslo", "Gardermoen"]`. */
  toward?: string[];
}

/**
 * A one-line exit label from an `ExitSign`, road-sign order:
 * `"Exit 43 · E6 · Oslo"`. Each segment is dropped when absent; returns `""`
 * for an empty sign so callers can treat it as "nothing to show".
 */
export function formatExitSign(sign: ExitSign): string {
  const parts: string[] = [];
  if (sign.numbers?.length) parts.push(`Exit ${sign.numbers.join('/')}`);
  if (sign.branches?.length) parts.push(sign.branches.join(' / '));
  if (sign.toward?.length) parts.push(sign.toward.join(', '));
  return parts.join(' · ');
}

/** One routable path (the primary route or an alternative). */
export interface RoutePath {
  /** Geometry with elevation when the server has DEM data. */
  points: TrackPoint[];
  distanceM: number;
  /** Travel time — the ETA is `departure + timeMs`. */
  timeMs: number;
  ascentM: number;
  descentM: number;
  bbox?: BBox;
  /** Turn-by-turn maneuvers, present only when the query asked for instructions. */
  instructions?: RouteInstruction[];
  /**
   * The path boards a ferry. Only knowable when instructions were requested —
   * absent does not prove a route is ferry-free. Worth a flag of its own
   * because a ferry leg is timetabled: it is the one part of a road route the
   * traveller cannot start whenever they like.
   */
  hasFerry?: boolean;
  /**
   * OSM/Valhalla road attributes aligned to distance along this path. Planner
   * routes fill these for the surface breakdown; navigation consumes the same
   * shape through RouteEnrichment.
   */
  enrichment?: RouteEnrichment;
}

/** Road attributes that hold over one stretch of a routed path. */
export interface RouteEnrichmentSegment {
  startM: number;
  endM: number;
  speedLimitKph?: number;
  tunnel?: boolean;
  roadClass?: string;
  name?: string;
  /** Valhalla surface value (`paved_smooth`, `gravel`, `dirt`, …). */
  surface?: string;
}

/** Road attributes for a whole route, ordered by start distance. */
export interface RouteEnrichment {
  segments: RouteEnrichmentSegment[];
}

/** A successful routing response: the primary path first, then alternatives. */
export interface RouteResult {
  paths: RoutePath[];
}

/** Convert a routed path to track data, e.g. for GPX export or an elevation profile. */
export function routePathToTrackData(path: RoutePath, name: string): TrackData {
  return { name, segments: [path.points], waypoints: [] };
}
