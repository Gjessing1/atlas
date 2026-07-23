import type { LatLng } from '@atlas/core';

import { bearingDeg, cumulativeDistances, snapToPolyline } from './geometry.js';

/** The straight line back to the nearest point of the route. */
export interface BackToTrack {
  /** Nearest point on the route polyline. */
  point: LatLng;
  /** Straight-line distance (m) from the fix to that point. */
  distanceM: number;
  /** Compass bearing (deg, 0 = north) from the fix toward the track. */
  bearingDeg: number;
  /** The bearing as a compass point ("NW"), for banner text and voice. */
  cardinal: string;
}

const CARDINALS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;

/** Nearest eight-wind compass point for a bearing. */
export function cardinalFromDeg(deg: number): string {
  const norm = ((deg % 360) + 360) % 360;
  return CARDINALS[Math.round(norm / 45) % 8]!;
}

/**
 * Where the track is from here, for the hiker who has lost it. Off-route on a
 * mountain is not a re-route prompt — there may be no network and no other
 * path to re-route onto — it is "the trail is 240 m to the northwest". Pure
 * geometry over the route already in hand, so it works exactly when it is
 * needed: offline. Null for degenerate routes or when already on the line
 * (closer than ~10 m there is nothing useful to point at).
 */
export function backToTrack(routePoints: LatLng[], fix: LatLng): BackToTrack | null {
  if (routePoints.length < 2) return null;
  const cum = cumulativeDistances(routePoints);
  const snap = snapToPolyline(fix, routePoints, cum);
  if (snap.crossTrackM < 10) return null;
  const bearing = bearingDeg(fix, snap.point);
  return {
    point: snap.point,
    distanceM: snap.crossTrackM,
    bearingDeg: bearing,
    cardinal: cardinalFromDeg(bearing),
  };
}
