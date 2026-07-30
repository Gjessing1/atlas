import type { SearchResult } from '@atlas/core';
import type { RoutePath } from '@atlas/routing';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useNavAddStop, type FetchNearbyFn } from './useNavAddStop.js';
import type { NavController } from './useNavigationController.js';

/** A straight eastward route at lat 60: 21 points, lng 10.000 → 10.020 (~1.1 km). */
const points = Array.from({ length: 21 }, (_, i) => ({ lat: 60, lng: 10 + i * 0.001 }));

const activePath: RoutePath = {
  points,
  distanceM: 1113,
  timeMs: 600_000,
  ascentM: 0,
  descentM: 0,
};

/** The controller surface the hook actually reads, at ~index 2 of the line. */
function fakeNav(over: Partial<NavController> = {}): NavController {
  return {
    phase: 'navigating',
    activePath,
    state: { snapped: points[2]!, traveledM: 111 },
    addStop: vi.fn(),
    ...over,
  } as unknown as NavController;
}

const hit = (name: string, lat: number, lng: number): SearchResult => ({
  name,
  label: 'Somewhere',
  position: { lat, lng },
});

describe('useNavAddStop', () => {
  it('keeps only corridor candidates still ahead, sorted by route distance', async () => {
    // Behind the car; on the line ahead; slightly off the line further ahead;
    // and far outside the corridor — only the middle two survive, in order.
    const fetchNearby = vi.fn<FetchNearbyFn>(() =>
      Promise.resolve([
        hit('Behind', 60, 10.001),
        hit('Off the line', 60.0018, 10.015),
        hit('On the line', 60, 10.01),
        hit('Far away', 60.1, 10.01),
      ]),
    );
    const nav = fakeNav();
    const { result } = renderHook(() => useNavAddStop({ nav, fetchNearby }));

    act(() => result.current.setOpen(true));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    expect(result.current.hits.map((h) => h.name)).toEqual(['On the line', 'Off the line']);
    expect(result.current.hits[0]!.aheadM).toBeGreaterThan(300);
    expect(result.current.hits[1]!.offRouteM).toBeGreaterThan(100);
    expect(fetchNearby).toHaveBeenCalledWith(
      'fuel',
      points[2],
      expect.any(Number),
      expect.any(AbortSignal),
    );
  });

  it('re-queries when the category changes', async () => {
    const fetchNearby = vi.fn<FetchNearbyFn>(() => Promise.resolve([hit('X', 60, 10.01)]));
    const nav = fakeNav();
    const { result } = renderHook(() => useNavAddStop({ nav, fetchNearby }));
    act(() => result.current.setOpen(true));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    act(() => result.current.setCategory('food'));
    await waitFor(() =>
      expect(fetchNearby).toHaveBeenCalledWith(
        'food',
        points[2],
        expect.any(Number),
        expect.any(AbortSignal),
      ),
    );
  });

  it('picking a hit adds the stop and closes the panel', async () => {
    const fetchNearby = vi.fn<FetchNearbyFn>(() => Promise.resolve([hit('Stop', 60, 10.01)]));
    const nav = fakeNav();
    const { result } = renderHook(() => useNavAddStop({ nav, fetchNearby }));
    act(() => result.current.setOpen(true));
    await waitFor(() => expect(result.current.hits).toHaveLength(1));

    act(() => result.current.pick(result.current.hits[0]!));

    expect(nav.addStop).toHaveBeenCalledWith({ lat: 60, lng: 10.01 });
    expect(result.current.open).toBe(false);
  });

  it('reports a failed lookup and closes with the trip', async () => {
    const fetchNearby = vi.fn<FetchNearbyFn>(() => Promise.reject(new Error('offline')));
    const nav = fakeNav();
    const { result, rerender } = renderHook(({ n }) => useNavAddStop({ nav: n, fetchNearby }), {
      initialProps: { n: nav },
    });
    act(() => result.current.setOpen(true));
    await waitFor(() => expect(result.current.status).toBe('error'));

    rerender({ n: fakeNav({ phase: 'arrived' }) });
    expect(result.current.open).toBe(false);
  });
});
