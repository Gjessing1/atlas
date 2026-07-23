import type { LatLng } from '@atlas/core';

import { cumulativeDistances } from './geometry.js';

/**
 * A route point that may carry elevation — `RoutePath.points` when the server
 * has DEM data. Typed structurally so this package needs no gpx dependency.
 */
export type ElevationPoint = LatLng & { ele?: number };

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
