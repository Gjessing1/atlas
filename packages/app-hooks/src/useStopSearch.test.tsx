import type { SearchResult } from '@atlas/core';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useStopSearch, type StopGeocodeFn, type StopSearchPlace } from './useStopSearch.js';

const OSLO_S: StopSearchPlace = { name: 'Oslo S', lat: 59.9106, lng: 10.7522 };
const HOME: StopSearchPlace = { name: 'Home', lat: 59.92, lng: 10.75 };

function hit(name: string, lat: number, lng: number, transitStopId?: string): SearchResult {
  return {
    name,
    label: 'Oslo',
    position: { lat, lng },
    ...(transitStopId ? { transitStopId } : {}),
  };
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

  it('switches to stop-aware search and preserves the selected NSR identity', async () => {
    const geocode = vi
      .fn<StopGeocodeFn>()
      .mockResolvedValue([hit('Oslo S', 59.910357, 10.753051, 'NSR:StopPlace:59872')]);
    const { result, rerender } = renderHook(
      ({ transit }: { transit: boolean }) => useStopSearch({ geocode, places: [], transit }),
      { initialProps: { transit: false } },
    );

    act(() => result.current.setQuery('Oslo'));
    await settle();
    expect(geocode.mock.calls[0]![0]!.transit).toBe(false);

    rerender({ transit: true });
    await settle();
    expect(geocode.mock.calls[1]![0]!.transit).toBe(true);
    expect(result.current.hits[0]?.transitStopId).toBe('NSR:StopPlace:59872');
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
