import { haversineM, type LatLng } from '@atlas/core';
import type { RoutePath } from '@atlas/routing';

import type { TravelTimeCorridor, TravelTimeMeasurement, TravelTimeStatus } from './traveltime.js';

/** One measured corridor, matched onto a stretch of the routed line. */
export interface TrafficDelaySegment {
  corridorId: string;
  /** NPRA's Norwegian corridor name, `"<from> - <to>"`. */
  name: string;
  /** Metres along the route where the matched stretch starts and ends. */
  startM: number;
  endM: number;
  /** Measured time above free flow on this stretch, after overlap resolution. */
  delayMs: number;
  status: TravelTimeStatus;
}

export interface TrafficDelay {
  /** Sum of the segments — what the ETA moves by. */
  delayMs: number;
  segments: TrafficDelaySegment[];
  /** End of the measurement window the answer is built from. */
  measuredAt: string;
}

/**
 * How far a corridor vertex may sit from the routed line and still count.
 *
 * Generous compared with the 75 m closure match, because both geometries are
 * *the same road* here: NPRA digitises the carriageway it measures and Valhalla
 * follows the OSM way, so the gap is dual-carriageway separation and
 * generalisation, not uncertainty about which road is meant.
 */
const MATCH_TOLERANCE_M = 60;
/** Below this the route only clips a corridor — a crossing road, not a shared one. */
const MIN_COVERAGE = 0.5;
/**
 * A corridor's measurement is discarded past this ratio to its own free-flow
 * reference. Six times the free-flow time is not a queue, it is a broken
 * detector, and an ETA is a worse lie than an unadjusted one.
 */
const MAX_CONGESTION_RATIO = 6;

const DEG_M = 111_320;
/** Grid cell edge, ≈ 550 m — comfortably wider than {@link MATCH_TOLERANCE_M}. */
const CELL_DEG = 0.005;

interface Cumulative {
  points: readonly LatLng[];
  /** Distance from the route start to each point, in metres. */
  alongM: number[];
}

const cumulative = (points: readonly LatLng[]): Cumulative => {
  const alongM = [0];
  for (let i = 1; i < points.length; i++) {
    alongM.push(alongM[i - 1]! + haversineM(points[i - 1]!, points[i]!));
  }
  return { points, alongM };
};

/**
 * A route with its segments bucketed into a lat/lng grid.
 *
 * Without it this is a nested scan: 202 national corridors of ~90 vertices
 * each, against a route that can carry 20 000 points, is tens of millions of
 * distance calculations for one ETA. The grid turns each lookup into a handful
 * of candidate segments, which is what makes matching the *whole* corridor
 * table per request affordable rather than something needing a bbox
 * pre-filter that a long route would defeat anyway.
 */
interface RouteIndex extends Cumulative {
  cells: Map<string, number[]>;
  cellLngDeg: number;
}

const cellKey = (row: number, col: number): string => `${row}:${col}`;

function indexRoute(points: readonly LatLng[]): RouteIndex {
  const base = cumulative(points);
  const midLat = points[Math.floor(points.length / 2)]?.lat ?? 60;
  const cosLat = Math.max(0.05, Math.cos((midLat * Math.PI) / 180));
  const cellLngDeg = CELL_DEG / cosLat;
  const cells = new Map<string, number[]>();
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const rowFrom = Math.floor(Math.min(a.lat, b.lat) / CELL_DEG);
    const rowTo = Math.floor(Math.max(a.lat, b.lat) / CELL_DEG);
    const colFrom = Math.floor(Math.min(a.lng, b.lng) / cellLngDeg);
    const colTo = Math.floor(Math.max(a.lng, b.lng) / cellLngDeg);
    // A simplified motorway segment can be kilometres long; walking its whole
    // bounding box keeps it findable from every cell it passes through.
    for (let row = rowFrom; row <= rowTo; row++) {
      for (let col = colFrom; col <= colTo; col++) {
        const key = cellKey(row, col);
        const bucket = cells.get(key);
        if (bucket) bucket.push(i);
        else cells.set(key, [i]);
      }
    }
  }
  return { ...base, cells, cellLngDeg };
}

/**
 * Nearest point on the route to `point`: how far off it is, and how far along.
 * `offsetM` is only trustworthy near the line — beyond one grid cell it simply
 * reports Infinity, which is all a tolerance test needs.
 */
function project(route: RouteIndex, point: LatLng): { offsetM: number; alongM: number } {
  const row = Math.floor(point.lat / CELL_DEG);
  const col = Math.floor(point.lng / route.cellLngDeg);
  const cosLat = Math.cos((point.lat * Math.PI) / 180);
  let bestOffset = Infinity;
  let bestAlong = 0;
  for (let dRow = -1; dRow <= 1; dRow++) {
    for (let dCol = -1; dCol <= 1; dCol++) {
      for (const i of route.cells.get(cellKey(row + dRow, col + dCol)) ?? []) {
        const a = route.points[i - 1]!;
        const b = route.points[i]!;
        // Local tangent-plane degrees, which is exact enough over one segment.
        const ax = (a.lng - point.lng) * cosLat;
        const ay = a.lat - point.lat;
        const dx = (b.lng - a.lng) * cosLat;
        const dy = b.lat - a.lat;
        const denom = dx * dx + dy * dy;
        const t = denom === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / denom));
        const offsetDeg = Math.hypot(ax + t * dx, ay + t * dy);
        if (offsetDeg < bestOffset) {
          bestOffset = offsetDeg;
          bestAlong = route.alongM[i - 1]! + t * (route.alongM[i]! - route.alongM[i - 1]!);
        }
      }
    }
  }
  return { offsetM: bestOffset * DEG_M, alongM: bestAlong };
}

interface Candidate {
  corridorId: string;
  name: string;
  startM: number;
  endM: number;
  delayS: number;
  status: TravelTimeStatus;
}

/**
 * Match one corridor onto the route, direction included.
 *
 * Direction is not a detail: NPRA publishes each stretch twice, once per
 * travel direction, and only one of them is queuing at rush hour. A corridor
 * whose geometry the route follows *backwards* is the opposite carriageway,
 * whose delay must not be charged to this journey — so the match is rejected
 * unless the corridor's own vertices advance along the route.
 */
function matchCorridor(
  route: RouteIndex,
  corridor: TravelTimeCorridor,
  delayS: number,
  status: TravelTimeStatus,
): Candidate | null {
  const hits = corridor.points.map((point) => project(route, point));
  let coveredM = 0;
  let corridorM = 0;
  let forwardM = 0;
  let backwardM = 0;
  let startM = Infinity;
  let endM = -Infinity;

  for (let i = 1; i < corridor.points.length; i++) {
    const segmentM = haversineM(corridor.points[i - 1]!, corridor.points[i]!);
    corridorM += segmentM;
    const from = hits[i - 1]!;
    const to = hits[i]!;
    // A segment counts only when both its ends lie on the route, and it is
    // weighted by its length rather than counted: a corridor is digitised
    // densely through curves and sparsely on straights, so counting vertices
    // would let a short tangle of bends outvote kilometres of road.
    if (from.offsetM > MATCH_TOLERANCE_M || to.offsetM > MATCH_TOLERANCE_M) continue;
    coveredM += segmentM;
    startM = Math.min(startM, from.alongM, to.alongM);
    endM = Math.max(endM, from.alongM, to.alongM);
    if (to.alongM >= from.alongM) forwardM += segmentM;
    else backwardM += segmentM;
  }

  if (corridorM === 0 || coveredM / corridorM < MIN_COVERAGE) return null;
  if (backwardM > forwardM) return null;
  if (!Number.isFinite(startM) || endM <= startM) return null;
  return {
    corridorId: corridor.id,
    name: corridor.name,
    startM,
    endM,
    // Only the covered part of the corridor is on this route, so only that
    // share of its measured delay belongs in this ETA.
    delayS: delayS * (coveredM / corridorM),
    status,
  };
}

/**
 * Price the live corridor measurements onto a routed line.
 *
 * The correction is deliberately **one-directional**: only measured time
 * *above* NPRA's own free-flow reference is applied. Half the corridors
 * routinely measure faster than that reference (median ratio 0.98 on the first
 * live probe, down to 0.63), and shortening an ETA because a motorway is
 * running above its reference speed would be promising the driver a pace the
 * router never planned. A jam ahead is the signal Valhalla genuinely cannot
 * see; a clear road is not news.
 */
export function trafficDelayForRoute(
  points: readonly LatLng[],
  corridors: readonly TravelTimeCorridor[],
  measurements: readonly TravelTimeMeasurement[],
): TrafficDelay {
  const empty: TrafficDelay = { delayMs: 0, segments: [], measuredAt: '' };
  if (points.length < 2) return empty;
  const route = indexRoute(points);
  const byId = new Map(measurements.map((measurement) => [measurement.corridorId, measurement]));

  const candidates: Candidate[] = [];
  let measuredAt = '';
  let measuredAtMs = -Infinity;
  for (const corridor of corridors) {
    const measurement = byId.get(corridor.id);
    if (!measurement?.durationS || !measurement.freeFlowS) continue;
    if (measurement.durationS > measurement.freeFlowS * MAX_CONGESTION_RATIO) continue;
    const delayS = measurement.durationS - measurement.freeFlowS;
    if (delayS <= 0) continue;
    const matched = matchCorridor(route, corridor, delayS, measurement.status);
    if (!matched) continue;
    candidates.push(matched);
    // Parsed rather than string-compared: these are offset-bearing timestamps,
    // so "2026-08-02T16:10+02:00" sorts after "…T17:10+04:00" as text and
    // before it in time.
    const at = Date.parse(measurement.measuredAt);
    if (Number.isFinite(at) && at > measuredAtMs) {
      measuredAtMs = at;
      measuredAt = measurement.measuredAt;
    }
  }
  if (candidates.length === 0) return empty;

  // Corridors overlap — NPRA measures Bjerke–Helsfyr and Bjerke–Teisen over the
  // same first kilometre — so adding matches up would charge that kilometre
  // twice. Sweep the elementary intervals instead and let the worst-affected
  // corridor own each one, which both avoids the double count and keeps the
  // segments summing to the total the ETA moved by.
  const edges = [...new Set(candidates.flatMap((c) => [c.startM, c.endM]))].sort((a, b) => a - b);
  const owed = new Map<string, number>();
  for (let i = 1; i < edges.length; i++) {
    const from = edges[i - 1]!;
    const to = edges[i]!;
    let worst: Candidate | null = null;
    let worstDensity = 0;
    for (const candidate of candidates) {
      if (candidate.startM > from || candidate.endM < to) continue;
      const density = candidate.delayS / (candidate.endM - candidate.startM);
      if (density > worstDensity) {
        worstDensity = density;
        worst = candidate;
      }
    }
    if (worst)
      owed.set(worst.corridorId, (owed.get(worst.corridorId) ?? 0) + worstDensity * (to - from));
  }

  const segments = candidates
    .map((candidate) => ({
      corridorId: candidate.corridorId,
      name: candidate.name,
      startM: candidate.startM,
      endM: candidate.endM,
      delayMs: Math.round((owed.get(candidate.corridorId) ?? 0) * 1000),
      status: candidate.status,
    }))
    .filter((segment) => segment.delayMs > 0)
    .sort((a, b) => a.startM - b.startM);

  return {
    delayMs: segments.reduce((total, segment) => total + segment.delayMs, 0),
    segments,
    measuredAt,
  };
}

/**
 * Fold a measured delay into a routed path.
 *
 * The delay is spread over the maneuvers it actually sits on, not added to the
 * total, because navigation prices the remaining trip from the maneuver
 * schedule: a jam charged to the whole route would still be charged after the
 * driver had passed it. Placed on its own maneuvers, the ETA sheds it on the
 * way through — the same way the schedule already sheds distance.
 */
export function applyTrafficDelay(path: RoutePath, delay: TrafficDelay): RoutePath {
  if (delay.delayMs <= 0) return path;
  const updated: RoutePath = {
    ...path,
    timeMs: path.timeMs + delay.delayMs,
    trafficDelayMs: delay.delayMs,
  };
  if (!path.instructions?.length) return updated;

  const alongM = cumulative(path.points).alongM;
  const legs = path.instructions.map((instruction) => ({
    startM: alongM[Math.min(instruction.interval[0], alongM.length - 1)] ?? 0,
    endM: alongM[Math.min(instruction.interval[1], alongM.length - 1)] ?? 0,
  }));
  const added = new Array<number>(path.instructions.length).fill(0);
  for (const segment of delay.segments) {
    const spans = legs.map((leg) =>
      Math.max(0, Math.min(leg.endM, segment.endM) - Math.max(leg.startM, segment.startM)),
    );
    const total = spans.reduce((sum, span) => sum + span, 0);
    if (total <= 0) continue;
    spans.forEach((span, index) => {
      added[index] = added[index]! + (segment.delayMs * span) / total;
    });
  }
  const placed = added.reduce((sum, ms) => sum + ms, 0);
  if (placed <= 0) return updated;
  // Anything that fell outside every maneuver leg (a delay matched past the
  // last instruction) is scaled back in, so the schedule still sums to timeMs.
  const scale = delay.delayMs / placed;
  updated.instructions = path.instructions.map((instruction, index) => ({
    ...instruction,
    timeMs: instruction.timeMs + Math.round(added[index]! * scale),
  }));
  return updated;
}

/**
 * The one line both clients show for a measured delay, so neither invents its
 * own wording. Null below a minute: an ETA is not honest to the second, and
 * "+0 min" reads as a fault rather than as free-flowing traffic.
 */
export function formatTrafficDelay(delayMs: number | undefined): string | null {
  if (!delayMs || delayMs < 60_000) return null;
  return `+${Math.round(delayMs / 60_000)} min traffic`;
}
