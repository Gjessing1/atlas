// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { MAX_RECENT_SEARCHES, type SearchResult } from '@atlas/core';
import { describe, expect, it, vi } from 'vitest';

import { useRecentSearches, type RecentSearchStore } from './useRecentSearches.js';

const hit = (name: string, lat = 59.91, lng = 10.75): SearchResult => ({
  name,
  label: 'Oslo',
  position: { lat, lng },
});

/** A store whose read resolves only when the test says so — Android's is a DB. */
function deferredStore(initial: string | null) {
  let release: () => void = () => {};
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  const saved: string[] = [];
  const store: RecentSearchStore = {
    load: async () => {
      await opened;
      return initial;
    },
    save: (raw) => saved.push(raw),
  };
  return { store, release, saved };
}

describe('useRecentSearches', () => {
  it('reads the stored list once, however often the caller re-renders', async () => {
    const load = vi.fn(() => JSON.stringify([hit('Semsvannet')]));
    // A caller building the store inline gives a fresh object every render.
    const { result, rerender } = renderHook(() =>
      useRecentSearches({ load, save: () => undefined }),
    );
    await waitFor(() => expect(result.current.recent).toHaveLength(1));
    rerender();
    rerender();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('persists a pick at the front, serialized', async () => {
    const saved: string[] = [];
    const { result } = renderHook(() =>
      useRecentSearches({ load: () => null, save: (raw) => saved.push(raw) }),
    );
    await waitFor(() => expect(result.current.recent).toEqual([]));
    act(() => result.current.remember(hit('Oslo S')));
    act(() => result.current.remember(hit('Nationaltheatret', 59.914)));
    expect(result.current.recent.map((r) => r.name)).toEqual(['Nationaltheatret', 'Oslo S']);
    expect(JSON.parse(saved.at(-1)!)).toHaveLength(2);
  });

  it('caps the list', async () => {
    const { result } = renderHook(() =>
      useRecentSearches({ load: () => null, save: () => undefined }),
    );
    for (let i = 0; i < MAX_RECENT_SEARCHES + 2; i++) {
      act(() => result.current.remember(hit(`Place ${i}`, 59 + i / 100)));
    }
    expect(result.current.recent).toHaveLength(MAX_RECENT_SEARCHES);
  });

  it('clears and persists the empty list', async () => {
    const saved: string[] = [];
    const { result } = renderHook(() =>
      useRecentSearches({
        load: () => JSON.stringify([hit('Oslo S')]),
        save: (r) => saved.push(r),
      }),
    );
    await waitFor(() => expect(result.current.recent).toHaveLength(1));
    act(() => result.current.clear());
    expect(result.current.recent).toEqual([]);
    // Persisted, not merely blanked on screen: reopening must stay cleared.
    expect(saved.at(-1)).toBe('[]');
  });

  it('does not let a slow read overwrite a pick that already happened', async () => {
    const { store, release } = deferredStore(JSON.stringify([hit('Stale')]));
    const { result } = renderHook(() => useRecentSearches(store));
    act(() => result.current.remember(hit('Just picked', 60.1)));
    await act(async () => {
      release();
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.recent.map((r) => r.name)).toEqual(['Just picked']));
  });

  it('survives a store that throws instead of answering', async () => {
    const { result } = renderHook(() =>
      useRecentSearches({
        load: () => {
          throw new Error('storage unavailable');
        },
        save: () => {
          throw new Error('storage full');
        },
      }),
    );
    await waitFor(() => expect(result.current.recent).toEqual([]));
    act(() => result.current.remember(hit('Oslo S')));
    // The pick still stands for this session; only its persistence was lost.
    expect(result.current.recent.map((r) => r.name)).toEqual(['Oslo S']);
  });
});
