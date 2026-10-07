import { describe, expect, it, vi } from 'vitest';
import { closestPointOnRoute } from './closest.js';
import { routeMixedPlan } from './mixed.js';
import type { RouteQuery } from './model.js';

const A = { lat: 59.9, lng: 10.7 };
const B = { lat: 59.91, lng: 10.71 };
const C = { lat: 59.92, lng: 10.72 };
const D = { lat: 59.93, lng: 10.73 };

describe('mixed route planning', () => {
  it('joins routed groups and sampled direct legs, retaining elevation and dash ranges', async () => {
    const query: RouteQuery = { profile: 'hike', points: [A, B, C, D], details: true };
    const route = vi.fn(async (part: RouteQuery) => ({
      paths: [{ points: part.points, distanceM: 1000, timeMs: 600_000, ascentM: 10, descentM: 5 }],
    }));
    const elevations = vi.fn(async (points: typeof query.points) => points.map((_, i) => i * 2));
    const result = await routeMixedPlan(
      query,
      [false, true, false],
      route,
      elevations,
      new AbortController().signal,
    );
    expect(route).toHaveBeenCalledTimes(2);
    expect(elevations).toHaveBeenCalledTimes(1);
    const path = result.paths[0]!;
    expect(path.points[0]).toEqual(A);
    expect(path.points.at(-1)).toEqual(D);
    expect(path.straightRanges).toHaveLength(1);
    expect(path.straightRanges![0]!.end).toBeGreaterThan(path.straightRanges![0]!.start);
    expect(path.points.some((p) => p.ele !== undefined)).toBe(true);
    expect(path.distanceM).toBeGreaterThan(2000);
  });

  it('projects a dropped point onto the middle of a sparse routed segment', () => {
    const nearest = closestPointOnRoute([A, C], B)!;
    expect(nearest.distanceM).toBeLessThan(10);
    expect(nearest.point.lat).toBeCloseTo(B.lat, 2);
  });
});
