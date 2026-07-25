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
  return snapToRoute(query, points, cum);
}

/** Continuity hints that turn the plain nearest-segment snap into map matching. */
export interface SnapHint {
  /**
   * `alongM` of the previous snap. Biases the match toward route continuity:
   * candidates behind the traveller, or implausibly far ahead (the return leg
   * of an out-and-back passing through the same streets), are penalized.
   */
  prevAlongM?: number | null;
  /**
   * GPS travel direction (deg, 0 = north). Pass only when actually moving —
   * a segment pointing somewhere the traveller demonstrably is not going
   * (the far carriageway, the road they have not turned onto yet) then costs
   * up to `HEADING_PENALTY_MAX_M` of equivalent cross-track distance.
   */
  headingDeg?: number | null;
  /**
   * How much farther along the route the traveller could plausibly have got
   * since `prevAlongM` — speed × elapsed time, with margin. Beyond it a
   * candidate is not merely unlikely but physically impossible, and is
   * penalized far harder than the generic ahead-slack.
   *
   * This is what stops the classic junction jump: waiting to turn off a road,
   * the fix sits metres from the road being turned *onto*, and without a
   * travel bound the match slid around the corner — drawing the puck on the
   * far road, pointing the wrong way, before the car had moved at all.
   */
  maxAdvanceM?: number | null;
}

// Scoring weights: penalties are expressed in metres of equivalent
// cross-track distance, so a hint only overrides proximity when the
// geometric ambiguity is genuinely small.
const BACKTRACK_PENALTY_PER_M = 0.15;
const AHEAD_SLACK_M = 250;
const AHEAD_PENALTY_PER_M = 0.05;
/**
 * Cost per metre of advance the traveller could not physically have made —
 * an order of magnitude steeper than the generic ahead-slack, because the
 * bound it applies past already carries a 60 % speed margin and a fixed slack
 * for GPS wander. Below 1 on purpose all the same: it is one argument among
 * several, and it must never overrule geometry that is not close.
 */
const IMPOSSIBLE_ADVANCE_PENALTY_PER_M = 0.8;
/**
 * Cost of a fully opposed segment. Left where it is on purpose: geometry must
 * still win when it is unambiguous — a heading may not drag the match tens of
 * metres sideways onto a road the fix is demonstrably not near.
 */
const HEADING_PENALTY_MAX_M = 30;

/**
 * Snap `query` to the polyline like `snapToPolyline`, but score candidates
 * with route-continuity and travel-direction penalties (a lightweight map
 * matcher): with GPS slightly off the road, the fix stays locked to the
 * segment the traveller is actually driving instead of jumping to whichever
 * nearby segment happens to be geometrically closest.
 */
export function snapToRoute(
  query: LatLng,
  points: LatLng[],
  cum: number[],
  hint: SnapHint = {},
): Snap {
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

  const prevAlongM = hint.prevAlongM ?? null;
  const headingRad = hint.headingDeg != null ? (hint.headingDeg * Math.PI) / 180 : null;
  const maxAdvanceM = hint.maxAdvanceM != null && hint.maxAdvanceM >= 0 ? hint.maxAdvanceM : null;

  let best: Snap | null = null;
  let bestScore = Infinity;
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
    const alongM = cum[i]! + t * (cum[i + 1]! - cum[i]!);

    let score = crossTrackM;
    if (prevAlongM !== null) {
      score += BACKTRACK_PENALTY_PER_M * Math.max(0, prevAlongM - alongM);
      score += AHEAD_PENALTY_PER_M * Math.max(0, alongM - prevAlongM - AHEAD_SLACK_M);
      if (maxAdvanceM !== null) {
        score += IMPOSSIBLE_ADVANCE_PENALTY_PER_M * Math.max(0, alongM - prevAlongM - maxAdvanceM);
      }
    }
    if (headingRad !== null && len2 > 0) {
      // 0 when aligned with the segment, HEADING_PENALTY_MAX_M when opposed.
      // |sin(Δ/2)| rather than sin²: the squared curve barely charged for a
      // crossing road (half the cost at a right angle), which is exactly the
      // ambiguity that matters — a car still short of its turn sits metres
      // from the road it is about to turn onto, and that road runs across its
      // travel direction, not against it. This shape roughly doubles the cost
      // there while leaving the fully-opposed case unchanged.
      const segRad = Math.atan2(bx, by);
      score += Math.sqrt((1 - Math.cos(headingRad - segRad)) / 2) * HEADING_PENALTY_MAX_M;
    }
    if (score < bestScore) {
      bestScore = score;
      best = { point: lerp(a, b, t), segmentIndex: i, t, crossTrackM, alongM };
    }
  }
  return best!;
}
