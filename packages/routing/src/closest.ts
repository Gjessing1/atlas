import { haversineM, type LatLng } from '@atlas/core';

/** Closest point on a routed polyline, including positions between vertices. */
export function closestPointOnRoute(
  points: readonly LatLng[],
  target: LatLng,
): { point: LatLng; distanceM: number } | null {
  if (points.length === 0) return null;
  const metresPerLat = 111_195;
  const metresPerLng = metresPerLat * Math.max(0.01, Math.cos((target.lat * Math.PI) / 180));
  let best: { point: LatLng; distanceM: number } | null = null;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const ax = (a.lng - target.lng) * metresPerLng;
    const ay = (a.lat - target.lat) * metresPerLat;
    const bx = (b.lng - target.lng) * metresPerLng;
    const by = (b.lat - target.lat) * metresPerLat;
    const dx = bx - ax;
    const dy = by - ay;
    const denominator = dx * dx + dy * dy;
    const t = denominator === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / denominator));
    const point = { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
    const distanceM = haversineM(point, target);
    if (!best || distanceM < best.distanceM) best = { point, distanceM };
  }
  if (best) return best;
  return { point: points[0]!, distanceM: haversineM(points[0]!, target) };
}
