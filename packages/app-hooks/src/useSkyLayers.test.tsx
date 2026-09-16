import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useSkyLayers } from './useSkyLayers.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useSkyLayers', () => {
  it('offers the three lightning windows without fetching while aurora is off', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { result, unmount } = renderHook(() => useSkyLayers('', false));
    expect(result.current.lightning.windows.map((window) => window.id)).toEqual([
      '1h',
      '12h',
      '24h',
    ]);
    expect(result.current.lightning.window).toBe('1h');
    act(() => result.current.lightning.setWindow('24h'));
    expect(result.current.lightning.window).toBe('24h');
    expect(fetchMock).not.toHaveBeenCalled();
    unmount();
  });

  it('loads the current aurora validity time while its layer is on', async () => {
    const forecast = {
      observationTime: '2026-09-16T12:00:00Z',
      forecastTime: '2026-09-16T12:45:00Z',
      factors: ['aurora', 'darkness', 'clouds', 'light-pollution'],
    };
    const fetchMock = vi.fn(async () => Response.json(forecast));
    vi.stubGlobal('fetch', fetchMock);
    const { result, unmount } = renderHook(() => useSkyLayers('https://atlas.example/', true));
    await waitFor(() => expect(result.current.aurora.status).toBe('ready'));
    expect(result.current.aurora.forecast).toEqual(forecast);
    expect(fetchMock).toHaveBeenCalledWith('https://atlas.example/api/weather/aurora');
    unmount();
  });
});
