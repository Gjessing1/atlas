import type { SearchResult } from '@atlas/core';
import { cumulativeDistances } from '@atlas/navigation';
import type { RoutePath } from '@atlas/routing';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { FetchNearbyFn } from './useNavAddStop.js';
import {
  routeSampleCircles,
  routeStopCategories,
  spreadAlongRoute,
  useRouteStops,
  type RouteStopHit,
} from './useRouteStops.js';

/** A straight eastward route at lat 60: lng 10.00 → 10.40 (~22 km). */
const points = Array.from({ length: 41 }, (_, i) => ({ lat: 60, lng: 10 + i * 0.01 }));

const path = { points, distanceM: 22_270, timeMs: 1_200_000 } as unknown as RoutePath;
const waypoints = [points[0]!, points[points.length - 1]!];

const hit = (name: string, lat: number, lng: number): SearchResult => ({
  name,
  label: 'Somewhere',
  position: { lat, lng },
});

describe('routeStopCategories', () => {
  it('offers fuel and charging to drivers only', () => {
    const driving = routeStopCategories('car').map((c) => c.id);
    expect(driving).toContain('fuel');
    expect(driving).toContain('supermarket');
    expect(driving).toContain('rest-area');
    const walk = routeStopCategories('foot').map((c) => c.id);
    expect(walk).not.toContain('fuel');
    expect(walk).not.toContain('charging');
    expect(walk).toContain('nature');
  });
});

describe('routeSampleCircles', () => {
  it('covers a short route with one circle and a long one with several', () => {
    const short = [
      { lat: 60, lng: 10 },
      { lat: 60, lng: 10.02 },
    ];
    expect(routeSampleCircles(short, cumulativeDistances(short))).toHaveLength(1);

    const circles = routeSampleCircles(points, cumulativeDistances(points));
    expect(circles).toHaveLength(2);
    // Consecutive circles overlap by more than the 3 km corridor, so nothing
    // on the route falls between two samples.
    const gap = circles[1]!.center.lng - circles[0]!.center.lng;
    expect(gap).toBeGreaterThan(0);
    expect(circles[0]!.radiusM).toBeGreaterThanOrEqual(8_000);
  });

  it('never asks for a radius the backend would clamp', () => {
    // ~900 km: the sample count is capped, so the radii widen instead.
    const long = Array.from({ length: 101 }, (_, i) => ({ lat: 60, lng: 10 + i * 0.16 }));
    const circles = routeSampleCircles(long, cumulativeDistances(long));
    expect(circles).toHaveLength(8);
    for (const circle of circles) expect(circle.radiusM).toBeLessThanOrEqual(50_000);
  });
});

describe('spreadAlongRoute', () => {
  const candidate = (name: string, alongM: number, offRouteM: number): RouteStopHit => ({
    name,
    label: '',
    position: { lat: 60, lng: 10 },
    alongM,
    offRouteM,
    insertIndex: 1,
  });

  it('offers stops across the whole trip instead of one dense suburb', () => {
    // Twelve stations in the first 9 km (the city being left) and three spread
    // over the remaining 90 km — the far ones must survive.
    const dense = Array.from({ length: 12 }, (_, i) =>
      candidate(`City ${i}`, 1_000 + i * 700, 100 + i * 20),
    );
    const far = [
      candidate('Halfway', 50_000, 800),
      candidate('Later', 75_000, 400),
      candidate('Near the end', 95_000, 250),
    ];
    const spread = spreadAlongRoute([...dense, ...far], 100_000, 5);

    expect(spread.map((h) => h.name)).toContain('Halfway');
    expect(spread.map((h) => h.name)).toContain('Later');
    expect(spread.map((h) => h.name)).toContain('Near the end');
    expect(spread).toHaveLength(5);
    // Still ordered the way the trip is driven.
    expect(spread.map((h) => h.alongM)).toEqual(
      [...spread.map((h) => h.alongM)].sort((a, b) => a - b),
    );
    // Each stretch keeps its most convenient stop, not just its first.
    expect(spread[0]!.name).toBe('City 0');
  });

  it('keeps a short list whole, in route order', () => {
    const hits = [candidate('B', 900, 10), candidate('A', 100, 900)];
    expect(spreadAlongRoute(hits, 10_000, 10).map((h) => h.name)).toEqual(['A', 'B']);
  });
});

describe('useRouteStops', () => {
  it('lists corridor candidates in route order with their detour distance', async () => {
    const fetchNearby = vi.fn<FetchNearbyFn>(() =>
      Promise.resolve([
        hit('Late stop', 60, 10.3),
        hit('Off the line', 60.02, 10.1),
        hit('Early stop', 60, 10.05),
        hit('Another county', 61, 10.2),
      ]),
    );
    const { result } = renderHook(() =>
      useRouteStops({ path, waypoints, profile: 'car', active: true, fetchNearby }),
    );

    await waitFor(() => expect(result.current.status).toBe('ready'));
    // Route order, not the order the geocoder happened to answer in; the one
    // outside the corridor is gone.
    expect(result.current.hits.map((h) => h.name)).toEqual([
      'Early stop',
      'Off the line',
      'Late stop',
    ]);
    expect(result.current.hits[0]!.alongM).toBeLessThan(result.current.hits[2]!.alongM);
    expect(result.current.hits[1]!.offRouteM).toBeGreaterThan(1_000);
    // A two-stop plan has one leg, so everything inserts before the end.
    expect(result.current.hits.map((h) => h.insertIndex)).toEqual([1, 1, 1]);
  });

  it('deduplicates the overlap between two samples', async () => {
    const fetchNearby = vi.fn<FetchNearbyFn>(() => Promise.resolve([hit('Shell', 60, 10.2)]));
    const { result } = renderHook(() =>
      useRouteStops({ path, waypoints, profile: 'car', active: true, fetchNearby }),
    );

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(fetchNearby.mock.calls.length).toBeGreaterThan(1);
    expect(result.current.hits).toHaveLength(1);
  });

  it('fetches nothing while collapsed', async () => {
    const fetchNearby = vi.fn<FetchNearbyFn>(() => Promise.resolve([]));
    const { result } = renderHook(() =>
      useRouteStops({ path, waypoints, profile: 'car', active: false, fetchNearby }),
    );

    await act(async () => {});
    expect(fetchNearby).not.toHaveBeenCalled();
    expect(result.current.status).toBe('idle');
  });

  it('re-queries on a category change and falls back when a mode drops one', async () => {
    const fetchNearby = vi.fn<FetchNearbyFn>(() => Promise.resolve([]));
    const { result, rerender } = renderHook(
      (props: { profile: string }) =>
        useRouteStops({ path, waypoints, profile: props.profile, active: true, fetchNearby }),
      { initialProps: { profile: 'car' } },
    );
    await waitFor(() => expect(result.current.category).toBe('fuel'));

    act(() => result.current.setCategory('coffee'));
    await waitFor(() =>
      expect(fetchNearby).toHaveBeenCalledWith(
        'coffee',
        expect.anything(),
        expect.any(Number),
        expect.any(AbortSignal),
      ),
    );

    // Walking has no fuel column; a stale driving category must not stick.
    act(() => result.current.setCategory('fuel'));
    rerender({ profile: 'foot' });
    await waitFor(() => expect(result.current.category).toBe('food'));
  });

  it('reports an error only when every sample fails', async () => {
    const failing = vi.fn<FetchNearbyFn>(() => Promise.reject(new Error('explore down')));
    const { result } = renderHook(() =>
      useRouteStops({ path, waypoints, profile: 'car', active: true, fetchNearby: failing }),
    );
    await waitFor(() => expect(result.current.status).toBe('error'));

    let calls = 0;
    const half = vi.fn<FetchNearbyFn>(() =>
      ++calls === 1
        ? Promise.reject(new Error('one hole'))
        : Promise.resolve([hit('Esso', 60, 10.3)]),
    );
    const second = renderHook(() =>
      useRouteStops({ path, waypoints, profile: 'car', active: true, fetchNearby: half }),
    );
    await waitFor(() => expect(second.result.current.status).toBe('ready'));
    expect(second.result.current.hits.map((h) => h.name)).toEqual(['Esso']);
  });
});
