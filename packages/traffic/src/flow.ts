import type { LatLng } from '@atlas/core';

import { distanceToTrafficRouteM } from './model.js';
import type { TravelTimeCorridor, TravelTimeMeasurement } from './traveltime.js';

/**
 * How a corridor is running, in the five states the map draws.
 *
 * **Derived from the measurement, not read from the feed.** NPRA publishes a
 * `trafficStatusValue` per corridor, and on a live snapshot (Monday
 * 2026-08-03 07:30, straight through the Oslo morning peak) every one of the
 * 138 measuring corridors reported `freeFlow` — including Helsfyr–Ryen at
 * 506 s against its own 300 s reference, which is a standing queue. The only
 * other value present was `unknown`, on the 64 corridors reporting no duration
 * at all. The field therefore separates "measuring" from "not measuring" and
 * nothing else; a colour scale built on it would paint that queue green.
 *
 * The ratio to NPRA's own free-flow reference is used instead — the same
 * quantity `trafficDelayForRoute` charges the ETA from, so the map explains the
 * number in the banner rather than offering a second opinion about it.
 */
export type TrafficFlowLevel = 'flowing' | 'busy' | 'slow' | 'queuing' | 'unmeasured';

/**
 * A corridor's measurement is discarded past this ratio to its own free-flow
 * reference. Six times the free-flow time is not a queue, it is a broken
 * detector, and an ETA is a worse lie than an unadjusted one. The map draws
 * such a corridor as unmeasured for the same reason.
 */
export const MAX_CONGESTION_RATIO = 6;

/**
 * The level boundaries, as ratios to the corridor's own free-flow reference.
 *
 * Measured against the live distribution (138 measuring corridors,
 * 2026-08-03 07:30: median 0.96, p90 1.13, max 1.69), so an ordinary morning
 * reads green nationally and only the handful of corridors actually running
 * over their reference pick up colour.
 */
const BUSY_RATIO = 1.15;
const SLOW_RATIO = 1.4;
const QUEUING_RATIO = 2;

/**
 * A ratio is not enough on its own: the corridors are 0.8–30 km, so 1.19× is
 * six minutes on the longest and **twenty-nine seconds** on the shortest. Ratio
 * alone painted the second one amber and then had nothing to show for it — the
 * first live tap on the deployed build read "Busy · 3 min (normally 3 min)",
 * which is a card arguing with itself.
 *
 * The floor is the same minute `formatTrafficDelay` refuses to go below when
 * naming a delay in the ETA. If the trip's own banner would not mention it,
 * the map has no business colouring it.
 */
const MIN_NOTICEABLE_DELAY_S = 60;

/**
 * One colour per level, decided here rather than per client so the two maps
 * cannot drift — the same reason `trafficFeatureCollection` carries
 * `markerColor`. Grey is deliberately dull: "no reading" must not read as a
 * fifth traffic condition.
 */
const FLOW_COLORS: Record<TrafficFlowLevel, string> = {
  flowing: '#16a34a',
  busy: '#eab308',
  slow: '#f97316',
  queuing: '#dc2626',
  unmeasured: '#9ca3af',
};

/** What one corridor's measurement says about how it is running. */
export interface TrafficFlowReading {
  level: TrafficFlowLevel;
  /** Measured ÷ free-flow reference. Absent when the corridor reports nothing. */
  ratio?: number;
  /** Measured seconds above free flow, floored at zero. */
  delayS?: number;
}

/**
 * Classify one corridor.
 *
 * A missing duration is `unmeasured`, never `flowing`: a third of the table
 * routinely reports nothing, and reading that as a clear road is the single
 * most damaging mistake this feed invites.
 */
export function corridorFlow(measurement: TravelTimeMeasurement | undefined): TrafficFlowReading {
  const durationS = measurement?.durationS;
  const freeFlowS = measurement?.freeFlowS;
  if (!durationS || !freeFlowS) return { level: 'unmeasured' };
  const ratio = durationS / freeFlowS;
  if (ratio > MAX_CONGESTION_RATIO) return { level: 'unmeasured' };
  const delayS = Math.max(0, durationS - freeFlowS);
  if (delayS < MIN_NOTICEABLE_DELAY_S) return { level: 'flowing', ratio, delayS };
  if (ratio >= QUEUING_RATIO) return { level: 'queuing', ratio, delayS };
  if (ratio >= SLOW_RATIO) return { level: 'slow', ratio, delayS };
  if (ratio >= BUSY_RATIO) return { level: 'busy', ratio, delayS };
  return { level: 'flowing', ratio, delayS };
}

/** Display-ready properties carried by every drawn corridor. */
export interface TrafficFlowProperties {
  id: string;
  /** NPRA's own Norwegian corridor name, `"<from> - <to>"`. Never translated. */
  name: string;
  level: TrafficFlowLevel;
  color: string;
  /** Measured seconds end to end; absent on an unmeasured corridor. */
  durationS?: number;
  freeFlowS?: number;
  delayS?: number;
  /** End of the aggregation window, so a tap can say how fresh the reading is. */
  measuredAt?: string;
}

export interface TrafficFlowFeatureCollection {
  type: 'FeatureCollection';
  features: Array<{
    type: 'Feature';
    geometry: { type: 'LineString'; coordinates: [number, number][] };
    properties: TrafficFlowProperties;
  }>;
}

/** Perpendicular distance from `p` to the segment `a`→`b`, in local tangent metres. */
const perpendicularM = (p: LatLng, a: LatLng, b: LatLng): number => {
  const cosLat = Math.cos((p.lat * Math.PI) / 180);
  const ax = (a.lng - p.lng) * cosLat;
  const ay = a.lat - p.lat;
  const dx = (b.lng - a.lng) * cosLat;
  const dy = b.lat - a.lat;
  const denom = dx * dx + dy * dy;
  const t = denom === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / denom));
  return Math.hypot(ax + t * dx, ay + t * dy) * 111_320;
};

/**
 * Douglas–Peucker, for the *drawn* copy of a corridor only.
 *
 * The corridor table is 32 877 vertices over 202 lines — 666 kB of GeoJSON for
 * something a client re-fetches every couple of minutes. At 10 m the same
 * table is 5 200 vertices and the route answers in 147 kB, and 10 m is well
 * under a pixel at every zoom this layer draws at.
 *
 * Only the drawing copy: matching a route against a corridor
 * (`trafficDelayForRoute`) keeps the full geometry, because there the vertices
 * are evidence rather than ink and the tolerance is 60 m.
 */
export function simplifyLine(points: readonly LatLng[], toleranceM: number): LatLng[] {
  if (points.length < 3) return [...points];
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  // Iterative rather than recursive: a 603-vertex corridor is fine either way,
  // but the stack depth of this algorithm is data-dependent by nature.
  const spans: Array<[number, number]> = [[0, points.length - 1]];
  while (spans.length > 0) {
    const [lo, hi] = spans.pop()!;
    let farthest = -1;
    let worst = toleranceM;
    for (let i = lo + 1; i < hi; i++) {
      const distance = perpendicularM(points[i]!, points[lo]!, points[hi]!);
      if (distance > worst) {
        worst = distance;
        farthest = i;
      }
    }
    if (farthest > 0) {
      keep[farthest] = 1;
      spans.push([lo, farthest], [farthest, hi]);
    }
  }
  return points.filter((_, index) => keep[index] === 1);
}

/** ≈ 1 m — finer than the simplification that produced the vertex. */
const round5 = (value: number): number => Math.round(value * 1e5) / 1e5;

/** Worst first: which corridor a reader wants named when two are equally close. */
const FLOW_RANK: Record<TrafficFlowLevel, number> = {
  queuing: 0,
  slow: 1,
  busy: 2,
  flowing: 3,
  unmeasured: 4,
};

/**
 * Two corridors closer together than this are the same road in both directions
 * — NPRA separates the carriageways by a median of 13 m — so a tap cannot have
 * meant one rather than the other.
 */
const SAME_ROAD_M = 25;

/** A hit from either client's `queryRenderedFeatures`, narrowed to what is read. */
export interface TrafficFlowHit {
  readonly geometry?: { readonly type?: string; readonly coordinates?: unknown } | null;
  readonly properties?: Record<string, unknown> | null;
}

const lineParts = (geometry: TrafficFlowHit['geometry']): LatLng[][] => {
  const coordinates = geometry?.coordinates;
  if (!Array.isArray(coordinates)) return [];
  const asLine = (raw: unknown): LatLng[] =>
    Array.isArray(raw)
      ? raw.flatMap((point) =>
          Array.isArray(point) && typeof point[0] === 'number' && typeof point[1] === 'number'
            ? [{ lat: point[1], lng: point[0] }]
            : [],
        )
      : [];
  return geometry?.type === 'MultiLineString'
    ? coordinates.map(asLine).filter((part) => part.length > 0)
    : [asLine(coordinates)].filter((part) => part.length > 0);
};

/**
 * Which of the corridors under a tap the card should describe.
 *
 * Not the first one the map hands back. A tap is a finger-sized box over a
 * layer holding 202 lines, every one of which has a reverse twin along the same
 * road, so "first hit" means "whatever order the tiles happened to be built
 * in" — tapping a red queue and being told about the clear carriageway beside
 * it, which is exactly what the first live tap did.
 *
 * The rule is nearest line to the tap, and where two are too close to have been
 * aimed at separately, the worse-affected one. Naming a direction is safe
 * because the card states the stretch: "Ryen - Helsfyr, queuing" is a complete
 * answer even if the reader is driving the other way.
 */
export function tappedFlowProperties(
  at: LatLng,
  hits: readonly TrafficFlowHit[] | null | undefined,
): Record<string, unknown> | null {
  const candidates = (hits ?? []).flatMap((hit) => {
    if (!hit.properties) return [];
    const parts = lineParts(hit.geometry);
    return [
      {
        properties: hit.properties,
        // No usable geometry (a client that queried only properties) still
        // counts, just last: an answer beats no answer.
        distanceM: parts.length
          ? Math.min(...parts.map((part) => distanceToTrafficRouteM(at, part)))
          : Infinity,
        rank: FLOW_RANK[hit.properties['level'] as TrafficFlowLevel] ?? 9,
      },
    ];
  });
  if (candidates.length === 0) return null;
  const nearestM = Math.min(...candidates.map((candidate) => candidate.distanceM));
  const sameRoad = candidates.filter((candidate) => candidate.distanceM <= nearestM + SAME_ROAD_M);
  sameRoad.sort((a, b) => a.rank - b.rank || a.distanceM - b.distanceM);
  return sameRoad[0]!.properties;
}

/**
 * The congestion overlay: every corridor NPRA publishes, drawn in the colour
 * its own measurement earns.
 *
 * Corridors reporting nothing are included rather than dropped. Absence on the
 * map would be ambiguous — it reads as "no corridor here" — while a dull grey
 * line says the thing that is actually true: NPRA measures this stretch and has
 * no reading for it right now.
 */
export function trafficFlowFeatureCollection(
  corridors: readonly TravelTimeCorridor[],
  measurements: readonly TravelTimeMeasurement[],
  simplifyToleranceM = 10,
): TrafficFlowFeatureCollection {
  const byId = new Map(measurements.map((measurement) => [measurement.corridorId, measurement]));
  return {
    type: 'FeatureCollection',
    features: corridors.map((corridor) => {
      const measurement = byId.get(corridor.id);
      const flow = corridorFlow(measurement);
      const properties: TrafficFlowProperties = {
        id: corridor.id,
        name: corridor.name,
        level: flow.level,
        color: FLOW_COLORS[flow.level],
      };
      if (flow.level !== 'unmeasured' && measurement) {
        properties.durationS = Math.round(measurement.durationS!);
        properties.freeFlowS = Math.round(measurement.freeFlowS!);
        properties.delayS = Math.round(flow.delayS ?? 0);
        if (measurement.measuredAt) properties.measuredAt = measurement.measuredAt;
      }
      return {
        type: 'Feature' as const,
        geometry: {
          type: 'LineString' as const,
          coordinates: simplifyLine(corridor.points, simplifyToleranceM).map(
            (point): [number, number] => [round5(point.lng), round5(point.lat)],
          ),
        },
        properties,
      };
    }),
  };
}
