import { haversineM, type LatLng } from '@atlas/core';

import type { LaneDirection, RouteInstruction, RouteLane, RoutePath } from './model.js';

/** One NVDB 616 Feltstrekning carrying at least one dedicated turn lane. */
export interface NvdbLaneSegment {
  /** `Feltoversikt i veglenkeretning` (egenskap 5528), split on `#`. */
  fieldCodes: string[];
  /** Road-centre geometry in veglenke order. */
  points: LatLng[];
}

/** Replacement lane row for one maneuver in a chosen route. */
export interface LaneOverride {
  instructionIndex: number;
  lanes: RouteLane[];
}

export interface NvdbLaneOptions {
  /** Maximum road-centre separation. Both sources normally agree within metres. */
  toleranceM?: number;
  /** Look this far back from a maneuver for the dedicated-lane stretch. */
  approachM?: number;
  /** Reject a stretch crossing the route rather than running with it. */
  headingToleranceDeg?: number;
}

const DEFAULT_TOLERANCE_M = 18;
const DEFAULT_APPROACH_M = 300;
const DEFAULT_HEADING_TOLERANCE_DEG = 50;

const scaleAt = (lat: number): { mx: number; my: number } => ({
  mx: 111_320 * Math.cos((lat * Math.PI) / 180),
  my: 111_320,
});

function pointSegmentDistanceM(p: LatLng, a: LatLng, b: LatLng): number {
  const { mx, my } = scaleAt(p.lat);
  const ax = (a.lng - p.lng) * mx;
  const ay = (a.lat - p.lat) * my;
  const bx = (b.lng - p.lng) * mx;
  const by = (b.lat - p.lat) * my;
  const dx = bx - ax;
  const dy = by - ay;
  const length2 = dx * dx + dy * dy;
  const t = length2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / length2));
  return Math.hypot(ax + t * dx, ay + t * dy);
}

function pointPolylineDistanceM(p: LatLng, line: readonly LatLng[]): number {
  let best = Infinity;
  for (let i = 1; i < line.length; i++) {
    best = Math.min(best, pointSegmentDistanceM(p, line[i - 1]!, line[i]!));
  }
  return best;
}

function bearing(a: LatLng, b: LatLng): number {
  const x = (b.lng - a.lng) * Math.cos((a.lat * Math.PI) / 180);
  const y = b.lat - a.lat;
  return ((Math.atan2(x, y) * 180) / Math.PI + 360) % 360;
}

const angleDelta = (a: number, b: number): number =>
  Math.abs(((((b - a + 180) % 360) + 360) % 360) - 180);

function desiredDirection(instruction: RouteInstruction): LaneDirection | null {
  if (instruction.sign === -2 || instruction.sign === -1) return 'left';
  if (instruction.sign === 1 || instruction.sign === 2) return 'right';
  if (instruction.sign === 0) return 'straight';
  if (instruction.sign === 6 && typeof instruction.exitAngleDeg === 'number') {
    if (instruction.exitAngleDeg < -35) return 'left';
    if (instruction.exitAngleDeg > 35) return 'right';
    return 'straight';
  }
  return null;
}

interface ParsedField {
  code: string;
  number: number;
  direction: LaneDirection;
  restricted: boolean;
  order: number;
}

/** Decode only meanings NVDB's field-code standard actually guarantees. */
function parseField(code: string): ParsedField | null {
  const match = /^(\d+)(.*)$/i.exec(code.trim());
  if (!match) return null;
  const number = Number(match[1]);
  const suffix = match[2]!.toUpperCase();
  const left = /^V\d+$/.test(suffix);
  const right = /^H\d+$/.test(suffix);
  const ordinary = suffix === '';
  const restricted = !ordinary && !left && !right;
  return {
    code,
    number,
    direction: left ? 'left' : right ? 'right' : 'straight',
    restricted,
    // From the driver's left to right: left-turn auxiliary, its ordinary
    // lane, then right-turn auxiliary. Lane numbers grow from the centre out.
    order: number * 10 + (left ? -1 : right ? 1 : 0),
  };
}

function lanesFor(
  fieldCodes: readonly string[],
  alignedWithGeometry: boolean,
  desired: LaneDirection,
): RouteLane[] | null {
  const parity = alignedWithGeometry ? 1 : 0;
  const fields = fieldCodes
    .map(parseField)
    .filter((field): field is ParsedField => field !== null && field.number % 2 === parity)
    .sort((a, b) => a.order - b.order);
  if (
    fields.length < 2 ||
    !fields.some((field) => field.direction === desired && !field.restricted)
  ) {
    return null;
  }
  // A plain one-lane cross-section is not lane guidance. Require the source's
  // explicit V/H designation somewhere in the row even for a straight route.
  if (!fields.some((field) => field.direction === 'left' || field.direction === 'right'))
    return null;

  let activated = false;
  return fields.map((field) => {
    const carries = !field.restricted && field.direction === desired;
    const state: RouteLane['state'] = carries ? (activated ? 'valid' : 'active') : 'invalid';
    if (carries) activated = true;
    return {
      directions: [field.direction],
      state,
      ...(carries ? { recommendedDirection: desired } : {}),
    };
  });
}

interface Candidate {
  segment: NvdbLaneSegment;
  aligned: boolean;
  /** Along-route gap from the matched lane stretch to the maneuver. */
  gapM: number;
  distanceM: number;
}

function candidateFor(
  route: readonly LatLng[],
  cum: readonly number[],
  startIndex: number,
  segment: NvdbLaneSegment,
  opts: Required<NvdbLaneOptions>,
): Candidate | null {
  if (segment.points.length < 2) return null;
  const maneuverM = cum[startIndex] ?? 0;
  let bestIndex = -1;
  let bestDistance = Infinity;
  // Prefer the latest matching point: it is the end of the lane stretch
  // nearest the junction, not another occurrence of the same road farther back.
  for (let i = startIndex; i >= 0 && maneuverM - (cum[i] ?? 0) <= opts.approachM; i--) {
    const distance = pointPolylineDistanceM(route[i]!, segment.points);
    if (
      distance <= opts.toleranceM &&
      (i > bestIndex || (i === bestIndex && distance < bestDistance))
    ) {
      bestIndex = i;
      bestDistance = distance;
    }
  }
  if (bestIndex < 0) return null;

  const before = route[Math.max(0, bestIndex - 1)];
  const after = route[Math.min(route.length - 1, bestIndex + 1)];
  const first = segment.points[0];
  const last = segment.points[segment.points.length - 1];
  if (!before || !after || before === after || !first || !last) return null;
  const delta = angleDelta(bearing(before, after), bearing(first, last));
  if (delta > opts.headingToleranceDeg && delta < 180 - opts.headingToleranceDeg) return null;
  return {
    segment,
    aligned: delta <= opts.headingToleranceDeg,
    gapM: maneuverM - (cum[bestIndex] ?? 0),
    distanceM: bestDistance,
  };
}

/**
 * Match NVDB dedicated turn-lane stretches onto route maneuvers. Ordinary
 * numeric field codes say only "a lane exists"; V/H suffixes are the evidence
 * for left/right, so no row is emitted without one. This intentionally raises
 * Norwegian coverage without guessing arrows the register does not contain.
 */
export function nvdbLaneOverrides(
  route: Pick<RoutePath, 'points' | 'instructions'>,
  segments: readonly NvdbLaneSegment[],
  options: NvdbLaneOptions = {},
): LaneOverride[] {
  const instructions = route.instructions ?? [];
  if (route.points.length < 2 || instructions.length === 0 || segments.length === 0) return [];
  const opts: Required<NvdbLaneOptions> = {
    toleranceM: options.toleranceM ?? DEFAULT_TOLERANCE_M,
    approachM: options.approachM ?? DEFAULT_APPROACH_M,
    headingToleranceDeg: options.headingToleranceDeg ?? DEFAULT_HEADING_TOLERANCE_DEG,
  };
  const cum = new Array<number>(route.points.length).fill(0);
  for (let i = 1; i < route.points.length; i++) {
    cum[i] = cum[i - 1]! + haversineM(route.points[i - 1]!, route.points[i]!);
  }

  const out: LaneOverride[] = [];
  instructions.forEach((instruction, instructionIndex) => {
    const desired = desiredDirection(instruction);
    const startIndex = Math.max(0, Math.min(route.points.length - 1, instruction.interval[0]));
    if (!desired || startIndex === 0) return;
    const candidates = segments
      .map((segment) => candidateFor(route.points, cum, startIndex, segment, opts))
      .filter((candidate): candidate is Candidate => candidate !== null)
      .sort((a, b) => a.gapM - b.gapM || a.distanceM - b.distanceM);
    for (const candidate of candidates) {
      const lanes = lanesFor(candidate.segment.fieldCodes, candidate.aligned, desired);
      if (!lanes) continue;
      out.push({ instructionIndex, lanes });
      break;
    }
  });
  return out;
}

/** Return a route with authoritative NVDB lane rows replacing OSM rows by index. */
export function applyNvdbLanes(route: RoutePath, overrides: readonly LaneOverride[]): RoutePath {
  if (!route.instructions || overrides.length === 0) return route;
  const byIndex = new Map(overrides.map((override) => [override.instructionIndex, override.lanes]));
  return {
    ...route,
    instructions: route.instructions.map((instruction, index) =>
      byIndex.has(index) ? { ...instruction, lanes: byIndex.get(index)! } : instruction,
    ),
  };
}
