// @vitest-environment jsdom
import type { LatLng } from '@atlas/core';
import { RoutingError, type RouteQuery, type RouteResult } from '@atlas/routing';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRoute, type RouteFn } from './useRoute.js';

const A: LatLng = { lat: 59.91, lng: 10.75 };
const B: LatLng = { lat: 60.39, lng: 5.32 };
const C: LatLng = { lat: 63.43, lng: 10.4 };

function pathFor(query: RouteQuery): RouteResult {
  return {
    paths: [
      {
        points: query.points.map((p) => ({ ...p })),
        distanceM: 1000 * query.points.length,
        timeMs: 60_000,
        ascentM: 0,
        descentM: 0,
      },
    ],
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/** Flush the 250ms re-route debounce plus the async route call. */
async function settle(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
  });
}

describe('useRoute', () => {
  it('routes once two waypoints are set and clears when deactivated', async () => {
    const route = vi.fn<RouteFn>((q) => Promise.resolve(pathFor(q)));
    const { result } = renderHook(() => useRoute(route));

    act(() => result.current.start(A));
    await settle();
    expect(result.current.paths).toBeNull(); // one point is not routable

    act(() => result.current.addWaypoint(B));
    await settle();
    expect(result.current.paths).toHaveLength(1);
    expect(result.current.paths![0]!.points).toEqual([A, B]);
    expect(route.mock.calls[0]![0].alternatives).toBe(true); // 2 points → ask for alts

    act(() => result.current.stop());
    expect(result.current.active).toBe(false);
    expect(result.current.paths).toBeNull();
  });

  it('aborts a superseded query so a stale result never paints', async () => {
    const seen: AbortSignal[] = [];
    const route = vi.fn<RouteFn>((q, signal) => {
      seen.push(signal);
      return new Promise((resolve) => setTimeout(() => resolve(pathFor(q)), 1000));
    });
    const { result } = renderHook(() => useRoute(route));

    act(() => result.current.start(A));
    act(() => result.current.addWaypoint(B));
    await settle(); // first query in flight (resolves at t+1000)
    act(() => result.current.addWaypoint(C)); // supersedes it
    await settle();
    expect(seen[0]!.aborted).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    // Only the 3-point result painted; the aborted 2-point one was dropped.
    expect(result.current.paths![0]!.points).toEqual([A, B, C]);
  });

  it('plans round trips from a single anchor and newLoop re-rolls the seed', async () => {
    const route = vi.fn<RouteFn>((q) => Promise.resolve(pathFor(q)));
    const { result } = renderHook(() => useRoute(route));

    act(() => result.current.start(A));
    act(() => result.current.setRoundTrip(true));
    act(() => result.current.setRoundTripKm(25));
    await settle();
    const q1 = route.mock.calls.at(-1)![0];
    expect(q1.roundTrip).toEqual({ distanceM: 25_000, seed: 0 });

    act(() => result.current.newLoop());
    await settle();
    const q2 = route.mock.calls.at(-1)![0];
    expect(q2.roundTrip?.seed).toBe(1);

    // Adding while in loop mode moves the single anchor instead of appending.
    act(() => result.current.addWaypoint(B));
    expect(result.current.waypoints).toHaveLength(1);
    expect(result.current.waypoints[0]!.pos).toEqual(B);
  });

  it('surfaces RoutingError messages and a generic fallback', async () => {
    let fail: Error = new RoutingError('No route between these points');
    const route = vi.fn<RouteFn>(() => Promise.reject(fail));
    const { result } = renderHook(() => useRoute(route));

    act(() => result.current.start(A));
    act(() => result.current.addWaypoint(B));
    await settle();
    expect(result.current.error).toBe('No route between these points');
    expect(result.current.paths).toBeNull();

    fail = new Error('ECONNREFUSED');
    act(() => result.current.addWaypoint(C));
    await settle();
    expect(result.current.error).toBe('Routing service unavailable');
  });

  it('keeps waypoint identity through insert/move/reorder/optimize', async () => {
    const route = vi.fn<RouteFn>((q) => Promise.resolve(pathFor(q)));
    const { result } = renderHook(() => useRoute(route));

    act(() => result.current.start(A));
    act(() => result.current.addWaypoint(B));
    const [wa, wb] = result.current.waypoints;
    act(() => result.current.insertWaypoint(1, C));
    expect(result.current.waypoints.map((w) => w.pos)).toEqual([A, C, B]);
    // The pre-existing waypoints kept their ids across the insert.
    expect(result.current.waypoints[0]!.id).toBe(wa!.id);
    expect(result.current.waypoints[2]!.id).toBe(wb!.id);

    act(() => result.current.moveWaypointTo(wa!.id, C));
    expect(result.current.waypoints[0]!.pos).toEqual(C);

    act(() => result.current.reorderWaypoint(0, 2));
    expect(result.current.waypoints[2]!.id).toBe(wa!.id);

    act(() => result.current.reverse());
    expect(result.current.waypoints[0]!.id).toBe(wa!.id);

    act(() => result.current.removeWaypoint(wa!.id));
    expect(result.current.waypoints.find((w) => w.id === wa!.id)).toBeUndefined();
  });

  it('labels stops, and refuses labels that no longer describe the stop', async () => {
    const route = vi.fn<RouteFn>((q) => Promise.resolve(pathFor(q)));
    const { result } = renderHook(() => useRoute(route));

    act(() => result.current.start(A));
    let id = 0;
    act(() => {
      id = result.current.addWaypoint(B, 'Oslo S');
    });
    expect(result.current.waypoints[1]!.name).toBe('Oslo S');
    expect(result.current.waypoints[0]!.name).toBeUndefined();

    // A late lookup for an unnamed stop still applies.
    const wa = result.current.waypoints[0]!;
    act(() => result.current.nameWaypoint(wa.id, 'Home', A));
    expect(result.current.waypoints[0]!.name).toBe('Home');

    // …but not over a name the stop already has.
    act(() => result.current.nameWaypoint(id, 'Somewhere else', B));
    expect(result.current.waypoints[1]!.name).toBe('Oslo S');

    // Moving a stop drops its label; a lookup for the old spot is stale and
    // must not be applied to the new one.
    act(() => result.current.moveWaypointTo(id, C));
    expect(result.current.waypoints[1]!.name).toBeUndefined();
    act(() => result.current.nameWaypoint(id, 'Oslo S', B));
    expect(result.current.waypoints[1]!.name).toBeUndefined();

    // A lookup matching where the stop actually is now does apply.
    act(() => result.current.nameWaypoint(id, 'Bergen', C));
    expect(result.current.waypoints[1]!.name).toBe('Bergen');

    // A label for a removed stop is a no-op, not a crash.
    act(() => result.current.removeWaypoint(id));
    act(() => result.current.nameWaypoint(id, 'Ghost', C));
    expect(result.current.waypoints).toHaveLength(1);
  });
});
