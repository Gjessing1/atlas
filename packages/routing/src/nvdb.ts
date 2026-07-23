import { haversineM, type LatLng } from '@atlas/core';

import type { RouteEnrichment, RouteEnrichmentSegment } from './enrich.js';

/**
 * NVDB speed-limit conflation — layering Vegvesen's authoritative Norwegian
 * speed limits over the base route enrichment (which comes from the tiles via
 * Valhalla `/trace_attributes`, see enrich.ts).
 *
 * This is the "spatial side-dataset" conflation from ROADMAP §2.1: NVDB's own
 * geometry is matched onto the chosen route by nearest-segment distance, never
 * baked into the routing graph. The mechanism is deliberately the same on both
 * platforms — the web backend runs {@link nvdbSpeedOverrides} against a
 * server-side NVDB SQLite, the Android app runs it against the pack's copy —
 * and the client-side merge {@link applyNvdbSpeedLimits} is identical either
 * way. Nothing here is Norway-aware in code: outside Norway the side dataset
 * simply has no segments near the route, so no overrides are produced and the
 * OSM/tile limits stand — exactly the graceful-degradation the §2.1 rule wants.
 */

/**
 * One posted-limit stretch of Norwegian road from NVDB (object type 105
 * Fartsgrense, egenskap 2021), as a polyline with its constant limit.
 */
export interface NvdbSpeedSegment {
  /** Posted limit in km/h (NVDB stores a small enum: 30, 40, 50, …, 110). */
  limitKph: number;
  /** The stretch geometry, in order. Two points or more. */
  points: LatLng[];
}

/**
 * A speed limit that NVDB asserts over one distance range of the chosen route.
 * Ranges are sorted by `startM` and never overlap.
 */
export interface SpeedLimitOverride {
  startM: number;
  endM: number;
  limitKph: number;
}

export interface NvdbSpeedOptions {
  /**
   * A route vertex counts as "on" an NVDB stretch when the nearest point of
   * that stretch is within this many metres. Kept tight because NVDB and our
   * routing geometry are both derived from the surveyed centreline, so a real
   * match is metres apart; a loose tolerance would let a parallel road's limit
   * bleed across a central reservation.
   */
  toleranceM?: number;
}

const DEFAULT_TOLERANCE_M = 15;

/** Cumulative distance (m) at each point (`[0]` is always 0). */
function cumulative(points: LatLng[]): number[] {
  const cum = new Array<number>(points.length).fill(0);
  for (let i = 1; i < points.length; i++) {
    cum[i] = cum[i - 1]! + haversineM(points[i - 1]!, points[i]!);
  }
  return cum;
}

/**
 * Metres-per-degree scale at a latitude, for a local equirectangular
 * projection. Exact enough for the sub-kilometre distances this file measures
 * (a route vertex is only ever compared to nearby NVDB geometry).
 */
function scaleAt(lat: number): { mx: number; my: number } {
  const my = 111_320;
  const mx = 111_320 * Math.cos((lat * Math.PI) / 180);
  return { mx, my };
}

/** Squared distance (m²) from `p` to the segment `a`–`b`, in a local plane at `p`. */
function pointSegDist2(p: LatLng, a: LatLng, b: LatLng): number {
  const { mx, my } = scaleAt(p.lat);
  const px = 0;
  const py = 0;
  const ax = (a.lng - p.lng) * mx;
  const ay = (a.lat - p.lat) * my;
  const bx = (b.lng - p.lng) * mx;
  const by = (b.lat - p.lat) * my;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = 0;
  if (len2 > 0) {
    t = ((px - ax) * dx + (py - ay) * dy) / len2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
  }
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return (px - cx) * (px - cx) + (py - cy) * (py - cy);
}

/** Nearest distance (m) from `p` to a polyline, or Infinity for a single point. */
function pointPolylineDistM(p: LatLng, line: LatLng[]): number {
  let best = Infinity;
  for (let i = 1; i < line.length; i++) {
    const d2 = pointSegDist2(p, line[i - 1]!, line[i]!);
    if (d2 < best) best = d2;
  }
  return Math.sqrt(best);
}

/** Axis-aligned bounds of a polyline. */
interface Bounds {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

function boundsOf(line: LatLng[]): Bounds {
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  for (const p of line) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lng < minLng) minLng = p.lng;
    if (p.lng > maxLng) maxLng = p.lng;
  }
  return { minLat, maxLat, minLng, maxLng };
}

/**
 * A uniform grid over NVDB segment bounds so matching one route vertex touches
 * only the handful of stretches near it, not every stretch in the corridor.
 * A cross-country route's bbox can hold tens of thousands of segments; without
 * this the per-vertex nearest search would be quadratic and unusable.
 */
class SpeedGrid {
  private readonly cells = new Map<string, number[]>();
  // ~1 km cells: large enough that a segment lands in few cells, small enough
  // that a vertex's own cell holds only local geometry.
  private readonly cellDeg = 0.01;

  constructor(private readonly segments: NvdbSpeedSegment[]) {
    segments.forEach((seg, idx) => {
      if (seg.points.length < 2) return;
      const b = boundsOf(seg.points);
      for (let gx = this.cell(b.minLng); gx <= this.cell(b.maxLng); gx++) {
        for (let gy = this.cell(b.minLat); gy <= this.cell(b.maxLat); gy++) {
          const key = `${gx}:${gy}`;
          const bucket = this.cells.get(key);
          if (bucket) bucket.push(idx);
          else this.cells.set(key, [idx]);
        }
      }
    });
  }

  private cell(deg: number): number {
    return Math.floor(deg / this.cellDeg);
  }

  /**
   * The limit of the stretch nearest `p` within `toleranceM`, or undefined.
   * Scans the vertex's own cell plus its eight neighbours — the tolerance is
   * far smaller than a cell, so a nearer stretch can only sit one cell away.
   */
  limitNear(p: LatLng, toleranceM: number): number | undefined {
    const gx = this.cell(p.lng);
    const gy = this.cell(p.lat);
    let best = toleranceM;
    let limit: number | undefined;
    const seen = new Set<number>();
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const bucket = this.cells.get(`${gx + dx}:${gy + dy}`);
        if (!bucket) continue;
        for (const idx of bucket) {
          if (seen.has(idx)) continue;
          seen.add(idx);
          const d = pointPolylineDistM(p, this.segments[idx]!.points);
          if (d < best) {
            best = d;
            limit = this.segments[idx]!.limitKph;
          }
        }
      }
    }
    return limit;
  }
}

/**
 * Match NVDB speed stretches onto a chosen route, producing the distance ranges
 * where NVDB overrides the base limit. Pure and platform-neutral: the backend
 * feeds it segments read from the server DB, Android from the pack DB.
 *
 * Each route vertex takes the limit of the nearest stretch within tolerance;
 * consecutive vertices carrying the same limit collapse to one range. A vertex
 * with no stretch nearby (a gap in NVDB, or off the Norwegian network) yields
 * no override there, so the base limit shows through.
 */
export function nvdbSpeedOverrides(
  routePoints: LatLng[],
  segments: NvdbSpeedSegment[],
  opts: NvdbSpeedOptions = {},
): SpeedLimitOverride[] {
  if (routePoints.length < 2 || segments.length === 0) return [];
  const tolerance = opts.toleranceM ?? DEFAULT_TOLERANCE_M;
  const grid = new SpeedGrid(segments);
  const cum = cumulative(routePoints);
  const perVertex = routePoints.map((p) => grid.limitNear(p, tolerance));

  const out: SpeedLimitOverride[] = [];
  let runLimit: number | undefined;
  let runStart = 0;
  const flush = (endIdx: number) => {
    if (runLimit === undefined) return;
    const startM = cum[runStart]!;
    const endM = cum[endIdx]!;
    if (endM > startM) out.push({ startM, endM, limitKph: runLimit });
  };

  for (let i = 0; i < perVertex.length; i++) {
    const limit = perVertex[i];
    if (limit === runLimit) continue;
    // The edge *into* vertex i still carries the previous run's limit, so the
    // run ends at i, and the new run starts at i.
    flush(i);
    runLimit = limit;
    runStart = i;
  }
  flush(perVertex.length - 1);
  return out;
}

/** The override covering `m`, or null (overrides are sorted, non-overlapping). */
function overrideAt(overrides: SpeedLimitOverride[], m: number): SpeedLimitOverride | null {
  let lo = 0;
  let hi = overrides.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const o = overrides[mid]!;
    if (m < o.startM) hi = mid - 1;
    else if (m >= o.endM) lo = mid + 1;
    else return o;
  }
  return null;
}

/** The base segment covering `m`, or null. */
function segmentAt(segments: RouteEnrichmentSegment[], m: number): RouteEnrichmentSegment | null {
  let lo = 0;
  let hi = segments.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = segments[mid]!;
    if (m < s.startM) hi = mid - 1;
    else if (m > s.endM) lo = mid + 1;
    else return s;
  }
  return null;
}

/** Two adjacent enrichment segments carrying identical attributes draw as one. */
function sameAttributes(a: RouteEnrichmentSegment, b: RouteEnrichmentSegment): boolean {
  return (
    a.speedLimitKph === b.speedLimitKph &&
    a.tunnel === b.tunnel &&
    a.roadClass === b.roadClass &&
    a.name === b.name
  );
}

/**
 * Merge NVDB speed overrides into the base enrichment. Inside an override range
 * the NVDB limit wins — it is the road authority's own register, authoritative
 * where the tile limit is crowd-derived — while every other attribute (tunnel,
 * road class, name) is carried through unchanged. Ranges NVDB covers but the
 * base enrichment does not become speed-only segments, widening roundel
 * coverage without inventing tunnel or class data.
 *
 * The display path is untouched: the result is an ordinary {@link
 * RouteEnrichment}, so `speedLimitKphAt` and friends keep working exactly as
 * before — only the number behind the roundel changes, and only in Norway.
 */
export function applyNvdbSpeedLimits(
  enrichment: RouteEnrichment,
  overrides: SpeedLimitOverride[],
): RouteEnrichment {
  const base = enrichment.segments;
  if (overrides.length === 0) return enrichment;

  // Sweep the union of every base and override boundary; each sub-interval is
  // homogeneous in both base attributes and override limit.
  const bounds = new Set<number>();
  for (const s of base) {
    bounds.add(s.startM);
    bounds.add(s.endM);
  }
  for (const o of overrides) {
    bounds.add(o.startM);
    bounds.add(o.endM);
  }
  const cuts = [...bounds].sort((a, b) => a - b);

  const merged: RouteEnrichmentSegment[] = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const startM = cuts[i]!;
    const endM = cuts[i + 1]!;
    const mid = (startM + endM) / 2;
    const baseSeg = segmentAt(base, mid);
    const ov = overrideAt(overrides, mid);
    if (!baseSeg && !ov) continue;
    const seg: RouteEnrichmentSegment = baseSeg ? { ...baseSeg, startM, endM } : { startM, endM };
    if (ov) seg.speedLimitKph = ov.limitKph;
    merged.push(seg);
  }

  // Collapse touching segments left identical by the override.
  const coalesced: RouteEnrichmentSegment[] = [];
  for (const seg of merged) {
    const prev = coalesced[coalesced.length - 1];
    if (prev && sameAttributes(prev, seg) && seg.startM <= prev.endM + 1) {
      prev.endM = Math.max(prev.endM, seg.endM);
      continue;
    }
    coalesced.push(seg);
  }
  return { segments: coalesced };
}
