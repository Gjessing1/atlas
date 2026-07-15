import { haversineM, type LatLng } from '@atlas/core';
import type { TrackPoint } from '@atlas/gpx';

/**
 * Where to insert a new via point when the user clicks on the routed line:
 * returns the index in `waypoints` to insert before, so the detour lands
 * between the two stops whose route section was clicked (instead of naively
 * appending, which would re-route the whole tail through the click).
 */
export function viaInsertIndex(
  pathPoints: TrackPoint[],
  waypoints: LatLng[],
  clicked: LatLng,
): number {
  if (waypoints.length < 2 || pathPoints.length === 0) return Math.max(waypoints.length - 1, 1);
  const nearestIndex = (target: LatLng): number => {
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < pathPoints.length; i++) {
      const d = haversineM(pathPoints[i]!, target);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  };
  const clickedAt = nearestIndex(clicked);
  for (let k = 1; k < waypoints.length; k++) {
    if (clickedAt <= nearestIndex(waypoints[k]!)) return k;
  }
  return waypoints.length - 1;
}
