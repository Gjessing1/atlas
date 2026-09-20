import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { PoiCategoryId, PoiResult } from '@atlas/core';
import { usePoiList } from './usePoiList.js';

const poi = (id: string, categoryId: PoiCategoryId, lat: number): PoiResult => ({
  id,
  name: id,
  position: { lat, lng: 10.75 },
  categoryId,
  category: categoryId,
  marker: 'x',
});
const firstView = { bbox: [10.7, 59.8, 10.8, 60] as const, zoom: 14 };
const movedView = { bbox: [10.8, 59.9, 10.9, 60.1] as const, zoom: 14 };

describe('usePoiList', () => {
  it('follows the live view until it is read, then freezes until refreshed', async () => {
    const refreshLive = vi.fn();
    const a = poi('a', 'food', 59.9);
    const b = poi('b', 'food', 60);
    const { result, rerender } = renderHook(
      ({ viewport, liveResults, loading, liveRevision }) =>
        usePoiList({
          active: true,
          viewport,
          categories: ['food'],
          liveResults,
          loading,
          liveRevision,
          origin: null,
          refreshLive,
        }),
      { initialProps: { viewport: firstView, liveResults: [a], loading: false, liveRevision: 1 } },
    );
    await waitFor(() => expect(result.current.results.map((item) => item.id)).toEqual(['a']));

    // Nobody is reading it yet: a moved map is simply the list's new subject,
    // which is what stops a selector switched on over a whole country insisting
    // there is nothing here once the user zooms in.
    rerender({ viewport: movedView, liveResults: [b], loading: false, liveRevision: 2 });
    await waitFor(() => expect(result.current.results.map((item) => item.id)).toEqual(['b']));
    expect(result.current.stale).toBe(false);

    // Read from here on: the rows stop moving, and the map only offers to.
    act(() => result.current.open());
    rerender({ viewport: firstView, liveResults: [a], loading: false, liveRevision: 3 });
    expect(result.current.results.map((item) => item.id)).toEqual(['b']);
    expect(result.current.stale).toBe(true);

    act(() => result.current.refresh());
    expect(refreshLive).toHaveBeenCalledOnce();
    rerender({ viewport: firstView, liveResults: [a], loading: true, liveRevision: 3 });
    expect(result.current.results.map((item) => item.id)).toEqual(['b']);
    rerender({ viewport: firstView, liveResults: [a], loading: false, liveRevision: 4 });
    await waitFor(() => expect(result.current.results.map((item) => item.id)).toEqual(['a']));
    expect(result.current.stale).toBe(false);
  });

  it('keeps following the live view while it has nothing to keep still', async () => {
    const a = poi('a', 'food', 59.9);
    const { result, rerender } = renderHook(
      ({ liveResults }) =>
        usePoiList({
          active: true,
          viewport: firstView,
          categories: ['food'],
          liveResults,
          loading: false,
          liveRevision: liveResults.length,
          origin: null,
          refreshLive: vi.fn(),
        }),
      { initialProps: { liveResults: [] as PoiResult[] } },
    );
    // A panel that comes up over an empty view is "read" from its first frame,
    // and must not then insist there is nothing here once places arrive.
    act(() => result.current.open());
    rerender({ liveResults: [a] });
    await waitFor(() => expect(result.current.results.map((item) => item.id)).toEqual(['a']));
    expect(result.current.stale).toBe(false);
  });

  it('re-snapshots when the list is opened again at a view that has moved', async () => {
    const a = poi('a', 'food', 59.9);
    const b = poi('b', 'food', 60);
    const { result, rerender } = renderHook(
      ({ viewport, liveResults }) =>
        usePoiList({
          active: true,
          viewport,
          categories: ['food'],
          liveResults,
          loading: false,
          liveRevision: 1,
          origin: null,
          refreshLive: vi.fn(),
        }),
      { initialProps: { viewport: firstView, liveResults: [a] } },
    );
    await waitFor(() => expect(result.current.results.map((item) => item.id)).toEqual(['a']));
    act(() => result.current.open());
    rerender({ viewport: movedView, liveResults: [b] });
    expect(result.current.results.map((item) => item.id)).toEqual(['a']);
    // Pulling the list up again is the user asking for *this* view.
    act(() => result.current.open());
    expect(result.current.results.map((item) => item.id)).toEqual(['b']);
    expect(result.current.stale).toBe(false);
  });

  it('sorts a new snapshot by the distance from the user, nearest first', async () => {
    const north = poi('north', 'coffee', 60);
    const south = poi('south', 'coffee', 59.82);
    const { result } = renderHook(() =>
      usePoiList({
        active: true,
        viewport: firstView,
        categories: ['coffee'],
        // The live view hands them over in its own centre-first order.
        liveResults: [north, south],
        loading: false,
        liveRevision: 1,
        origin: { lat: 59.81, lng: 10.75 },
        refreshLive: vi.fn(),
      }),
    );
    await waitFor(() =>
      expect(result.current.results.map((item) => item.id)).toEqual(['south', 'north']),
    );
  });

  it('updates distances without reordering and omits them with no fix', async () => {
    const near = poi('near', 'coffee', 59.9);
    const far = poi('far', 'coffee', 60);
    const { result, rerender } = renderHook(
      ({ origin }) =>
        usePoiList({
          active: true,
          viewport: firstView,
          categories: ['coffee'],
          liveResults: [near, far],
          loading: false,
          liveRevision: 1,
          origin,
          refreshLive: vi.fn(),
        }),
      { initialProps: { origin: null as { lat: number; lng: number } | null } },
    );
    await waitFor(() => expect(result.current.results).toHaveLength(2));
    act(() => result.current.open());
    expect(result.current.results.every((item) => item.distanceM === undefined)).toBe(true);
    rerender({ origin: { lat: 60, lng: 10.75 } });
    expect(result.current.results.map((item) => item.id)).toEqual(['near', 'far']);
    expect(result.current.results.every((item) => item.distanceM !== undefined)).toBe(true);
  });
});
