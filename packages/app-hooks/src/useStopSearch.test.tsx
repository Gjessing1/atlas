// @vitest-environment jsdom
import type { SearchResult } from '@atlas/core';
import type { RoutePath } from '@atlas/routing';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RouteDetourEstimate } from './useRoute.js';
import {
  useAlongRouteSearch,
  useStopSearch,
  type StopGeocodeFn,
  type StopSearchPlace,
} from './useStopSearch.js';

const OSLO_S: StopSearchPlace = { name: 'Oslo S', lat: 59.9106, lng: 10.7522 };
const HOME: StopSearchPlace = { name: 'Home', lat: 59.92, lng: 10.75 };

function hit(name: string, lat: number, lng: number): SearchResult {
  return { name, label: 'Oslo', position: { lat, lng } };
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  vi.useRealTimers();
});

/** Let the debounce fire and the queued promises settle. */
async function settle(ms = 300): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('useStopSearch', () => {
  it('asks nothing until the query is worth geocoding', async () => {
    const geocode = vi.fn<StopGeocodeFn>().mockResolvedValue([]);
    const { result } = renderHook(() => useStopSearch({ geocode, places: [] }));

    act(() => result.current.setQuery('o'));
    await settle();
    expect(geocode).not.toHaveBeenCalled();
    expect(result.current.hits).toEqual([]);
  });

  it('lists saved places before geocoder results', async () => {
    const geocode = vi.fn<StopGeocodeFn>().mockResolvedValue([hit('Oslo Airport', 60.19, 11.1)]);
    const { result } = renderHook(() =>
      useStopSearch({ geocode, places: [OSLO_S, HOME], debounceMs: 250 }),
    );

    act(() => result.current.setQuery('Oslo'));
    await settle();

    await waitFor(() => expect(result.current.hits).toHaveLength(2));
    expect(result.current.hits.map((h) => [h.name, h.saved])).toEqual([
      ['Oslo S', true],
      ['Oslo Airport', false],
    ]);
  });

  it('still offers saved places when the geocoder fails', async () => {
    const geocode = vi.fn<StopGeocodeFn>().mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useStopSearch({ geocode, places: [OSLO_S] }));

    act(() => result.current.setQuery('Oslo'));
    await settle();

    await waitFor(() => expect(result.current.hits.map((h) => h.name)).toEqual(['Oslo S']));
  });

  it('debounces a query being typed into a single request', async () => {
    const geocode = vi.fn<StopGeocodeFn>().mockResolvedValue([]);
    const { result } = renderHook(() => useStopSearch({ geocode, places: [] }));

    act(() => result.current.setQuery('Os'));
    act(() => result.current.setQuery('Osl'));
    act(() => result.current.setQuery('Oslo'));
    await settle();

    expect(geocode).toHaveBeenCalledTimes(1);
    expect(geocode.mock.calls[0]![0]!.text).toBe('Oslo');
  });

  it('aborts the in-flight request when the query moves on', async () => {
    const seen: AbortSignal[] = [];
    const geocode = vi.fn<StopGeocodeFn>(async ({ signal }) => {
      seen.push(signal);
      return [];
    });
    const { result } = renderHook(() => useStopSearch({ geocode, places: [] }));

    act(() => result.current.setQuery('Oslo'));
    await settle();
    act(() => result.current.setQuery('Bergen'));
    await settle();

    expect(seen).toHaveLength(2);
    expect(seen[0]!.aborted).toBe(true);
    expect(seen[1]!.aborted).toBe(false);
  });

  it('caps the list, saved places first', async () => {
    const places: StopSearchPlace[] = Array.from({ length: 8 }, (_, i) => ({
      name: `Stop ${i}`,
      lat: 59.9 + i / 1000,
      lng: 10.7,
    }));
    const geocode = vi
      .fn<StopGeocodeFn>()
      .mockResolvedValue(
        Array.from({ length: 8 }, (_, i) => hit(`Remote ${i}`, 60 + i / 1000, 11)),
      );
    const { result } = renderHook(() => useStopSearch({ geocode, places, limit: 6 }));

    act(() => result.current.setQuery('Stop'));
    await settle();

    await waitFor(() => expect(result.current.hits).toHaveLength(6));
    // savedLimit of 4, then the geocoder fills the rest.
    expect(result.current.hits.filter((h) => h.saved)).toHaveLength(4);
  });

  it('clears query and results on reset', async () => {
    const geocode = vi.fn<StopGeocodeFn>().mockResolvedValue([]);
    const { result } = renderHook(() => useStopSearch({ geocode, places: [OSLO_S] }));

    act(() => result.current.setQuery('Oslo'));
    await settle();
    await waitFor(() => expect(result.current.hits).toHaveLength(1));

    act(() => result.current.reset());
    expect(result.current.query).toBe('');
    expect(result.current.hits).toEqual([]);
  });
});

/** A straight north-bound path through central Oslo. */
const PATH = {
  points: Array.from({ length: 20 }, (_, i) => ({ lat: 59.91 + i / 1000, lng: 10.75 })),
  distanceM: 2000,
  timeMs: 300_000,
  ascentM: 0,
  descentM: 0,
  hasFerry: false,
  instructions: [],
} as unknown as RoutePath;

const detour = (extraTimeMs: number): RouteDetourEstimate => ({
  insertIndex: 1,
  extraTimeMs,
  extraDistanceM: extraTimeMs / 100,
});

describe('useAlongRouteSearch', () => {
  it('stays idle while collapsed', async () => {
    const geocode = vi.fn<StopGeocodeFn>().mockResolvedValue([]);
    const estimateDetours = vi.fn().mockResolvedValue([]);
    const { result } = renderHook(() =>
      useAlongRouteSearch({
        geocode,
        places: [OSLO_S],
        path: PATH,
        estimateDetours,
        active: false,
      }),
    );

    act(() => result.current.setQuery('Oslo'));
    await settle();
    expect(geocode).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(false);
  });

  it('costs saved places before the geocoder answers, then merges remote hits', async () => {
    let releaseRemote: (results: SearchResult[]) => void = () => {};
    const geocode = vi.fn<StopGeocodeFn>(
      () => new Promise<SearchResult[]>((resolve) => (releaseRemote = resolve)),
    );
    const estimateDetours = vi
      .fn()
      .mockImplementation(async (positions: unknown[]) => positions.map(() => detour(120_000)));

    const { result } = renderHook(() =>
      useAlongRouteSearch({
        geocode,
        places: [OSLO_S],
        path: PATH,
        estimateDetours,
        active: true,
      }),
    );

    act(() => result.current.setQuery('Oslo'));
    await settle();

    // The saved place is already costed and shown while the network is pending.
    await waitFor(() => expect(result.current.hits.map((h) => h.name)).toEqual(['Oslo S']));
    expect(result.current.loading).toBe(true);

    // A nearer, cheaper detour arrives from the geocoder and ranks first.
    estimateDetours.mockImplementation(async (positions: unknown[]) =>
      positions.map(() => detour(30_000)),
    );
    await act(async () => {
      releaseRemote([hit('Oslo Kaffebar', 59.915, 10.7501)]);
      await vi.advanceTimersByTimeAsync(0);
    });

    await waitFor(() =>
      expect(result.current.hits.map((h) => h.name)).toEqual(['Oslo Kaffebar', 'Oslo S']),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
  });

  it('drops candidates outside the route corridor', async () => {
    const geocode = vi.fn<StopGeocodeFn>().mockResolvedValue([hit('Bergen', 60.39, 5.32)]);
    const estimateDetours = vi
      .fn()
      .mockImplementation(async (positions: unknown[]) => positions.map(() => detour(60_000)));

    const { result } = renderHook(() =>
      useAlongRouteSearch({
        geocode,
        // Far off the path, so it must not be offered either.
        places: [{ name: 'Bergen home', lat: 60.39, lng: 5.33 }],
        path: PATH,
        estimateDetours,
        active: true,
      }),
    );

    act(() => result.current.setQuery('Ber'));
    await settle();

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.hits).toEqual([]);
  });

  it('constrains the geocoder to the route bounds', async () => {
    const geocode = vi.fn<StopGeocodeFn>().mockResolvedValue([]);
    const estimateDetours = vi.fn().mockResolvedValue([]);
    const { result } = renderHook(() =>
      useAlongRouteSearch({ geocode, places: [], path: PATH, estimateDetours, active: true }),
    );

    act(() => result.current.setQuery('fuel'));
    await settle();

    const query = geocode.mock.calls[0]![0]!;
    expect(query.bbox).toMatch(/^-?\d/);
    expect(query.limit).toBe(20);
  });
});
