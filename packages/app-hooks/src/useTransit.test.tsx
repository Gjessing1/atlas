// @vitest-environment jsdom
import type { LatLng } from '@atlas/core';
import type { TransitResult, TransitTrip } from '@atlas/transit';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRoute } from './useRoute.js';
import { useTransitPlan, type TransitFn } from './useTransit.js';

/** Both inside the Norwegian coverage box. */
const OSLO: LatLng = { lat: 59.91, lng: 10.75 };
const BERGEN: LatLng = { lat: 60.39, lng: 5.32 };
/** Outside it — the mode must not be offered at all (the NVDB precedent). */
const BERLIN: LatLng = { lat: 52.52, lng: 13.4 };

function tripAt(startMs: number): TransitTrip {
  return {
    startMs,
    endMs: startMs + 900_000,
    durationMs: 900_000,
    walkDistanceM: 300,
    legs: [],
  };
}

function result(...starts: number[]): TransitResult {
  return { trips: starts.map(tripAt) };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/** Flush the 250ms query debounce plus the async planner call. */
async function settle(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
  });
}

/**
 * A plan with the given endpoints, driven through the real `useRoute` so the
 * transit hook sees the waypoint shape it will see in the apps.
 */
function renderPlan(transit: TransitFn, points: LatLng[]) {
  const view = renderHook(() => {
    const route = useRoute(() => Promise.resolve({ paths: [] }));
    return { route, transit: useTransitPlan(route, transit) };
  });
  act(() => {
    view.result.current.route.start(points[0]);
  });
  for (const p of points.slice(1)) {
    act(() => {
      view.result.current.route.addWaypoint(p);
    });
  }
  return view;
}

describe('useTransitPlan', () => {
  it('offers the mode inside coverage and plans between the plan ends', async () => {
    const transit = vi.fn<TransitFn>(() => Promise.resolve(result(1_000)));
    const { result: r } = renderPlan(transit, [OSLO, BERGEN]);

    expect(r.current.transit.offered).toBe(true);
    // Offered is not chosen: nothing is asked until the traveller picks transit.
    expect(transit).not.toHaveBeenCalled();

    act(() => r.current.transit.setEnabled(true));
    await settle();

    expect(transit).toHaveBeenCalledTimes(1);
    expect(transit.mock.calls[0]![0]).toMatchObject({ from: OSLO, to: BERGEN });
    expect(r.current.transit.trips).toHaveLength(1);
  });

  it('plans between the ends only, ignoring via points a timetable cannot honour', async () => {
    const transit = vi.fn<TransitFn>(() => Promise.resolve(result(1_000)));
    const mid: LatLng = { lat: 60.0, lng: 9.0 };
    const { result: r } = renderPlan(transit, [OSLO, mid, BERGEN]);

    act(() => r.current.transit.setEnabled(true));
    await settle();

    expect(transit.mock.calls[0]![0]).toMatchObject({ from: OSLO, to: BERGEN });
  });

  it('offers the mode before a destination exists, so it is findable at all', () => {
    const transit = vi.fn<TransitFn>(() => Promise.resolve(result()));
    const { result: r } = renderPlan(transit, [OSLO]);

    // Not yet answerable — but "we don't know your destination" must not be
    // rendered as "this app has no public transport".
    expect(r.current.transit.covered).toBe(false);
    expect(r.current.transit.offered).toBe(true);
    expect(transit).not.toHaveBeenCalled();
  });

  it('does not offer the mode outside coverage', () => {
    const transit = vi.fn<TransitFn>(() => Promise.resolve(result()));
    const { result: r } = renderPlan(transit, [OSLO, BERLIN]);

    expect(r.current.transit.covered).toBe(false);
    expect(r.current.transit.offered).toBe(false);
  });

  it('does not offer the mode for a round trip, and switches off if one is started', async () => {
    const transit = vi.fn<TransitFn>(() => Promise.resolve(result(1_000)));
    const { result: r } = renderPlan(transit, [OSLO, BERGEN]);

    act(() => r.current.transit.setEnabled(true));
    await settle();
    expect(r.current.transit.enabled).toBe(true);

    // A loop is not a journey — the mode must stand down, not fail silently.
    act(() => r.current.route.setRoundTrip(true));
    expect(r.current.transit.offered).toBe(false);
    expect(r.current.transit.enabled).toBe(false);
  });

  it('leads with the best option again when a fresh set of departures arrives', async () => {
    const transit = vi
      .fn<TransitFn>()
      .mockResolvedValueOnce(result(1_000, 2_000, 3_000))
      .mockResolvedValueOnce(result(9_000, 10_000));
    const { result: r } = renderPlan(transit, [OSLO, BERGEN]);

    act(() => r.current.transit.setEnabled(true));
    await settle();

    act(() => r.current.transit.select(2));
    expect(r.current.transit.trip?.startMs).toBe(3_000);

    // Re-asking replaces the list; index 2 would now point at nothing (or worse,
    // at a different journey), so the selection resets to the best option.
    act(() => r.current.transit.refresh());
    await settle();
    expect(r.current.transit.selected).toBe(0);
    expect(r.current.transit.trip?.startMs).toBe(9_000);
  });

  it('reports a planner failure as an error rather than an empty timetable', async () => {
    const transit = vi.fn<TransitFn>(() => Promise.reject(new Error('offline')));
    const { result: r } = renderPlan(transit, [OSLO, BERGEN]);

    act(() => r.current.transit.setEnabled(true));
    await settle();

    expect(r.current.transit.error).toMatch(/planner unavailable/i);
    // An empty array would read as "nothing runs then" — a different answer.
    expect(r.current.transit.trips).toBeNull();
  });
});
