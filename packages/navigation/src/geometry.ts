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
 * Compass bearing (deg, 0 = north, clockwise) from `a` to `b` using the same
 * local equirectangular approximation as the snapper — exact enough for the
 * segment-scale distances route following works with.
 */
export function bearingDeg(a: LatLng, b: LatLng): number {
  const mPerDegLng = M_PER_DEG_LAT * Math.cos((a.lat * Math.PI) / 180);
  const dx = (b.lng - a.lng) * mPerDegLng;
  const dy = (b.lat - a.lat) * M_PER_DEG_LAT;
  const deg = (Math.atan2(dx, dy) * 180) / Math.PI;
  return (deg + 360) % 360;
}

/**
 * The point exactly `alongM` metres along the polyline (clamped to its ends).
 * `cum` must be `cumulativeDistances(points)`. Assumes at least one point.
 */
export function pointAtDistance(points: LatLng[], cum: number[], alongM: number): LatLng {
  const total = cum[cum.length - 1]!;
  const clamped = Math.min(Math.max(alongM, 0), total);
  for (let i = 0; i < points.length - 1; i++) {
    if (clamped <= cum[i + 1]!) {
      const seg = cum[i + 1]! - cum[i]!;
      const t = seg > 0 ? (clamped - cum[i]!) / seg : 0;
      return lerp(points[i]!, points[i + 1]!, t);
    }
  }
  return points[points.length - 1]!;
}

/**
 * The sub-polyline between `fromM` and `toM` metres along the line (both
 * clamped), with interpolated end points — used to cut maneuver-arrow
 * geometry out of a route. Returns at least two points when `fromM < toM`.
 */
export function subPolyline(points: LatLng[], cum: number[], fromM: number, toM: number): LatLng[] {
  const total = cum[cum.length - 1]!;
  const a = Math.min(Math.max(fromM, 0), total);
  const b = Math.min(Math.max(toM, 0), total);
  if (points.length < 2 || b <= a) return [];
  const out: LatLng[] = [pointAtDistance(points, cum, a)];
  for (let i = 0; i < points.length; i++) {
    if (cum[i]! > a && cum[i]! < b) out.push(points[i]!);
  }
  out.push(pointAtDistance(points, cum, b));
  return out;
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
