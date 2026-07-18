import type { BBox, LatLng } from '@atlas/core';
import type { TrackData, TrackPoint } from '@atlas/gpx';

/** Routing profiles, mapped to Valhalla costing models in the adapter. */
export type RoutingProfile = 'car' | 'bike' | 'foot' | 'hike';

export interface RoutingProfileInfo {
  id: RoutingProfile;
  label: string;
  /** Pictogram for compact profile pickers. */
  icon: string;
}

/** All profiles, in display order. */
export const ROUTING_PROFILES: readonly RoutingProfileInfo[] = [
  { id: 'car', label: 'Drive', icon: '🚗' },
  { id: 'bike', label: 'Cycle', icon: '🚲' },
  { id: 'foot', label: 'Walk', icon: '🚶' },
  { id: 'hike', label: 'Hike', icon: '🥾' },
];

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
   * Travel direction (deg, 0 = north) at the first waypoint. Navigation
   * reroutes pass the current course so the new route continues the way the
   * vehicle is already pointing instead of proposing a U-turn.
   */
  headingDeg?: number;
  /** Loop from-and-back-to the single starting point, aiming for the given length. */
  roundTrip?: {
    distanceM: number;
    /** Vary the seed to get a different loop for the same distance. */
    seed?: number;
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
}

/** A successful routing response: the primary path first, then alternatives. */
export interface RouteResult {
  paths: RoutePath[];
}

/** Convert a routed path to track data, e.g. for GPX export or an elevation profile. */
export function routePathToTrackData(path: RoutePath, name: string): TrackData {
  return { name, segments: [path.points], waypoints: [] };
}
