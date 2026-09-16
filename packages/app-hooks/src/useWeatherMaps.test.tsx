import { act, renderHook, waitFor } from '@testing-library/react';
import type { WeatherMapLayer, WeatherMapsResponse } from '@atlas/conditions';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useWeatherMaps } from './useWeatherMaps.js';

const NOW = Date.parse('2026-09-16T12:20:00Z');

function layer(id: WeatherMapLayer['id'], hours: number[]): WeatherMapLayer {
  return {
    id,
    title: id,
    description: `${id} map`,
    unit: id === 'wind' ? 'm/s' : '°C',
    legend: [{ label: '0', color: '#000' }],
    bounds: [-180, -85, 180, 85],
    minzoom: 0,
    maxzoom: 6,
    frames: hours.map((hour) => ({
      id: `forecast-${hour}`,
      time: new Date(NOW + hour * 3_600_000).toISOString(),
      kind: 'forecast',
      tilePath: `/tiles/${id}/${hour}/{z}/{x}/{y}.webp`,
    })),
  };
}

const response: WeatherMapsResponse = {
  layers: [layer('precipitation', [-1, 0, 1, 2]), layer('wind', [-2, 1, 4])],
  attribution: 'MET Norway',
  lightning: { available: false, reason: 'Frost client ID required' },
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useWeatherMaps', () => {
  it('selects the frame nearest now and makes Android tile paths absolute', async () => {
    vi.setSystemTime(NOW);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(response))),
    );
    const { result } = renderHook(() => useWeatherMaps('https://atlas.example/', true));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.layer?.id).toBe('precipitation');
    expect(result.current.frame?.time).toBe(new Date(NOW).toISOString());
    expect(result.current.frame?.tileUrlTemplate).toBe(
      'https://atlas.example/tiles/precipitation/0/{z}/{x}/{y}.webp',
    );
  });

  it('keeps the nearest time when switching map layers', async () => {
    vi.setSystemTime(NOW);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(response))),
    );
    const { result } = renderHook(() => useWeatherMaps('', true));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    act(() => result.current.selectFrame(3));
    expect(result.current.frame?.time).toBe(new Date(NOW + 2 * 3_600_000).toISOString());
    act(() => result.current.selectLayer('wind'));
    expect(result.current.frame?.time).toBe(new Date(NOW + 3_600_000).toISOString());
  });

  it('plays through the timeline and loops without a platform timer', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(response))),
    );
    const { result } = renderHook(() => useWeatherMaps('', true));
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(result.current.status).toBe('ready');
    act(() => {
      result.current.setVisible(true);
      result.current.togglePlaying();
    });
    const initial = result.current.frameIndex;
    act(() => vi.advanceTimersByTime(700));
    expect(result.current.frameIndex).toBe(initial + 1);
    act(() => result.current.setVisible(false));
    expect(result.current.playing).toBe(false);
  });
});
