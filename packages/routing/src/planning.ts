import type { LatLng } from '@atlas/core';
import { computeTrackStats } from '@atlas/gpx';

import { enrichRoute } from './enrich.js';
import type { RoutePath, RouteQuery, RouteResult, RoutingProfile } from './model.js';
import type { ValhallaTransport } from './provider.js';

/** Elevations corresponding one-for-one with the supplied sampled points. */
export type RouteElevationTransport = (
  points: LatLng[],
  signal?: AbortSignal,
) => Promise<(number | null)[]>;

/** Original shape indexes to annotate without replacing the router's geometry. */
export function routeProfileIndexes(length: number, maxPoints = 300): number[] {
  if (length <= 0) return [];
  const count = Math.min(length, Math.max(2, Math.floor(maxPoints)));
  if (count === length) return Array.from({ length }, (_, index) => index);
  return Array.from({ length: count }, (_, i) =>
    Math.min(length - 1, Math.round((i / (count - 1)) * (length - 1))),
  ).filter((index, i, all) => i === 0 || index !== all[i - 1]);
}

/**
 * Add the planner-only detail the lean route response omits: sampled terrain
 * heights and per-edge surface attribution. Either source may fail without
 * taking the usable route down with it.
 */
export async function enrichPlannedPath(
  path: RoutePath,
  profile: RoutingProfile,
  trace: ValhallaTransport,
  elevations: RouteElevationTransport,
  signal?: AbortSignal,
): Promise<RoutePath> {
  const indexes = routeProfileIndexes(path.points.length);
  const sampled = indexes.map((index) => path.points[index]!);
  const [routeEnrichment, heights] = await Promise.all([
    enrichRoute(path, profile, trace, { signal }).catch(() => ({ segments: [] })),
    elevations(sampled, signal).catch(() => []),
  ]);
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  const points = path.points.map((point) => ({ ...point }));
  indexes.forEach((pointIndex, sampleIndex) => {
    const elevation = heights[sampleIndex];
    if (typeof elevation === 'number' && Number.isFinite(elevation)) {
      points[pointIndex]!.ele = elevation;
    }
  });
  const stats = computeTrackStats({ segments: [points], waypoints: [] });
  return {
    ...path,
    points,
    ascentM: stats.ascentM,
    descentM: stats.descentM,
    enrichment: routeEnrichment,
  };
}

/** Enrich every selectable path in one detailed planner result. */
export async function enrichPlannedResult(
  result: RouteResult,
  query: RouteQuery,
  trace: ValhallaTransport,
  elevations: RouteElevationTransport,
  signal?: AbortSignal,
): Promise<RouteResult> {
  return {
    paths: await Promise.all(
      result.paths.map((path) => enrichPlannedPath(path, query.profile, trace, elevations, signal)),
    ),
  };
}
