import type { LatLng } from '@atlas/core';

import { cumulativeDistances, subPolyline } from './geometry.js';

/**
 * Bounding box of the not-yet-driven part of the route, for the guidance
 * overview camera (Google's overview button): fit everything from the current
 * along-route position to the destination. Null for degenerate routes.
 */
export function remainingRouteBounds(
  points: LatLng[],
  traveledM: number,
): { sw: LatLng; ne: LatLng } | null {
  if (points.length < 2) return null;
  const cum = cumulativeDistances(points);
  const totalM = cum[cum.length - 1]!;
  const rest = subPolyline(points, cum, Math.min(traveledM, totalM), totalM);
  if (rest.length < 2) return null;
  let minLat = Infinity;
  let minLng = Infinity;
  let maxLat = -Infinity;
  let maxLng = -Infinity;
  for (const p of rest) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lng < minLng) minLng = p.lng;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lng > maxLng) maxLng = p.lng;
  }
  return { sw: { lat: minLat, lng: minLng }, ne: { lat: maxLat, lng: maxLng } };
}

/**
 * Follow-mode zoom from ground speed — the OsmAnd/Google approach: rather than
 * a fixed zoom, keep a constant look-ahead *time*, i.e. pick the zoom at which
 * the distance covered in the next ~12 s fits the forward part of the screen.
 * 78271.5 m is the ground size of one 512px tile pixel at zoom 0 on the
 * equator; cos(lat) corrects for Web Mercator stretch. Clamped to a sane
 * range and quantized so GPS jitter doesn't constantly re-target the camera.
 */
export function zoomForSpeed(
  speedMps: number | null,
  lat: number | undefined,
  forwardDp = 400,
): number {
  const LOOKAHEAD_S = 12;
  const v = speedMps ?? 0;
  if (v < 1) return 17; // stationary/unknown: close-in city zoom
  const metersAhead = v * LOOKAHEAD_S;
  const scale = 78271.5 * Math.cos(((lat ?? 60) * Math.PI) / 180);
  const z = Math.log2((scale * forwardDp) / metersAhead);
  return Math.round(Math.min(17.5, Math.max(15, z)) * 4) / 4;
}

/**
 * Follow-mode zoom that also leans into the next maneuver: the speed zoom far
 * from a turn, ramping to a close-in intersection zoom over the last 300 m so
 * the turn geometry is readable when it matters (the Google/OsmAnd behavior).
 * `forwardDp` is how much screen (in dp) lies ahead of the position puck — a
 * bottom-anchored puck sees more road than a centered one.
 */
export function followZoom(
  speedMps: number | null,
  lat: number | undefined,
  nextManeuverM: number | null,
  forwardDp = 400,
): number {
  const base = zoomForSpeed(speedMps, lat, forwardDp);
  if (nextManeuverM === null || nextManeuverM > 300) return base;
  const APPROACH_ZOOM = 17.5;
  const RAMP_FROM_M = 300;
  const FULL_AT_M = 120;
  const t = Math.min(1, (RAMP_FROM_M - nextManeuverM) / (RAMP_FROM_M - FULL_AT_M));
  const z = Math.max(base, base + (APPROACH_ZOOM - base) * t);
  return Math.round(z * 4) / 4;
}
