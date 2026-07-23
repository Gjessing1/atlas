import type { RoutingProfile } from '@atlas/routing';

import type { NavigationOptions } from './model.js';

/**
 * Per-mode route-following tunables.
 *
 * Everything in `DEFAULT_NAV_OPTIONS` was chosen for a car, and a car is a
 * peculiar traveller: it cannot face away from the road it is on, it cannot
 * stop dead and turn on the spot, and 40 m off the line means it is genuinely
 * on a different road. None of that is true on foot. Rather than grow a third
 * and fourth code path, every mode-sensitive number lives in this one table —
 * the roadmap's "single mode-indexed table rather than two competing schemes".
 *
 * `car` is the empty row by definition: it is what the defaults already are.
 * Read each other row as a diff against it.
 */
const PROFILE_OPTIONS: Record<RoutingProfile, NavigationOptions> = {
  car: {},

  // A cyclist is genuinely between the two. GPS course is reliable (they are
  // always moving when it matters) but they ride on paths, stop at lights, and
  // turn far more often than a driver — so the timing shrinks while the
  // heading-derived machinery survives.
  bike: {
    // Tighter than the car's 40 m rather than looser: a cycleway typically
    // runs a few metres from the road it parallels, so a generous corridor
    // would happily follow the wrong one of the two.
    offRouteM: 30,
    // Contraflow cycling is legal in a lot of places and a cycleway's mapped
    // direction is often arbitrary, so demand near-exact opposition rather
    // than the driver's 120°. Not disabled outright: at riding speed a genuine
    // wrong-way is still worth catching.
    wrongWayDeg: 150,
    arrivalRadiusM: 20,
    arrivalLoiterRadiusM: 40,
    arrivalLoiterMaxSpeedMps: 0.7,
    approachThresholdsM: [200, 60],
    approachLeadTimesS: [30, 10],
    nowThresholdM: 20,
    nowLeadTimeS: 3,
    farApproachM: 0, // no motorways to need 800 m of warning
    farApproachLeadTimeS: 0,
    promptSpeedMaxMps: 15, // fast road cycling; higher readings should not make kilometer cues
    sustainMinLegM: Infinity,
    postTransitionPrompts: false,
    chainManeuverM: 120,
    snapDisplayMaxM: 20,
    departMinSpeedMps: 1.5, // ~5 km/h: pushing off counts
    deadReckonMinSpeedMps: 2,
    predictAheadMs: 600,
  },

  // On foot every premise behind the driving defaults fails at once: the
  // walker stops and turns on the spot, steps round a bench, walks a few paces
  // backwards, and does all of it legally.
  foot: {
    // Deliberately *looser* than the car's 40 m rather than tighter. A 1 m
    // path plus a 10 m fix plus a legitimate detour round an obstacle is
    // routinely 20 m of cross-track, and while off-route still triggers an
    // automatic reroute (see ROADMAP) a tight threshold would mean rerouting a
    // pedestrian for walking round a puddle.
    offRouteM: 45,
    offRouteGraceUpdates: 6,
    offRouteMaxAccuracyM: 25,
    // Disabled entirely. Walking a path "backwards" is not a mistake, and a
    // walker standing still reports no course at all — every input this check
    // needs is either absent or meaningless on foot.
    wrongWayDeg: Infinity,
    arrivalRadiusM: 15,
    // The car's loiter escape hatch inverts on foot: its "stopped" threshold is
    // *walking pace*, so a pedestrian would satisfy it while still walking, and
    // its 80 m radius is a minute away on foot. Both tighten to something only a
    // walker who has actually stopped at the door can meet.
    arrivalLoiterRadiusM: 25,
    arrivalLoiterMaxSpeedMps: 0.3,
    // 800/400/200/40 m is ten minutes of walking. These are the distances a
    // pedestrian can actually see the turn from.
    approachThresholdsM: [100, 30],
    approachLeadTimesS: [60, 20],
    nowThresholdM: 10,
    nowLeadTimeS: 7,
    farApproachM: 0,
    farApproachLeadTimeS: 0,
    promptSpeedMaxMps: 3, // a running pace, and a guard against bogus vehicle-speed fixes
    sustainMinLegM: Infinity,
    postTransitionPrompts: false,
    chainManeuverM: 60,
    snapDisplayMaxM: 20,
    startSnapDisplayMaxM: 15,
    departMinSpeedMps: 0.7, // ~2.5 km/h — a stroll is a departure
    departProgressM: 15,
    // Never dead-reckon on foot. It exists to bridge road tunnels at speed;
    // a pedestrian who stops under a bridge would instead be marched forward
    // along the route by an extrapolation that has no evidence behind it.
    deadReckonMinSpeedMps: Infinity,
    // At 1.4 m/s a one-second lead is 1.4 m — inside the noise it is meant to
    // cancel, so it only adds error.
    predictAheadMs: 0,
  },

  // Hiking is walking with worse fixes and a much higher tolerance for being
  // off the line: the "trail" may be a suggestion, and canopy, ravines and
  // cliffs wreck GPS exactly where the route is hardest to follow.
  hike: {
    offRouteM: 60,
    offRouteGraceUpdates: 8,
    // Loosened together on purpose: in terrain a 30 m-accuracy fix is often
    // the best on offer, and rejecting it would mean never evaluating
    // off-route at all. The wider corridor is what keeps that honest.
    offRouteMaxAccuracyM: 40,
    discardAccuracyM: 150,
    wrongWayDeg: Infinity,
    arrivalRadiusM: 25,
    // Same reasoning as foot, one notch looser for the fixes terrain gives.
    arrivalLoiterRadiusM: 35,
    arrivalLoiterMaxSpeedMps: 0.3,
    approachThresholdsM: [100, 30],
    approachLeadTimesS: [60, 20],
    nowThresholdM: 10,
    nowLeadTimeS: 7,
    farApproachM: 0,
    farApproachLeadTimeS: 0,
    promptSpeedMaxMps: 3,
    sustainMinLegM: Infinity,
    postTransitionPrompts: false,
    chainManeuverM: 60,
    snapDisplayMaxM: 30,
    startSnapDisplayMaxM: 20,
    departMinSpeedMps: 0.7,
    departProgressM: 15,
    deadReckonMinSpeedMps: Infinity,
    predictAheadMs: 0,
  },
  run: {
    offRouteM: 28,
    offRouteGraceUpdates: 3,
    wrongWayDeg: 130,
    arrivalRadiusM: 18,
    arrivalLoiterRadiusM: 45,
    arrivalLoiterMs: 12_000,
    arrivalLoiterMaxSpeedMps: 0.8,
    approachThresholdsM: [130, 55],
    approachLeadTimesS: [28, 11],
    nowThresholdM: 14,
    nowLeadTimeS: 3,
    farApproachM: 250,
    farApproachLeadTimeS: 55,
    farApproachMinSpeedMps: 4,
    promptSpeedMaxMps: 8,
    sustainMinLegM: 3_000,
    offRouteMaxAccuracyM: 24,
    discardAccuracyM: 80,
    deadReckonMinSpeedMps: 2,
    deadReckonMaxMs: 20_000,
    deadReckonMaxM: 150,
    predictAheadMs: 500,
  },
};

/**
 * Route-following tunables for a travel mode, ready to hand to
 * `NavigationSession`. Caller overrides win, so a session can still pass
 * `startDeparted` for a mid-trip reroute without knowing the mode's row.
 */
export function navOptionsForProfile(
  profile: RoutingProfile,
  overrides: NavigationOptions = {},
): NavigationOptions {
  return { ...PROFILE_OPTIONS[profile], ...overrides };
}
