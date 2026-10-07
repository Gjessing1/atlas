import { haversineM, type LatLng } from '@atlas/core';
import { computeTrackStats, type TrackPoint } from '@atlas/gpx';
import type { RouteElevationTransport } from './planning.js';
import type { RoutePath, RouteQuery, RouteResult } from './model.js';

export type RouteTransport = (query: RouteQuery, signal: AbortSignal) => Promise<RouteResult>;

/** A direct leg's vertex range in the combined path, inclusive. */
export interface StraightRange {
  start: number;
  end: number;
}

/**
 * Route each path-following leg with the normal provider and join it to sampled
 * direct legs. A direct leg never asks Valhalla to invent a road detour. The
 * same combined path is used by the map, elevation chart and GPX export.
 */
export async function routeMixedPlan(
  query: RouteQuery,
  straightAfter: readonly boolean[],
  route: RouteTransport,
  elevations: RouteElevationTransport | undefined,
  signal: AbortSignal,
): Promise<RouteResult> {
  if (!straightAfter.some(Boolean) || query.roundTrip || query.points.length < 2) {
    return route(query, signal);
  }
  const groups: { points: LatLng[]; straight: boolean; firstLeg: number }[] = [];
  for (let index = 0; index < query.points.length - 1; index++) {
    const straight = straightAfter[index] === true;
    const previous = groups[groups.length - 1];
    if (!straight && previous && !previous.straight) {
      previous.points.push(query.points[index + 1]!);
    } else {
      groups.push({
        points: [query.points[index]!, query.points[index + 1]!],
        straight,
        firstLeg: index,
      });
    }
  }
  const parts = await Promise.all(
    groups.map(async (group): Promise<RoutePath> => {
      const from = group.points[0]!;
      const to = group.points[1]!;
      if (!group.straight) {
        const result = await route({ ...query, points: group.points, alternatives: false }, signal);
        const path = result.paths[0];
        if (!path) throw new Error(`No path for leg ${group.firstLeg + 1}`);
        return path;
      }
      const distanceM = haversineM(from, to);
      // Small intervals keep a ridge or shoreline elevation profile legible;
      // the backend accepts at most 400 samples in one request.
      const intervals = Math.max(1, Math.min(299, Math.ceil(distanceM / 100)));
      const points: TrackPoint[] = Array.from({ length: intervals + 1 }, (_, i) => {
        const t = i / intervals;
        return { lat: from.lat + (to.lat - from.lat) * t, lng: from.lng + (to.lng - from.lng) * t };
      });
      if (elevations && query.details) {
        const heights = await elevations(points, signal).catch(() => []);
        heights.forEach((height, i) => {
          if (typeof height === 'number' && Number.isFinite(height)) points[i]!.ele = height;
        });
      }
      const stats = computeTrackStats({ segments: [points], waypoints: [] });
      const speedMps =
        query.profile === 'car'
          ? 13.9
          : query.profile === 'bike'
            ? 4.2
            : query.profile === 'run'
              ? 2.8
              : 1.3;
      return {
        points,
        distanceM,
        timeMs: (distanceM / speedMps) * 1000,
        ascentM: stats.ascentM,
        descentM: stats.descentM,
        straightRanges: [{ start: 0, end: points.length - 1 }],
      };
    }),
  );
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  const points: TrackPoint[] = [];
  const straightRanges: StraightRange[] = [];
  const instructions: NonNullable<RoutePath['instructions']> = [];
  const enrichment: NonNullable<RoutePath['enrichment']> = { segments: [] };
  let hasFerry = false;
  let distanceM = 0;
  let timeMs = 0;
  let ascentM = 0;
  let descentM = 0;
  for (const part of parts) {
    const offset = points.length === 0 ? 0 : points.length - 1;
    points.push(...(points.length === 0 ? part.points : part.points.slice(1)));
    for (const range of part.straightRanges ?? []) {
      straightRanges.push({ start: range.start + offset, end: range.end + offset });
    }
    for (const instruction of part.instructions ?? []) {
      instructions.push({
        ...instruction,
        interval: [instruction.interval[0] + offset, instruction.interval[1] + offset],
      });
    }
    for (const segment of part.enrichment?.segments ?? []) {
      enrichment.segments.push({
        ...segment,
        startM: segment.startM + distanceM,
        endM: segment.endM + distanceM,
      });
    }
    hasFerry ||= part.hasFerry === true;
    distanceM += part.distanceM;
    timeMs += part.timeMs;
    ascentM += part.ascentM;
    descentM += part.descentM;
  }
  return {
    paths: [
      {
        points,
        distanceM,
        timeMs,
        ascentM,
        descentM,
        straightRanges,
        instructions,
        enrichment,
        hasFerry,
      },
    ],
  };
}
