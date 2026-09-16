import { act, renderHook, waitFor } from '@testing-library/react';
import type {
  WeatherMapFrame,
  WeatherMapLayer,
  WeatherMapsResponse,
  WeatherMapTimeline,
} from '@atlas/conditions';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useWeatherGrid, useWeatherMaps } from './useWeatherMaps.js';

const NOW = Date.parse('2026-09-16T12:20:00Z');
const at = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();

function frames(kind: WeatherMapFrame['kind'], minutes: number[]): WeatherMapFrame[] {
  return minutes.map((m) => ({
    id: `${kind}-${m}`,
    time: at(m),
    kind,
    tilePath: `/api/weather/maps/x/${kind}-${m}/{z}/{x}/{y}.png`,
  }));
}

function timeline(id: WeatherMapTimeline['id'], list: WeatherMapFrame[]): WeatherMapTimeline {
  return { id, bounds: [-180, -85, 180, 85], minzoom: 0, maxzoom: 5, frames: list };
}

function layer(id: WeatherMapLayer['id'], timelines: WeatherMapTimeline[]): WeatherMapLayer {
  return {
    id,
    title: id,
    description: '',
    unit: '',
    coverageNote: '',
    defaultOpacity: 0.8,
    timelines,
    frames: timelines.flatMap((t) => t.frames),
    legend: [],
    bounds: [-180, -85, 180, 85],
    minzoom: 0,
    maxzoom: 5,
  };
}

const response: WeatherMapsResponse = {
  layers: [
    layer('precipitation', [
      timeline('forecast', frames('forecast', [-20, 40, 100, 160])),
      timeline('radar', [
        ...frames('observation', [-15, -10, -5]),
        ...frames('nowcast', [0, 5, 10]),
      ]),
    ]),
    layer('wind', [timeline('forecast', frames('forecast', [-20, 40, 100]))]),
  ],
  attribution: 'MET Norway',
  lightning: { available: false, reason: '' },
};

function serve(body: unknown = response) {
  const fetchMock = vi.fn(async (_url: string) => new Response(JSON.stringify(body)));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

// Unmounted explicitly after each test: the hook's refresh interval must not
// outlive it (nothing registers Testing Library's auto-cleanup in this repo).
const mounted: (() => void)[] = [];
function track<T extends { unmount: () => void }>(rendered: T): T {
  mounted.push(rendered.unmount);
  return rendered;
}

afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useWeatherMaps', () => {
  it('stays idle and fetches nothing while no weather layer is on', () => {
    const fetchMock = serve();
    const { result } = track(renderHook(() => useWeatherMaps('', null)));
    expect(result.current.status).toBe('idle');
    expect(result.current.frame).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('opens precipitation on radar, at the newest observed picture, with absolute tile URLs', async () => {
    serve();
    const { result } = track(
      renderHook(() =>
        useWeatherMaps('https://atlas.example/', 'precipitation', { now: () => NOW }),
      ),
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.timelineIds).toEqual(['radar', 'forecast']);
    expect(result.current.timeline?.id).toBe('radar');
    expect(result.current.frame?.id).toBe('observation--5');
    expect(result.current.nowIndex).toBe(2);
    expect(result.current.followingNow).toBe(true);
    expect(result.current.frame?.tileUrlTemplate).toBe(
      'https://atlas.example/api/weather/maps/x/observation--5/{z}/{x}/{y}.png',
    );
    expect(result.current.upcoming.map((f) => f.id)).toEqual(['nowcast-0', 'nowcast-5']);
    expect(result.current.legend?.unit).toBe('mm/h');
  });

  it('switches timeline back to now, and keeps the chosen time across layers', async () => {
    serve();
    const { result, rerender } = track(
      renderHook(({ id }: { id: string }) => useWeatherMaps('', id, { now: () => NOW }), {
        initialProps: { id: 'precipitation' },
      }),
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));
    act(() => result.current.setTimeline('forecast'));
    expect(result.current.frame?.id).toBe('forecast--20');
    act(() => result.current.selectFrame(2));
    expect(result.current.followingNow).toBe(false);
    rerender({ id: 'wind' });
    // Wind has no radar: its forecast lands on the same time.
    expect(result.current.timeline?.id).toBe('forecast');
    expect(result.current.frame?.time).toBe(at(100));
    act(() => result.current.goToNow());
    expect(result.current.frame?.time).toBe(at(-20));
  });

  it('plays through the frames, holds on the last and loops', async () => {
    serve();
    const { result } = track(renderHook(() => useWeatherMaps('', 'wind', { now: () => NOW })));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    vi.useFakeTimers();
    act(() => result.current.togglePlaying());
    expect(result.current.playing).toBe(true);
    act(() => vi.advanceTimersByTime(750));
    expect(result.current.frameIndex).toBe(1);
    act(() => vi.advanceTimersByTime(750));
    expect(result.current.frameIndex).toBe(2);
    act(() => vi.advanceTimersByTime(750 * 3));
    expect(result.current.frameIndex).toBe(2);
    act(() => vi.advanceTimersByTime(750));
    expect(result.current.frameIndex).toBe(0);
  });

  it('stops playing when the layer is switched off', async () => {
    serve();
    const { result, rerender } = track(
      renderHook(({ id }: { id: string | null }) => useWeatherMaps('', id, { now: () => NOW }), {
        initialProps: { id: 'wind' as string | null },
      }),
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));
    act(() => result.current.togglePlaying());
    rerender({ id: null });
    expect(result.current.playing).toBe(false);
    expect(result.current.frame).toBeNull();
  });

  it('keeps the last good catalog when a refresh fails', async () => {
    const fetchMock = serve();
    const { result } = track(
      renderHook(() => useWeatherMaps('', 'wind', { now: () => NOW, refreshMs: 40 })),
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));
    fetchMock.mockImplementation(async () => new Response('nope', { status: 502 }));
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(1));
    expect(result.current.status).toBe('ready');
    expect(result.current.frame?.id).toBe('forecast--20');
  });

  it('reads a catalog from before timelines as one forecast timeline', async () => {
    serve({ ...response, layers: [{ ...response.layers[1]!, timelines: undefined }] });
    const { result } = track(renderHook(() => useWeatherMaps('', 'wind', { now: () => NOW })));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.timelineIds).toEqual(['forecast']);
    expect(result.current.frames).toHaveLength(3);
  });
});

describe('useWeatherGrid', () => {
  it('fetches the grid for the frame on screen and reuses it from cache', async () => {
    const grid = {
      layer: 'wind',
      frame: 'forecast--20',
      time: at(-20),
      bbox: [0, 0, 1, 1],
      cols: 1,
      rows: 1,
      u: [1],
      v: [2],
    };
    const fetchMock = serve();
    fetchMock.mockImplementation(async (url: string) =>
      url.includes('/grid')
        ? new Response(JSON.stringify(grid))
        : new Response(JSON.stringify(response)),
    );
    const viewport = { bbox: [0, 0, 1, 1] as [number, number, number, number], cols: 1, rows: 1 };
    const { result, rerender } = track(
      renderHook(
        ({ wanted }: { wanted: boolean }) => {
          const maps = useWeatherMaps('', 'wind', { now: () => NOW });
          return useWeatherGrid('', maps, viewport, wanted);
        },
        { initialProps: { wanted: true } },
      ),
    );
    await waitFor(() => expect(result.current?.u).toEqual([1]));
    const gridCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).includes('/grid'));
    expect(gridCalls()).toHaveLength(1);
    expect(String(gridCalls()[0]![0])).toContain('/api/weather/maps/wind/forecast--20/grid?bbox=');
    rerender({ wanted: false });
    expect(result.current).toBeNull();
    rerender({ wanted: true });
    expect(result.current?.u).toEqual([1]);
    expect(gridCalls()).toHaveLength(1);
  });
});
