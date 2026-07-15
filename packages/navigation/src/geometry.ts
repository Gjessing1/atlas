import { haversineM, type LatLng } from '@atlas/core';

/**
 * Planar geometry for route following. Distances along the route use the
 * accurate haversine metric; the point-to-segment projection uses a local
 * equirectangular approximation (exact enough at the scale of a single route
 * segment, and far cheaper than spherical projection per GPS fix).
 */

const M_PER_DEG_LAT = 111_320;

/** Cumulative haversine distance (m) at each point; `[0]` for a single point, `[]` for none. */
export function cumulativeDistances(points: LatLng[]): number[] {
  if (points.length === 0) return [];
  const cum = new Array<number>(points.length);
  cum[0] = 0;
  for (let i = 1; i < points.length; i++) {
    cum[i] = cum[i - 1]! + haversineM(points[i - 1]!, points[i]!);
  }
  return cum;
}

export interface Snap {
  /** The query point projected onto the polyline. */
  point: LatLng;
  /** Index of the segment (points[segmentIndex]..segmentIndex+1) the snap landed on. */
  segmentIndex: number;
  /** Fraction along that segment, 0..1. */
  t: number;
  /** Perpendicular distance (m) from the query point to the polyline. */
  crossTrackM: number;
  /** Cumulative distance (m) along the polyline at the snapped point. */
  alongM: number;
}

function lerp(a: LatLng, b: LatLng, t: number): LatLng {
  return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
}

/**
 * Snap `query` to the closest point on the polyline, returning where it landed
 * and how far along / off the route it is. `cum` must be
 * `cumulativeDistances(points)`. Assumes at least one point.
 */
export function snapToPolyline(query: LatLng, points: LatLng[], cum: number[]): Snap {
  if (points.length < 2) {
    const only = points[0]!;
    return {
      point: only,
      segmentIndex: 0,
      t: 0,
      crossTrackM: haversineM(query, only),
      alongM: 0,
    };
  }

  let best: Snap | null = null;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const mPerDegLng = M_PER_DEG_LAT * Math.cos((a.lat * Math.PI) / 180);
    const bx = (b.lng - a.lng) * mPerDegLng;
    const by = (b.lat - a.lat) * M_PER_DEG_LAT;
    const qx = (query.lng - a.lng) * mPerDegLng;
    const qy = (query.lat - a.lat) * M_PER_DEG_LAT;
    const len2 = bx * bx + by * by;
    const t = len2 > 0 ? Math.min(1, Math.max(0, (qx * bx + qy * by) / len2)) : 0;
    const dx = qx - t * bx;
    const dy = qy - t * by;
    const crossTrackM = Math.sqrt(dx * dx + dy * dy);
    if (best === null || crossTrackM < best.crossTrackM) {
      best = {
        point: lerp(a, b, t),
        segmentIndex: i,
        t,
        crossTrackM,
        alongM: cum[i]! + t * (cum[i + 1]! - cum[i]!),
      };
    }
  }
  return best!;
}
