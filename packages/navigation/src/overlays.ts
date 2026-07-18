import type { LatLng } from '@atlas/core';
import type { RoutePath } from '@atlas/routing';

import { bearingDeg, cumulativeDistances, pointAtDistance, subPolyline } from './geometry.js';

/** How far the maneuver arrow reaches back along the approach / on along the exit. */
const ARROW_BEFORE_M = 35;
const ARROW_AFTER_M = 35;

/** One turn arrow: the body LineString over the route + a bearing-carrying tip Point. */
export type ManeuverArrowFeature =
  | {
      type: 'Feature';
      properties: {
        kind: 'body';
        /** Distance (m) along the route of the maneuver — apps filter passed turns on it. */
        alongM: number;
      };
      geometry: { type: 'LineString'; coordinates: number[][] };
    }
  | {
      type: 'Feature';
      properties: {
        kind: 'tip';
        alongM: number;
        /** Compass bearing (deg) of the arrow at its tip, for orienting the head glyph. */
        bearingDeg: number;
      };
      geometry: { type: 'Point'; coordinates: number[] };
    };

/**
 * On-map turn arrows for a route (the mapping-app standard: a short arrow laid
 * over the route geometry at every turn, so the maneuver is visible on the map
 * itself, not only in the instruction banner). One LineString "body" bridging
 * ~35 m either side of each maneuver point plus one Point "tip" carrying the
 * exit bearing for an arrowhead symbol. Straight-continue, via, and arrival
 * instructions get no arrow — only real direction changes are marked.
 */
export function maneuverArrowsGeoJSON(path: Pick<RoutePath, 'points' | 'instructions'>): {
  type: 'FeatureCollection';
  features: ManeuverArrowFeature[];
} {
  const points: LatLng[] = path.points;
  const features: ManeuverArrowFeature[] = [];
  if (points.length >= 2) {
    const cum = cumulativeDistances(points);
    const totalM = cum[cum.length - 1]!;
    for (const instruction of path.instructions ?? []) {
      // Signs: 0 continue, 4/5 arrive/via — no arrow. Turns/keeps/roundabout/
      // u-turn (±1..3, 6, ±7, ±8) all get one, as does a straight-ahead
      // maneuver that is still a decision point (kind: ramp/keep/merge).
      if (instruction.sign === 4 || instruction.sign === 5) continue;
      if (instruction.sign === 0 && !instruction.kind) continue;
      const start = Math.min(Math.max(instruction.interval[0], 0), points.length - 1);
      const alongM = cum[start]!;
      if (alongM <= 0 || alongM >= totalM) continue;
      const body = subPolyline(points, cum, alongM - ARROW_BEFORE_M, alongM + ARROW_AFTER_M);
      if (body.length < 2) continue;
      const tip = body[body.length - 1]!;
      // Tip bearing from the last ~8 m of the arrow, so the head follows the exit leg.
      const beforeTip = pointAtDistance(
        points,
        cum,
        Math.max(alongM, Math.min(alongM + ARROW_AFTER_M, totalM) - 8),
      );
      features.push(
        {
          type: 'Feature',
          properties: { kind: 'body', alongM },
          geometry: { type: 'LineString', coordinates: body.map((p) => [p.lng, p.lat]) },
        },
        {
          type: 'Feature',
          properties: { kind: 'tip', alongM, bearingDeg: bearingDeg(beforeTip, tip) },
          geometry: { type: 'Point', coordinates: [tip.lng, tip.lat] },
        },
      );
    }
  }
  return { type: 'FeatureCollection', features };
}
