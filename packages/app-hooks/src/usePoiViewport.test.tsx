import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { usePoiViewport } from './usePoiViewport.js';

const viewport = { bbox: [10.7, 59.8, 10.8, 60] as const, zoom: 13 };

describe('usePoiViewport', () => {
  it('refetches the settled viewport and selected categories', async () => {
    const fetchPois = vi.fn(async () => []);
    const { rerender } = renderHook(
      ({ categories }) => usePoiViewport({ active: true, viewport, categories, fetchPois }),
      { initialProps: { categories: ['coffee'] as const as readonly ('coffee' | 'fuel')[] } },
    );
    await waitFor(() => expect(fetchPois).toHaveBeenCalledTimes(1));
    rerender({ categories: ['fuel'] });
    await waitFor(() => expect(fetchPois).toHaveBeenCalledTimes(2));
    expect(fetchPois.mock.calls[1]![0].categories).toEqual(['fuel']);
  });

  it('does not query a world-scale view and supports retry', async () => {
    const fetchPois = vi.fn(async () => []);
    const { result, rerender } = renderHook(
      ({ view }) => usePoiViewport({ active: true, viewport: view, categories: [], fetchPois }),
      { initialProps: { view: { bbox: [-10, 30, 20, 70] as const, zoom: 5 } } },
    );
    expect(result.current.tooWide).toBe(true);
    expect(fetchPois).not.toHaveBeenCalled();
    rerender({ view: viewport });
    await waitFor(() => expect(fetchPois).toHaveBeenCalledTimes(1));
    act(() => result.current.refresh());
    await waitFor(() => expect(fetchPois).toHaveBeenCalledTimes(2));
  });
});
