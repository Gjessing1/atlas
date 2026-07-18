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
  /** Horizontal accuracy radius (m), if the device reports it. */
  accuracyM?: number;
}

export type NavStatus = 'navigating' | 'off-route' | 'arrived';

/**
 * How the position in a NavState was obtained: `live` from a fresh usable GPS
 * fix, `estimated` dead-reckoned along the route through a GPS gap (tunnel),
 * `lost` when fixes have stopped and there is no basis to extrapolate — UIs
 * should grey the puck.
 */
export type NavFix = 'live' | 'estimated' | 'lost';

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
  /** The raw GPS fix that produced this state (for off-route display fallback). */
  raw: LatLng;
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
   * Name of the road currently being driven ("E6"), from the street name of
   * the maneuver leg containing the position; null when the data has none.
   */
  currentRoad: string | null;
  /** Whether this position is a live fix, an extrapolation, or signal-lost. */
  fix: NavFix;
  /**
   * True when motion sensors suggest the vehicle turned away from the assumed
   * route while dead reckoning (an in-tunnel fork or roundabout taken
   * differently) — the UI should tell the driver to check the route. Cleared
   * by the next live fix, which settles the question for real.
   */
  wrongBranch: boolean;
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
  /**
   * `approach` fires at a distance threshold; `now` fires at the maneuver;
   * `depart` is the first instruction, offered by `departurePrompt()` at
   * guidance start (it is behind the traveller, so it never fires otherwise);
   * `alert` is a warning outside the maneuver sequence (wrong-branch hint).
   */
  kind: 'approach' | 'now' | 'depart' | 'alert';
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
  /** Extra far-out approach distance (m) used only at highway speeds. */
  farApproachM?: number;
  /** Ground speed (m/s) above which the far approach prompt is armed. */
  farApproachMinSpeedMps?: number;
  /** Fix accuracy (m) beyond which a fix may not count toward off-route. */
  offRouteMaxAccuracyM?: number;
  /** Fix accuracy (m) beyond which a fix is ignored entirely (pure noise). */
  discardAccuracyM?: number;
  /** Fix age (ms) at which `tick()` starts treating the signal as gapped. */
  fixGapMs?: number;
  /** Fix age (ms) beyond which, absent dead reckoning, the fix is `lost`. */
  signalLostMs?: number;
  /** Minimum last-known speed (m/s) required to dead-reckon through a gap. */
  deadReckonMinSpeedMps?: number;
  /** Longest gap (ms) dead reckoning may bridge before reporting `lost`. */
  deadReckonMaxMs?: number;
  /** Farthest distance (m) dead reckoning may extrapolate before `lost`. */
  deadReckonMaxM?: number;
  /**
   * Time constant (ms) over which the extrapolation speed eases from the last
   * GPS speed toward the leg's expected speed. Non-finite disables the blend
   * (pure last-speed extrapolation).
   */
  deadReckonBlendTauMs?: number;
  /**
   * Sensor-vs-route heading divergence (deg) accumulated during one GPS gap
   * beyond which `wrongBranch` is raised. Large enough that gyro drift and
   * cornering-tilted gravity readings stay below it through a long tunnel.
   */
  wrongBranchDeg?: number;
  /** Chain "…, then X" into a prompt when X follows within this distance (m). */
  chainManeuverM?: number;
  /** Time constant (ms) of the observed-pace average that adapts the ETA. */
  paceTauMs?: number;
}

export const DEFAULT_NAV_OPTIONS: Required<NavigationOptions> = {
  offRouteM: 40,
  offRouteGraceUpdates: 3,
  arrivalRadiusM: 25,
  approachThresholdsM: [400, 200],
  nowThresholdM: 40,
  farApproachM: 800,
  farApproachMinSpeedMps: 19, // ~70 km/h: 400 m is under 20 s of warning
  offRouteMaxAccuracyM: 30, // urban-canyon fixes must not trigger reroutes
  discardAccuracyM: 100,
  fixGapMs: 3000,
  signalLostMs: 5000,
  deadReckonMinSpeedMps: 3, // below ~11 km/h a stop is likelier than a tunnel
  // The distance cap does the real bounding: 25 km covers Lærdal (24.5 km,
  // the world's longest road tunnel). The time cap is a backstop so a dead
  // GPS at crawling speed can't fake progress for hours.
  deadReckonMaxMs: 1_200_000,
  deadReckonMaxM: 25_000,
  deadReckonBlendTauMs: 45_000,
  wrongBranchDeg: 50, // an in-tunnel fork/roundabout exit turns well past this
  chainManeuverM: 300,
  paceTauMs: 90_000,
};
