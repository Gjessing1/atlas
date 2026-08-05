import type { SearchablePlace, SearchResult } from '@atlas/core';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useSearch, type SearchFn, type SearchHits } from './useSearch.js';

const HOME: SearchablePlace = { name: 'Home', lat: 59.92, lng: 10.75 };
const hit = (name: string, lat = 59.91): SearchResult => ({
  name,
  label: 'Norway',
  position: { lat, lng: 10.75 },
});
const answer = (results: SearchResult[], offline = false): SearchHits => ({ results, offline });

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
afterEach(() => vi.useRealTimers());

async function debounce(ms = 300): Promise<void> {
  await act(async () => vi.advanceTimersByTimeAsync(ms));
}

describe('useSearch', () => {
  it('shows saved matches immediately while the remote answer is loading', async () => {
    const search = vi.fn<SearchFn>().mockResolvedValue(answer([hit('Homely cafe')]));
    const { result } = renderHook(() => useSearch({ search, places: [HOME] }));

    act(() => result.current.setQuery('Home'));

    expect(result.current.results.map((row) => row.name)).toEqual(['Home']);
    expect(result.current.status).toBe('loading');
    expect(search).not.toHaveBeenCalled();

    await debounce();
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.results.map((row) => row.name)).toEqual(['Home', 'Homely cafe']);
  });

  it('clears the previous query before asking for the next one', async () => {
    const search = vi.fn<SearchFn>().mockResolvedValue(answer([hit('Oslo')]));
    const { result } = renderHook(() => useSearch({ search, places: [] }));

    act(() => result.current.setQuery('Oslo'));
    await debounce();
    await waitFor(() => expect(result.current.results[0]?.name).toBe('Oslo'));

    act(() => result.current.setQuery('Bergen'));
    expect(result.current.results).toEqual([]);
    expect(result.current.statusText).toBe('Searching…');
  });

  it('distinguishes empty, offline and failed searches', async () => {
    const search = vi.fn<SearchFn>().mockResolvedValueOnce(answer([]));
    const { result } = renderHook(() => useSearch({ search, places: [] }));

    act(() => result.current.setQuery('Nowhere'));
    await debounce();
    await waitFor(() => expect(result.current.status).toBe('empty'));
    expect(result.current.statusText).toBe('No matches found.');

    search.mockResolvedValueOnce(answer([], true));
    act(() => result.current.setQuery('Offline'));
    await debounce();
    await waitFor(() => expect(result.current.status).toBe('offline'));
    expect(result.current.statusText).toBe('No matches in downloaded regions.');

    search.mockRejectedValueOnce(new Error('unavailable'));
    act(() => result.current.setQuery('Failure'));
    await debounce();
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.statusText).toBe('Search is unavailable.');
  });

  it('keeps local matches and labels them honestly when online search fails', async () => {
    const search = vi.fn<SearchFn>().mockRejectedValue(new Error('unavailable'));
    const { result } = renderHook(() => useSearch({ search, places: [HOME] }));

    act(() => result.current.setQuery('Home'));
    await debounce();

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.results.map((row) => row.name)).toEqual(['Home']);
    expect(result.current.statusText).toBe('Saved results · online search unavailable');
  });

  it('ignores an old response even when its provider ignores AbortSignal', async () => {
    let resolveOslo!: (hits: SearchHits) => void;
    let resolveBergen!: (hits: SearchHits) => void;
    const search = vi.fn<SearchFn>(({ text }) => {
      return new Promise((resolve) => {
        if (text === 'Oslo') resolveOslo = resolve;
        else resolveBergen = resolve;
      });
    });
    const { result } = renderHook(() => useSearch({ search, places: [] }));

    act(() => result.current.setQuery('Oslo'));
    await debounce();
    act(() => result.current.setQuery('Bergen'));
    await debounce();

    await act(async () => resolveBergen(answer([hit('Bergen', 60.39)])));
    await waitFor(() => expect(result.current.results[0]?.name).toBe('Bergen'));
    await act(async () => resolveOslo(answer([hit('Oslo')])));
    expect(result.current.results[0]?.name).toBe('Bergen');
  });

  it('answers coordinate queries locally without calling the index', () => {
    const search = vi.fn<SearchFn>().mockResolvedValue(answer([]));
    const { result } = renderHook(() => useSearch({ search, places: [] }));

    act(() => result.current.setQuery('59.91, 10.75'));

    expect(result.current.results[0]?.label).toBe('Coordinates');
    expect(result.current.status).toBe('ready');
    expect(search).not.toHaveBeenCalled();
  });
});
