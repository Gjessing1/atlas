import type { PoiCategoryId, PoiResult } from '@atlas/core';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { usePoiViewport, type PoiViewportFetch } from './usePoiViewport.js';

const viewport = {
  bbox: [10.74, 59.905, 10.755, 59.915] as [number, number, number, number],
  zoom: 14.2,
};

const cafe: PoiResult = {
  id: 'node/1',
  name: 'Kaffebaren',
  position: { lat: 59.91, lng: 10.75 },
  categoryId: 'coffee',
  category: 'Cafes',
  marker: 'C',
};

/** Answers every asked pair; cafés only for the tile that holds one. */
const answerAll = () =>
  vi.fn<PoiViewportFetch>(async ({ tiles, categories }) =>
    tiles.flatMap((tile) =>
      categories.map((category) => ({
        tile: `${tile.z}/${tile.x}/${tile.y}`,
        category,
        results: category === 'coffee' && tile.x === 8681 && tile.y === 4766 ? [cafe] : [],
        complete: true,
      })),
    ),
  );

describe('usePoiViewport', () => {
  it('asks only for pairs it does not hold, and reuses them across pans', async () => {
    const fetchPois = answerAll();
    const { result, rerender } = renderHook(
      ({ view, categories }) =>
        usePoiViewport({ active: true, viewport: view, categories, fetchPois }),
      { initialProps: { view: viewport, categories: ['coffee'] as PoiCategoryId[] } },
    );
    await waitFor(() =>
      expect(result.current.results).toEqual([expect.objectContaining({ id: 'node/1' })]),
    );
    expect(fetchPois).toHaveBeenCalledTimes(1);

    // A small pan within the same tiles is answered from the cache at once.
    const panned = { ...viewport, bbox: [10.741, 59.906, 10.756, 59.914] as typeof viewport.bbox };
    rerender({ view: panned, categories: ['coffee'] });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchPois).toHaveBeenCalledTimes(1);

    // Adding a category asks for that category alone.
    rerender({ view: panned, categories: ['coffee', 'fuel'] });
    await waitFor(() => expect(fetchPois).toHaveBeenCalledTimes(2));
    expect(fetchPois.mock.calls[1]![0].categories).toEqual(['fuel']);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.results.map((poi) => poi.id)).toEqual(['node/1']);
  });

  it('does not query a world-scale view, and retries after an error', async () => {
    const fetchPois = vi.fn<PoiViewportFetch>(async () => {
      throw new Error('503');
    });
    const { result, rerender } = renderHook(
      ({ view }) => usePoiViewport({ active: true, viewport: view, categories: [], fetchPois }),
      { initialProps: { view: { bbox: [-10, 30, 20, 70] as typeof viewport.bbox, zoom: 5 } } },
    );
    expect(result.current.tooWide).toBe(true);
    expect(fetchPois).not.toHaveBeenCalled();
    rerender({ view: viewport });
    await waitFor(() => expect(result.current.error).toBe(true));
    expect(fetchPois).toHaveBeenCalledTimes(1);
    act(() => result.current.refresh());
    await waitFor(() => expect(fetchPois).toHaveBeenCalledTimes(2));
  });
});
