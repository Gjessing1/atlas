import { describe, expect, it } from 'vitest';
import { viaInsertIndex } from './insert.js';
import { routePathToTrackData, type RoutePath } from './model.js';
import { optimizeWaypointOrder } from './optimize.js';

const oslo = { lat: 59.9139, lng: 10.7522 };
const sognsvann = { lat: 59.9706, lng: 10.7305 };

describe('routePathToTrackData', () => {
  it('wraps the path as a single-segment track', () => {
    const path: RoutePath = {
      points: [oslo, { lat: 59.94, lng: 10.74 }, sognsvann],
      distanceM: 6400,
      timeMs: 4_800_000,
      ascentM: 0,
      descentM: 0,
    };
    const data = routePathToTrackData(path, 'Morning ride');
    expect(data.name).toBe('Morning ride');
    expect(data.segments).toHaveLength(1);
    expect(data.segments[0]).toHaveLength(3);
    expect(data.waypoints).toEqual([]);
  });
});

describe('viaInsertIndex', () => {
  // A straight west→east path with waypoints at both ends and one in the middle.
  const pathPoints = Array.from({ length: 11 }, (_, i) => ({ lat: 60, lng: 10 + i * 0.1 }));
  const waypoints = [
    { lat: 60, lng: 10.0 },
    { lat: 60, lng: 10.5 },
    { lat: 60, lng: 11.0 },
  ];

  it('inserts into the clicked route section', () => {
    // Clicked between start and the middle stop → insert before index 1.
    expect(viaInsertIndex(pathPoints, waypoints, { lat: 60.01, lng: 10.2 })).toBe(1);
    // Clicked between the middle stop and the end → insert before index 2.
    expect(viaInsertIndex(pathPoints, waypoints, { lat: 60.01, lng: 10.8 })).toBe(2);
  });

  it('falls back to before-the-end for degenerate input', () => {
    expect(viaInsertIndex([], waypoints, { lat: 60, lng: 10.2 })).toBe(2);
    expect(viaInsertIndex(pathPoints, [waypoints[0]!], { lat: 60, lng: 10.2 })).toBe(1);
  });
});

describe('optimizeWaypointOrder', () => {
  it('returns identity for fewer than 4 points', () => {
    expect(optimizeWaypointOrder([oslo])).toEqual([0]);
    expect(optimizeWaypointOrder([oslo, sognsvann])).toEqual([0, 1]);
    expect(optimizeWaypointOrder([oslo, sognsvann, oslo])).toEqual([0, 1, 2]);
  });

  it('sorts shuffled stops along a line, keeping endpoints fixed', () => {
    // Points on a west→east line, intermediates shuffled: 0, (3, 1, 2), 4.
    const at = (lng: number) => ({ lat: 60, lng });
    const points = [at(10.0), at(10.3), at(10.2), at(10.1), at(10.4)];
    expect(optimizeWaypointOrder(points)).toEqual([0, 3, 2, 1, 4]);
  });

  it('untangles a crossing that nearest-neighbor alone would keep', () => {
    // Start west, end east, with two pairs of stops arranged so the greedy
    // pass zig-zags; 2-opt must produce a shorter tour than the greedy one.
    const points = [
      { lat: 60.0, lng: 10.0 },
      { lat: 60.05, lng: 10.5 },
      { lat: 59.95, lng: 10.52 },
      { lat: 60.05, lng: 10.54 },
      { lat: 59.95, lng: 10.5 },
      { lat: 60.0, lng: 11.0 },
    ];
    const order = optimizeWaypointOrder(points);
    expect(order[0]).toBe(0);
    expect(order[order.length - 1]).toBe(5);
    expect([...order].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5]);
  });
});
