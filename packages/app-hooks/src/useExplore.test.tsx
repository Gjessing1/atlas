import { act, renderHook, waitFor } from '@testing-library/react';
import type { SearchResult } from '@atlas/core';
import { describe, expect, it, vi } from 'vitest';

import {
  useExplore,
  EXPLORE_EMPTY,
  EXPLORE_ERROR,
  EXPLORE_LOADING,
  EXPLORE_SUBTITLE,
  EXPLORE_SUBTITLE_OFFLINE,
  type ExploreArea,
  type ExploreHits,
  type ExploreQuery,
} from './useExplore.js';

const OSLO = { lat: 59.91, lng: 10.75 };
const area: ExploreArea = { center: OSLO, radiusM: 4_000 };

const hit = (name: string): SearchResult => ({ name, label: 'Oslo', position: OSLO });

const online = (results: SearchResult[]): ExploreHits => ({ results, offline: false });

describe('useExplore', () => {
  it('browses the current view and reports how many places it found', async () => {
    const fetchNearby = vi.fn(async () => online([hit('Kaffebrenneriet')]));
    const { result } = renderHook(() => useExplore({ getArea: () => area, fetchNearby }));

    expect(result.current.status).toBe(EXPLORE_LOADING);
    await waitFor(() => expect(result.current.results).toHaveLength(1));
    expect(result.current.status).toBe('1 places');
    expect(result.current.subtitle).toBe(EXPLORE_SUBTITLE);
    expect(result.current.showEmpty).toBe(false);
    expect(fetchNearby.mock.calls[0]![0]).toMatchObject({
      category: 'food',
      center: OSLO,
      radiusM: 4_000,
    });
  });

  it('re-browses when the category changes', async () => {
    const fetchNearby = vi.fn(async ({ category }: ExploreQuery) => online([hit(category)]));
    const { result } = renderHook(() => useExplore({ getArea: () => area, fetchNearby }));
    await waitFor(() => expect(result.current.results).toHaveLength(1));

    act(() => result.current.setCategory('fuel'));
    await waitFor(() => expect(result.current.results[0]!.name).toBe('fuel'));
    expect(fetchNearby).toHaveBeenCalledTimes(2);
  });

  it('reads the map view again on refresh, not the one it started with', async () => {
    let center = OSLO;
    const fetchNearby = vi.fn(async () => online([hit('Somewhere')]));
    const { result } = renderHook(() =>
      useExplore({ getArea: () => ({ center, radiusM: 4_000 }), fetchNearby }),
    );
    await waitFor(() => expect(fetchNearby).toHaveBeenCalledTimes(1));

    center = { lat: 60.39, lng: 5.32 }; // the user panned to Bergen
    act(() => result.current.refresh());
    await waitFor(() => expect(fetchNearby).toHaveBeenCalledTimes(2));
    expect(fetchNearby.mock.calls[1]![0].center).toEqual({ lat: 60.39, lng: 5.32 });
  });

  it('does not re-browse when the caller merely re-renders', async () => {
    const fetchNearby = vi.fn(async () => online([hit('Kaffebrenneriet')]));
    // Both seams are rebuilt every render, as an app closing over a live map does.
    const { rerender } = renderHook(() =>
      useExplore({ getArea: () => ({ ...area }), fetchNearby: (q) => fetchNearby(q) }),
    );
    await waitFor(() => expect(fetchNearby).toHaveBeenCalledTimes(1));
    rerender();
    rerender();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fetchNearby).toHaveBeenCalledTimes(1);
  });

  it('names the source when the answer came from downloaded data', async () => {
    const fetchNearby = async () => ({ results: [hit('Hytta')], offline: true });
    const { result } = renderHook(() => useExplore({ getArea: () => area, fetchNearby }));
    await waitFor(() => expect(result.current.offline).toBe(true));
    expect(result.current.subtitle).toBe(EXPLORE_SUBTITLE_OFFLINE);
  });

  it('reports a failed browse as unavailable rather than as no places', async () => {
    const fetchNearby = async () => {
      throw new Error('HTTP 502');
    };
    const { result } = renderHook(() => useExplore({ getArea: () => area, fetchNearby }));
    await waitFor(() => expect(result.current.error).toBe(true));
    expect(result.current.status).toBe(EXPLORE_ERROR);
    // "Explore is unavailable" and "nothing is indexed here" are different
    // answers; showing both at once would say the map is empty when it isn't.
    expect(result.current.showEmpty).toBe(false);
  });

  it('distinguishes an empty category from a failure', async () => {
    const { result } = renderHook(() =>
      useExplore({ getArea: () => area, fetchNearby: async () => online([]) }),
    );
    await waitFor(() => expect(result.current.showEmpty).toBe(true));
    expect(result.current.status).toBe('0 places');
    expect(EXPLORE_EMPTY.length).toBeGreaterThan(0);
  });

  it('keeps looking while the map has not reported a view yet', async () => {
    const fetchNearby = vi.fn(async () => online([]));
    const { result } = renderHook(() => useExplore({ getArea: () => null, fetchNearby }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fetchNearby).not.toHaveBeenCalled();
    expect(result.current.status).toBe(EXPLORE_LOADING);
    expect(result.current.showEmpty).toBe(false);
  });

  it('stays idle until the panel is opened', async () => {
    const fetchNearby = vi.fn(async () => online([hit('Kaffebrenneriet')]));
    const { rerender } = renderHook(
      ({ active }: { active: boolean }) => useExplore({ getArea: () => area, fetchNearby, active }),
      { initialProps: { active: false } },
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fetchNearby).not.toHaveBeenCalled();

    rerender({ active: true });
    await waitFor(() => expect(fetchNearby).toHaveBeenCalledTimes(1));
  });

  it('ignores a superseded browse, however late it answers', async () => {
    const answer = new Map<string, (hits: ExploreHits) => void>();
    const fetchNearby = ({ category }: ExploreQuery) =>
      new Promise<ExploreHits>((resolve) => answer.set(category, resolve));
    const { result } = renderHook(() => useExplore({ getArea: () => area, fetchNearby }));
    await waitFor(() => expect(answer.has('food')).toBe(true));

    act(() => result.current.setCategory('fuel'));
    await waitFor(() => expect(answer.has('fuel')).toBe(true));
    // The slow first request lands after the user has moved on.
    await act(async () => {
      answer.get('food')!(online([hit('Restaurant')]));
      answer.get('fuel')!(online([hit('Circle K')]));
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.results.map((r) => r.name)).toEqual(['Circle K']));
  });
});
