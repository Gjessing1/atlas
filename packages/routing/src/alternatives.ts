import type { LatLng } from '@atlas/core';

import { distanceToRouteM } from './corridor.js';

/** Below this, a fresh route is the active line re-cut at the current fix. */
const MIN_VISIBLE_SEPARATION_M = 15;

/**
 * Put a route-choice badge on the part of an alternative that most clearly
 * separates it from the active line. Endpoints are deliberately ignored:
 * route choices normally share both, and a badge at the destination obscures
 * the finish marker instead of explaining the choice.
 */
export function routeAlternativeLabelPoint(
  active: readonly LatLng[],
  alternative: readonly LatLng[],
): LatLng | null {
  if (alternative.length === 0) return null;
  if (active.length === 0) {
    return alternative[Math.floor(alternative.length / 2)] ?? null;
  }

  const first = Math.max(1, Math.floor((alternative.length - 1) * 0.12));
  const last = Math.min(alternative.length - 2, Math.ceil((alternative.length - 1) * 0.88));
  const stride = Math.max(1, Math.ceil((last - first + 1) / 80));
  let best = alternative[Math.floor(alternative.length / 2)]!;
  let bestDistanceM = -1;
  for (let i = first; i <= last; i += stride) {
    const point = alternative[i]!;
    const distanceM = distanceToRouteM(point, active);
    if (distanceM > bestDistanceM) {
      best = point;
      bestDistanceM = distanceM;
    }
  }
  return bestDistanceM >= MIN_VISIBLE_SEPARATION_M ? best : null;
}
