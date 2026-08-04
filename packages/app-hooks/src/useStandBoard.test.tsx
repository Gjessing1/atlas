import type { WeatherForecast, WeatherPoint } from '@atlas/conditions';
import type { PlaceStand } from '@atlas/core';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useStandBoard, STAND_BOARD_LIMIT, type StandBoardPlace } from './useStandBoard.js';

function mkStand(overrides: Partial<PlaceStand> = {}): PlaceStand {
  return {
    kind: 'stand',
    source: 'atlas-potential',
    target: 'Rådyr ▸ brunst',
    aim: { label: 'E', bearing: 90, distanceM: 45, position: { lat: 59.86, lng: 10.43 } },
    vantageM: 4,
    maxRangeM: 150,
    lanes: [
      { key: 'n', label: 'N', bearing: 0, rangeM: 25 },
      { key: 'e', label: 'E', bearing: 90, rangeM: 140 },
      { key: 's', label: 'S', bearing: 180, rangeM: 45 },
      { key: 'w', label: 'W', bearing: 270, rangeM: 0 },
    ],
    approach: null,
    bandLabel: 'Prime ground',
    warning: 'Terrain visibility is not a backstop check.',
    savedAt: Date.UTC(2026, 6, 1, 12),
    ...overrides,
  };
}

function place(id: string, over: Partial<StandBoardPlace> = {}): StandBoardPlace {
  return { id, name: `Stand ${id}`, lat: 59.86, lng: 10.42, stand: mkStand(), ...over };
}

/** A flat two-day forecast whose only variable is where the wind comes from. */
function forecast(windFromDir: number, at = { lat: 59.86, lon: 10.42 }): WeatherForecast {
  const start = new Date(2026, 6, 15, 0, 0, 0).getTime();
  const series: WeatherPoint[] = Array.from({ length: 72 }, (_, hour): WeatherPoint => ({
    time: new Date(start + hour * 3600_000).toISOString(),
    temp: 11,
    windSpeed: 3,
    windGust: 5,
    windFromDir,
    cloud: 40,
    humidity: 70,
    pressure: 1014,
    precip: 0,
    precipProb: 0,
    symbol: 'partlycloudy_day',
  }));
  return { ...at, updatedAt: new Date(start).toISOString(), series };
}

let fetchMock: ReturnType<typeof vi.fn>;

/**
 * Routes the two endpoints the board knows. `winds` maps a rounded latitude to
 * that stand's wind direction, which is how these tests prove the board really
 * does read a forecast *per stand* rather than one for all of them.
 */
function stubFetch(opts: { winds?: Record<string, number>; elevation?: number[] | 'fail' } = {}) {
  fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/api/weather')) {
      const lat = new URL(url, 'http://x').searchParams.get('lat')!;
      return Response.json(forecast(opts.winds?.[lat] ?? 90));
    }
    if (url.includes('/api/elevation/profile')) {
      if (opts.elevation === 'fail') return new Response('nope', { status: 502 });
      const body = JSON.parse(String(init?.body)) as { points: unknown[] };
      return Response.json({
        samples: body.points.map((_, index) => ({
          elevationM: opts.elevation?.[index % 8] ?? 200,
        })),
      });
    }
    throw new Error(`unstubbed ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
}

/** Mid-afternoon: the evening sit is still ahead, which is the board's case. */
const AFTERNOON = new Date(2026, 6, 15, 14, 0, 0);

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true, now: AFTERNOON });
  stubFetch();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useStandBoard', () => {
  it('fetches nothing at all while the board is closed', () => {
    renderHook(() => useStandBoard('', [place('a')], { enabled: false, now: AFTERNOON }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('ignores ordinary pins — most saved places are not stands', async () => {
    const { result } = renderHook(() =>
      useStandBoard('', [{ id: 'p', lat: 59.8, lng: 10.4 }], { enabled: true, now: AFTERNOON }),
    );
    await waitFor(() => expect(result.current.status).toBe('empty'));
    expect(result.current.note).toContain('No saved stands yet');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // The scope correction this surface exists for: the shortlist's one-forecast
  // rule is right for a 10 km viewport and wrong for stands checked once a day.
  it('reads one forecast per stand, not one for the whole board', async () => {
    const stands = [place('a', { lat: 59.86 }), place('b', { lat: 60.44 })];
    const { result } = renderHook(() =>
      useStandBoard('', stands, { enabled: true, now: AFTERNOON }),
    );
    await waitFor(() => expect(result.current.rows).toHaveLength(2));
    const weatherCalls = fetchMock.mock.calls.filter((call) =>
      String(call[0]).includes('/api/weather'),
    );
    expect(weatherCalls).toHaveLength(2);
    expect(new Set(weatherCalls.map((call) => String(call[0])))).toHaveLength(2);
  });

  it('ranks the stand the wind allows above the one it burns', async () => {
    // Both stands aim east. A west wind blows scent onto the habitat; an east
    // wind carries it away.
    stubFetch({ winds: { '59.8600': 270, '60.4400': 90 } });
    const stands = [place('blown', { lat: 59.86 }), place('clean', { lat: 60.44 })];
    const { result } = renderHook(() =>
      useStandBoard('', stands, { enabled: true, now: AFTERNOON }),
    );
    await waitFor(() => expect(result.current.rows[0]?.cell?.scent).toBeTruthy());
    expect(result.current.rows[0]!.placeId).toBe('clean');
    expect(result.current.rows[0]!.cell!.scent!.verdict).toBe('good');
    expect(result.current.rows[1]!.cell!.scent!.verdict).toBe('blown');
  });

  it('re-ranks when the sit changes, because the two are different questions', async () => {
    const { result } = renderHook(() =>
      useStandBoard('', [place('a')], { enabled: true, now: AFTERNOON }),
    );
    await waitFor(() => expect(result.current.rows).toHaveLength(1));
    const evening = result.current.rows[0]!.cell!.window.startMs;
    act(() => result.current.setSit('morning'));
    await waitFor(() => expect(result.current.sit).toBe('morning'));
    expect(result.current.rows[0]!.cell!.window.startMs).toBeLessThan(evening);
  });

  it('offers ten days and moves the ranking day without refetching', async () => {
    const { result } = renderHook(() =>
      useStandBoard('', [place('a')], { enabled: true, now: AFTERNOON }),
    );
    await waitFor(() => expect(result.current.rows).toHaveLength(1));
    expect(result.current.rows[0]!.days).toHaveLength(10);
    expect(result.current.dayStamps).toHaveLength(10);
    const before = fetchMock.mock.calls.length;
    act(() => result.current.setDayOffset(6));
    await waitFor(() => expect(result.current.dayOffset).toBe(6));
    expect(result.current.rows[0]!.cell!.dayMs).toBe(result.current.dayStamps[6]);
    expect(fetchMock.mock.calls.length).toBe(before);
  });

  it('clamps the day scrubber to the days it actually has', async () => {
    const { result } = renderHook(() =>
      useStandBoard('', [place('a')], { enabled: true, now: AFTERNOON }),
    );
    await waitFor(() => expect(result.current.rows).toHaveLength(1));
    act(() => result.current.setDayOffset(99));
    await waitFor(() => expect(result.current.dayOffset).toBe(9));
  });

  // One batched request for every stand's ring, and the fit reaches the model.
  it('fits each stand its own slope from one elevation request', async () => {
    // A ring that falls away to the south: N high, S low.
    stubFetch({ elevation: [260, 250, 240, 230, 220, 230, 240, 250] });
    const { result } = renderHook(() =>
      useStandBoard('', [place('a'), place('b', { lat: 59.9 })], {
        enabled: true,
        now: AFTERNOON,
      }),
    );
    await waitFor(() => expect(result.current.rows[0]!.slopeDeg).not.toBeNull());
    expect(result.current.rows[0]!.aspectDeg).toBe(180);
    const elevationCalls = fetchMock.mock.calls.filter((call) =>
      String(call[0]).includes('/api/elevation/profile'),
    );
    expect(elevationCalls).toHaveLength(1);
  });

  // No slope means no thermal factor — the behaviour every caller had before —
  // rather than a board that refuses to draw.
  it('still draws when the elevation service is down', async () => {
    stubFetch({ elevation: 'fail' });
    const { result } = renderHook(() =>
      useStandBoard('', [place('a')], { enabled: true, now: AFTERNOON }),
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.rows[0]!.slopeDeg).toBeNull();
    expect(result.current.rows[0]!.cell!.score).not.toBeNull();
  });

  // A politeness limit, not a display one: one request per stand is defensible
  // for a season's three-to-eight stands and not for forty starred candidates.
  it('caps the stands it will read the weather for, and says so', async () => {
    const many = Array.from({ length: STAND_BOARD_LIMIT + 3 }, (_, i) =>
      place(`s${i}`, { lat: 59.86 + i * 0.01 }),
    );
    const { result } = renderHook(() =>
      useStandBoard('', many, { enabled: true, now: AFTERNOON, near: { lat: 59.86, lng: 10.42 } }),
    );
    await waitFor(() => expect(result.current.rows).toHaveLength(STAND_BOARD_LIMIT));
    expect(result.current.note).toContain('3 more are saved');
    const weatherCalls = fetchMock.mock.calls.filter((call) =>
      String(call[0]).includes('/api/weather'),
    );
    expect(weatherCalls).toHaveLength(STAND_BOARD_LIMIT);
  });

  it('keeps the stands nearest the map when it has to drop some', async () => {
    const many = Array.from({ length: STAND_BOARD_LIMIT + 1 }, (_, i) =>
      place(`s${i}`, { lat: 59.86 + i * 0.05 }),
    );
    const { result } = renderHook(() =>
      useStandBoard('', many, { enabled: true, now: AFTERNOON, near: { lat: 59.86, lng: 10.42 } }),
    );
    await waitFor(() => expect(result.current.rows).toHaveLength(STAND_BOARD_LIMIT));
    expect(result.current.rows.map((row) => row.placeId)).not.toContain(`s${STAND_BOARD_LIMIT}`);
  });

  // A places array that is new every render must not become a load generator.
  it('does not refetch when the same stands arrive in a new array', async () => {
    const { result, rerender } = renderHook(
      ({ places }) => useStandBoard('', places, { enabled: true, now: AFTERNOON }),
      { initialProps: { places: [place('a')] } },
    );
    await waitFor(() => expect(result.current.rows[0]?.cell?.scent).toBeTruthy());
    const before = fetchMock.mock.calls.length;
    rerender({ places: [place('a')] });
    rerender({ places: [place('a')] });
    expect(fetchMock.mock.calls.length).toBe(before);
  });
});
