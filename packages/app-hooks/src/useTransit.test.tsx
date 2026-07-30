// @vitest-environment jsdom
import type { LatLng } from '@atlas/core';
import type { TransitResult, TransitTrip } from '@atlas/transit';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRoute, type RouteFn } from './useRoute.js';
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
  return { trips: starts.map(tripAt), problems: [] };
}

/** An answer that also offers pages either side of it. */
function paged(next: string, previous: string, ...starts: number[]): TransitResult {
  return { ...result(...starts), nextCursor: next, previousCursor: previous };
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
// Stable across renders, like the real apps' fetcher — an inline arrow here
// would hand `useRoute` a fresh identity every render, which the hook tolerates
// but a test should not depend on.
const emptyRoute: RouteFn = () => Promise.resolve({ paths: [] });

function renderPlan(transit: TransitFn, points: LatLng[]) {
  const view = renderHook(() => {
    const route = useRoute(emptyRoute);
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
    // Asked as soon as it is offered, not once it is chosen: the mode picker
    // shows a trip time per mode, and transit's has to arrive with the others.
    await settle();
    expect(transit).toHaveBeenCalledTimes(1);
    expect(transit.mock.calls[0]![0]).toMatchObject({ from: OSLO, to: BERGEN });
    expect(r.current.transit.trips).toHaveLength(1);

    // Picking the mode then paints what is already in hand — no second ask.
    act(() => r.current.transit.setEnabled(true));
    await settle();
    expect(transit).toHaveBeenCalledTimes(1);
    expect(r.current.transit.trips).toHaveLength(1);
  });

  it('plans from the exact NSR stops selected in transit search', async () => {
    const transit = vi.fn<TransitFn>(() => Promise.resolve(result(1_000)));
    const view = renderHook(() => {
      const route = useRoute(emptyRoute);
      return { route, transit: useTransitPlan(route, transit) };
    });
    act(() =>
      view.result.current.route.restore({
        profile: 'car',
        waypoints: [
          { pos: OSLO, name: 'Oslo S', transitStopId: 'NSR:StopPlace:59872' },
          { pos: BERGEN, name: 'Bergen', transitStopId: 'NSR:StopPlace:58366' },
        ],
      }),
    );

    await settle();
    expect(transit.mock.calls[0]![0]).toMatchObject({
      from: { ...OSLO, stopId: 'NSR:StopPlace:59872' },
      to: { ...BERGEN, stopId: 'NSR:StopPlace:58366' },
    });
  });

  it('sends every intermediate waypoint as an ordered timetable visit', async () => {
    const transit = vi.fn<TransitFn>(() => Promise.resolve(result(1_000)));
    const mid: LatLng = { lat: 60.0, lng: 9.0 };
    const { result: r } = renderPlan(transit, [OSLO, mid, BERGEN]);

    act(() => r.current.transit.setEnabled(true));
    await settle();

    expect(transit.mock.calls[0]![0]).toMatchObject({
      from: OSLO,
      via: [mid],
      to: BERGEN,
    });
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

  it('pages with the planner’s own cursor rather than nudging the clock', async () => {
    const transit = vi
      .fn<TransitFn>()
      .mockResolvedValueOnce(paged('next-1', 'prev-1', 1_000, 2_000))
      .mockResolvedValueOnce(paged('next-2', 'prev-2', 3_000, 4_000));
    const { result: r } = renderPlan(transit, [OSLO, BERGEN]);

    act(() => r.current.transit.setEnabled(true));
    await settle();
    expect(r.current.transit.pageLater).not.toBeNull();

    act(() => r.current.transit.pageLater!());
    await settle();

    const asked = transit.mock.calls[1]![0];
    expect(asked.pageCursor).toBe('next-1');
    // A cursor already carries the window it came from; sending a time too
    // would be two competing instructions.
    expect(asked.dateTimeMs).toBeUndefined();
    expect(r.current.transit.trips?.[0]?.startMs).toBe(3_000);
  });

  it('offers no page control where the planner has none', async () => {
    // At the last departure of the service day there is genuinely no "later" —
    // a dead button would claim otherwise.
    const transit = vi.fn<TransitFn>(() => Promise.resolve(result(1_000)));
    const { result: r } = renderPlan(transit, [OSLO, BERGEN]);

    act(() => r.current.transit.setEnabled(true));
    await settle();

    expect(r.current.transit.pageLater).toBeNull();
    expect(r.current.transit.pageEarlier).toBeNull();
  });

  it('drops the cursor when the question changes', async () => {
    const transit = vi
      .fn<TransitFn>()
      .mockResolvedValueOnce(paged('next-1', 'prev-1', 1_000))
      .mockResolvedValueOnce(paged('next-2', 'prev-2', 3_000))
      .mockResolvedValue(result(9_000));
    const { result: r } = renderPlan(transit, [OSLO, BERGEN]);

    act(() => r.current.transit.setEnabled(true));
    await settle();
    act(() => r.current.transit.pageLater!());
    await settle();

    // Changing the departure time asks a different question; carrying the old
    // page cursor into it would page through the answer to the previous one.
    act(() => r.current.transit.setTimeMs(5_000_000));
    await settle();
    const asked = transit.mock.calls[2]![0];
    expect(asked.pageCursor).toBeUndefined();
    expect(asked.dateTimeMs).toBe(5_000_000);
  });

  it('carries the planner’s reason for an empty answer', async () => {
    const transit = vi.fn<TransitFn>(() =>
      Promise.resolve({ trips: [], problems: [{ code: 'noStopsInRange' as const }] }),
    );
    const { result: r } = renderPlan(transit, [OSLO, BERGEN]);

    act(() => r.current.transit.setEnabled(true));
    await settle();

    // An answer, not a failure — the board must not use error language for it.
    expect(r.current.transit.error).toBeNull();
    expect(r.current.transit.problems).toEqual([{ code: 'noStopsInRange' }]);
  });

  it('reports a planner failure as an error rather than an empty timetable', async () => {
    const transit = vi.fn<TransitFn>(() => Promise.reject(new Error('offline')));
    const { result: r } = renderPlan(transit, [OSLO, BERGEN]);

    act(() => r.current.transit.setEnabled(true));
    await settle();

    expect(r.current.transit.error).toMatch(/planner unavailable/i);
    // An empty array would read as "nothing runs then" — a different answer.
    expect(r.current.transit.trips).toBeNull();
    // Nothing on screen, so there is no age to claim for it either.
    expect(r.current.transit.updatedMs).toBeNull();
  });

  it('stamps when the shown timetable was fetched', async () => {
    // The board quotes this so an answer kept open off-grid ages visibly:
    // transit is the one thing here that cannot be recomputed locally.
    vi.setSystemTime(new Date(2026, 6, 21, 8, 41));
    const transit = vi.fn<TransitFn>(() => Promise.resolve(result(1_000)));
    const { result: r } = renderPlan(transit, [OSLO, BERGEN]);

    act(() => r.current.transit.setEnabled(true));
    await settle();

    // The moment the answer landed — one debounce after the question.
    const asked = new Date(2026, 6, 21, 8, 41).getTime();
    expect(r.current.transit.updatedMs).toBeGreaterThanOrEqual(asked);
    expect(r.current.transit.updatedMs).toBeLessThanOrEqual(asked + 300);
  });
});
