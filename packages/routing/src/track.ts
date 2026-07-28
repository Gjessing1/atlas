import type { LatLng } from '@atlas/core';
import type { TrackData } from '@atlas/gpx';

import { distanceToRouteM } from './corridor.js';

/**
 * Turn recorded/imported track geometry into a small editable set of routing
 * stops. The router then snaps the legs between these shape-defining points to
 * its current road/path graph.
 *
 * Endpoints are always kept. Each additional point is the original point with
 * the largest deviation from the currently retained line, so bends survive
 * before uninteresting straight samples. A modest cap keeps Valhalla requests
 * useful and leaves every retained point editable in the planner.
 */
export function trackToRoutePoints(data: TrackData, maxPoints = 24): LatLng[] {
  const points: LatLng[] = [];
  for (const segment of data.segments) {
    for (const point of segment) {
      const previous = points[points.length - 1];
      if (!previous || previous.lat !== point.lat || previous.lng !== point.lng) {
        points.push({ lat: point.lat, lng: point.lng });
      }
    }
  }
  if (points.length <= 2 || points.length <= maxPoints) return points;

  const cap = Math.max(2, Math.floor(maxPoints));
  const selected = [0, points.length - 1];
  while (selected.length < cap) {
    let bestIndex = -1;
    let bestDistance = -1;
    let insertAt = -1;
    for (let span = 1; span < selected.length; span++) {
      const from = selected[span - 1]!;
      const to = selected[span]!;
      for (let i = from + 1; i < to; i++) {
        const distance = distanceToRouteM(points[i]!, [points[from]!, points[to]!]);
        if (distance > bestDistance) {
          bestDistance = distance;
          bestIndex = i;
          insertAt = span;
        }
      }
    }
    if (bestIndex < 0) break;
    selected.splice(insertAt, 0, bestIndex);
  }
  return selected.map((index) => points[index]!);
}
