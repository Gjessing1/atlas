import type { LatLng } from '@atlas/core';
import type { RouteInstruction } from '@atlas/routing';

/** A live position fix fed into the navigation session. */
export interface Position {
  lat: number;
  lng: number;
  /** Compass heading in degrees, if the device reports it. */
  headingDeg?: number;
  /** Ground speed in m/s, if known (used only for display). */
  speedMps?: number;
}

export type NavStatus = 'navigating' | 'off-route' | 'arrived';

/** The maneuver the traveller is approaching. */
export interface UpcomingManeuver {
  instruction: RouteInstruction;
  /** Distance (m) from the current snapped position to the maneuver point. */
  distanceToM: number;
}

/** The full navigation state after processing a position fix. */
export interface NavState {
  status: NavStatus;
  /** The position snapped onto the route (what a nav UI should render). */
  snapped: LatLng;
  /** Perpendicular distance (m) from the raw fix to the route. */
  offRouteM: number;
  /** Distance (m) already covered along the route. */
  traveledM: number;
  /** Fraction of the route completed, 0..1 (`traveledM / total`; 1 on arrival). */
  routeProgress: number;
  /** Distance (m) still to travel to the destination. */
  distanceRemainingM: number;
  /** Estimated travel time (ms) still remaining. */
  timeRemainingMs: number;
  /** Absolute arrival time estimate (epoch ms). */
  etaEpochMs: number;
  /** The next maneuver, or null once past the final turn. */
  upcoming: UpcomingManeuver | null;
  /** The maneuver after `upcoming` (for "then …" hints), or null. */
  then: UpcomingManeuver | null;
  /**
   * Direction of the route (deg, 0 = north) at the snapped position, looking
   * ~25 m ahead — a stable course-up camera bearing, unlike raw GPS course.
   * Null when the route is a single point.
   */
  courseDeg: number | null;
}

/** A spoken-guidance cue emitted as the traveller nears a maneuver. */
export interface VoicePrompt {
  /** Ready-to-speak text, e.g. "In 200 meters, turn right onto Main Street". */
  text: string;
  /** `approach` fires at a distance threshold; `now` fires at the maneuver. */
  kind: 'approach' | 'now';
  /** Index of the maneuver instruction this prompt refers to. */
  maneuverIndex: number;
  /** The distance threshold (m) that triggered an `approach` prompt (0 for `now`). */
  thresholdM: number;
}

/** The result of feeding one position fix to a NavigationSession. */
export interface NavUpdate {
  state: NavState;
  /** Voice prompts newly triggered by this fix (usually zero or one). */
  prompts: VoicePrompt[];
}

/** Tunables for route following; every field has a sensible default. */
export interface NavigationOptions {
  /** Cross-track distance (m) beyond which a fix counts as off-route. */
  offRouteM?: number;
  /** Consecutive off-route fixes before the session reports `off-route`. */
  offRouteGraceUpdates?: number;
  /** Distance (m) to the destination within which arrival is declared. */
  arrivalRadiusM?: number;
  /** Descending distances (m) at which to emit "in N meters…" prompts. */
  approachThresholdsM?: number[];
  /** Distance (m) to the maneuver at which to emit the "now" prompt. */
  nowThresholdM?: number;
}

export const DEFAULT_NAV_OPTIONS: Required<NavigationOptions> = {
  offRouteM: 40,
  offRouteGraceUpdates: 3,
  arrivalRadiusM: 25,
  approachThresholdsM: [400, 200],
  nowThresholdM: 40,
};
