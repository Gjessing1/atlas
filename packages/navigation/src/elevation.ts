import type { LatLng } from '@atlas/core';

import { cumulativeDistances } from './geometry.js';

/**
 * A route point that may carry elevation — `RoutePath.points` when the server
 * has DEM data. Typed structurally so this package needs no gpx dependency.
 */
export type ElevationPoint = LatLng & { ele?: number };

/** One point in the elevation graph still ahead, measured from the traveller. */
export interface RemainingElevationPoint {
  distanceM: number;
  elevationM: number;
}

/**
 * Elevation profile from the traveller's along-route position to the finish.
 * The first sample is interpolated inside the current route segment, so the
 * chart loses climbed ground continuously rather than one Valhalla vertex at
 * a time. Missing elevation samples are skipped rather than replaced with a
 * false zero; fewer than two usable points means there is no graph to draw.
 */
export function remainingElevationProfile(
  points: ElevationPoint[],
  traveledM: number,
  maxPoints = 96,
): RemainingElevationPoint[] {
  if (points.length < 2 || maxPoints < 2) return [];
  const cum = cumulativeDistances(points);
  const totalM = cum.at(-1) ?? 0;
  const startM = Math.min(totalM, Math.max(0, traveledM));
  const profile: RemainingElevationPoint[] = [];

  for (let i = 0; i < points.length - 1; i++) {
    if (startM < cum[i]! || startM > cum[i + 1]!) continue;
    const from = points[i]!.ele;
    const to = points[i + 1]!.ele;
    if (
      typeof from === 'number' &&
      Number.isFinite(from) &&
      typeof to === 'number' &&
      Number.isFinite(to)
    ) {
      const segmentM = cum[i + 1]! - cum[i]!;
      const fraction = segmentM > 0 ? (startM - cum[i]!) / segmentM : 0;
      profile.push({ distanceM: 0, elevationM: from + (to - from) * fraction });
    }
    break;
  }

  for (let i = 0; i < points.length; i++) {
    if (cum[i]! <= startM) continue;
    const elevationM = points[i]!.ele;
    if (typeof elevationM !== 'number' || !Number.isFinite(elevationM)) continue;
    profile.push({ distanceM: cum[i]! - startM, elevationM });
  }

  if (profile.length < 2) return [];
  if (profile.length <= maxPoints) return profile;
  const sampled: RemainingElevationPoint[] = [profile[0]!];
  const interiorSlots = maxPoints - 2;
  for (let i = 1; i <= interiorSlots; i++) {
    const index = Math.round((i * (profile.length - 1)) / (interiorSlots + 1));
    sampled.push(profile[index]!);
  }
  sampled.push(profile.at(-1)!);
  return sampled;
}

/**
 * Climb still ahead: the sum of the positive elevation deltas between the
 * traveller's along-route position and the end. On a hike this — not speed —
 * is the number that decides whether to press on or turn back, so it takes
 * the speedometer's slot in the guidance chrome. Null when the route carries
 * no elevation (offline packs have no DEM), so the widget can show an honest
 * dash instead of a fake zero. Uses the same anchor-based hysteresis as the
 * gpx track stats (2 m), so the number agrees with what the route's
 * elevation profile reports as total ascent at the start.
 */
export function remainingAscentM(points: ElevationPoint[], traveledM: number): number | null {
  if (points.length < 2) return null;
  const HYSTERESIS_M = 2;
  const cum = cumulativeDistances(points);
  let ascent = 0;
  let sawEle = false;
  let anchor: number | null = null;
  for (let i = 0; i < points.length; i++) {
    const ele = points[i]!.ele;
    if (typeof ele !== 'number' || !Number.isFinite(ele)) continue;
    sawEle = true;
    if (cum[i]! < traveledM || anchor === null) {
      // Behind the traveller (or the first sample): only track the reference.
      anchor = ele;
      continue;
    }
    const delta = ele - anchor;
    if (Math.abs(delta) >= HYSTERESIS_M) {
      if (delta > 0) ascent += delta;
      anchor = ele;
    }
  }
  return sawEle ? Math.round(ascent) : null;
}
