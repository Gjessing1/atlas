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

  it('plans a loop from its anchor, re-rolls the seed, and takes stops on the way', async () => {
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

    // A loop takes stops like any other plan: B is somewhere to go by way of,
    // not a replacement anchor, and the query carries both points.
    act(() => result.current.addWaypoint(B));
    await settle();
    expect(result.current.waypoints.map((w) => w.pos)).toEqual([A, B]);
    const q3 = route.mock.calls.at(-1)![0];
    expect(q3.points).toEqual([A, B]);
    expect(q3.roundTrip?.distanceM).toBe(25_000);
  });

  it('turns a loop into a route from its anchor when a destination is added', async () => {
    const route = vi.fn<RouteFn>((q) => Promise.resolve(pathFor(q)));
    const { result } = renderHook(() => useRoute(route));

    act(() => result.current.start(A));
    act(() => result.current.setRoundTrip(true));
    await settle();

    // "Directions to B" while a loop is planned: the anchor is where the
    // traveller is, so it becomes the start rather than being overwritten.
    // Both halves in one commit — setRoundTrip(false) then addWaypoint(B)
    // would still take the loop branch and drop A.
    act(() => result.current.addDestination(B, 'Bergen'));
    await settle();
    expect(result.current.roundTrip).toBe(false);
    expect(result.current.waypoints.map((w) => w.pos)).toEqual([A, B]);
    expect(result.current.waypoints[1]!.name).toBe('Bergen');
    expect(route.mock.calls.at(-1)![0].points).toEqual([A, B]);
    expect(route.mock.calls.at(-1)![0].roundTrip).toBeUndefined();
  });

  it('routes every mode in the background so the picker can show trip times', async () => {
    const timeByProfile: Record<string, number> = {
      car: 1_440_000,
      bike: 4_200_000,
      foot: 10_800_000,
    };
    const route = vi.fn<RouteFn>((q) => {
      // Hike has no route here — its chip must read "no time", not a stale one.
      if (q.profile === 'hike') return Promise.reject(new RoutingError('no hike route'));
      return Promise.resolve({
        paths: [
          {
            points: q.points.map((p) => ({ ...p })),
            distanceM: 1000,
            timeMs: timeByProfile[q.profile] ?? 60_000,
            ascentM: 0,
            descentM: 0,
          },
        ],
      });
    });
    const { result } = renderHook(() => useRoute(route));

    act(() => result.current.start(A));
    act(() => result.current.addWaypoint(B));
    // Main re-route debounce (250) then the background mode-times pass (400).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(result.current.modeTimes.car).toBe(1_440_000);
    expect(result.current.modeTimes.bike).toBe(4_200_000);
    expect(result.current.modeTimes.foot).toBe(10_800_000);
    expect(result.current.modeTimes.hike).toBe('none'); // rejection → no time to show

    // The background pass is lightweight — no alternatives, no instructions —
    // and covers all five road profiles once.
    const bgProfiles = route.mock.calls
      .filter(([q]) => q.alternatives === false && q.instructions === false)
      .map(([q]) => q.profile)
      .sort();
    expect(bgProfiles).toEqual(['bike', 'car', 'foot', 'hike', 'run']);

    // A loop is not comparable across modes, so the times stand down.
    act(() => result.current.setRoundTrip(true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(result.current.modeTimes).toEqual({});
  });

  it('does not churn when handed a fresh route callback on every render', async () => {
    const impl = vi.fn<RouteFn>((q) => Promise.resolve(pathFor(q)));
    // A brand-new closure each render — the identity the hook must not react to.
    // Before the ref hardening this drove the background mode-times pass into a
    // render/request loop that exhausted the heap.
    const { result, rerender } = renderHook(() => useRoute((q, s) => impl(q, s)));

    act(() => result.current.start(A));
    act(() => result.current.addWaypoint(B));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    for (let i = 0; i < 5; i++) {
      rerender();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
    }

    // One main query plus a single four-mode background pass. Re-renders with a
    // new callback add nothing — a loop would put this in the hundreds.
    expect(impl.mock.calls.length).toBeLessThan(12);
    expect(result.current.modeTimes.car).toBe(60_000);
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
  it('exposes the plan for storage and restores it verbatim', () => {
    const route = vi.fn<RouteFn>((q) => Promise.resolve(pathFor(q)));
    const { result } = renderHook(() => useRoute(route));

    expect(result.current.plan).toBeNull(); // route mode closed

    act(() => result.current.start(A, 'Home'));
    act(() => void result.current.addWaypoint(B));
    act(() => result.current.setProfile('bike'));
    act(() => result.current.setPreference('preferTrails', true));

    expect(result.current.plan).toEqual({
      profile: 'bike',
      waypoints: [{ pos: A, name: 'Home' }, { pos: B }],
      preferences: { preferTrails: true },
    });

    // A fresh planner (the reload) comes back to the same stops and profile.
    const reloaded = renderHook(() => useRoute(route));
    act(() => reloaded.result.current.restore(result.current.plan!));
    expect(reloaded.result.current.active).toBe(true);
    expect(reloaded.result.current.profile).toBe('bike');
    expect(reloaded.result.current.preferences.preferTrails).toBe(true);
    expect(reloaded.result.current.waypoints.map((w) => w.pos)).toEqual([A, B]);
    expect(reloaded.result.current.waypoints[0]!.name).toBe('Home');
    // Restored stops still get distinct ids, so markers and rows stay keyed.
    expect(reloaded.result.current.waypoints[0]!.id).not.toBe(
      reloaded.result.current.waypoints[1]!.id,
    );

    // A legacy/default plan must not inherit a customization from the plan
    // that happened to be open before it.
    act(() =>
      reloaded.result.current.restore({
        profile: 'bike',
        waypoints: [{ pos: A }, { pos: C }],
      }),
    );
    expect(reloaded.result.current.preferences.preferTrails).toBe(false);
  });

  it('round-trips a loop plan, stops and all', () => {
    const route = vi.fn<RouteFn>((q) => Promise.resolve(pathFor(q)));
    const { result } = renderHook(() => useRoute(route));

    act(() => result.current.start(A));
    act(() => result.current.setRoundTrip(true));
    act(() => result.current.setRoundTripKm(25));
    expect(result.current.plan).toEqual({
      profile: 'car',
      waypoints: [{ pos: A }],
      roundTripKm: 25,
    });

    const reloaded = renderHook(() => useRoute(route));
    // A shared loop keeps the places it was planned through — dropping them
    // would reopen the link as a different trip of the same length.
    act(() =>
      reloaded.result.current.restore({
        profile: 'foot',
        waypoints: [{ pos: A }, { pos: B }],
        roundTripKm: 8,
      }),
    );
    expect(reloaded.result.current.roundTrip).toBe(true);
    expect(reloaded.result.current.roundTripKm).toBe(8);
    expect(reloaded.result.current.waypoints.map((w) => w.pos)).toEqual([A, B]);
  });

  it('ignores a restore with no stops', () => {
    const route = vi.fn<RouteFn>((q) => Promise.resolve(pathFor(q)));
    const { result } = renderHook(() => useRoute(route));
    act(() => result.current.restore({ profile: 'car', waypoints: [] }));
    expect(result.current.active).toBe(false);
    expect(result.current.waypoints).toEqual([]);
  });
});
