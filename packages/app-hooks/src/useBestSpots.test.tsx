import { act, renderHook, waitFor } from '@testing-library/react';
import type { WeatherForecast, WeatherPoint } from '@atlas/conditions';
import type { LngLatBbox } from '@atlas/core';
import type { PotentialSpot, PotentialSpotsResponse } from '@atlas/potential';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { standWindRisk, useBestSpots, windowForToday } from './useBestSpots.js';
import type { PotentialView } from './usePotential.js';

const SEMSVANNET: LngLatBbox = [10.4, 59.84, 10.44, 59.87];
const view = (bbox: LngLatBbox = SEMSVANNET, zoom = 12.4): PotentialView => ({ bbox, zoom });
const selection = { layer: 'lake-fishing', target: 'orret' };
const huntSelection = { layer: 'hunt', target: 'radyr' };

const spot = (over: Partial<PotentialSpot> = {}): PotentialSpot => ({
  id: '11/1083/596/72/82',
  position: { lat: 59.858, lng: 10.421 },
  cell: '11/1083/596',
  rank: 0.98,
  cellRank: 0.98,
  score: 98,
  band: 'prime',
  bandLabel: 'Prime',
  reason: 'Inflow mouth right here.',
  factors: [],
  access: { distanceM: 900, durationS: 720, approximate: false, from: { lat: 59.86, lng: 10.4 } },
  stand: null,
  ...over,
});

const spots = (over: Partial<PotentialSpotsResponse> = {}): PotentialSpotsResponse => ({
  layer: 'lake-fishing',
  target: 'orret',
  vocabulary: 'fishing',
  mode: 'habitat',
  spots: [spot()],
  pending: 0,
  flat: 0,
  accessAvailable: true,
  note: null,
  ...over,
});

/**
 * A forecast whose only good hours are in the middle of the given day — enough
 * for the conditions engine to find a window, and nothing outside it.
 */
function forecastFor(day: Date, goodHours: number[]): WeatherForecast {
  const series: WeatherPoint[] = [];
  for (let hour = 0; hour < 48; hour++) {
    const time = new Date(day);
    time.setHours(hour, 0, 0, 0);
    const good = goodHours.includes(hour) && hour < 24;
    series.push({
      time: time.toISOString(),
      temp: good ? 12 : -8,
      windSpeed: good ? 2 : 16,
      windGust: good ? 3 : 22,
      windFromDir: 200,
      cloud: good ? 40 : 100,
      humidity: 70,
      pressure: 1015,
      precip: good ? 0 : 6,
      precipProb: good ? 0 : 90,
      symbol: good ? 'partlycloudy_day' : 'heavyrain',
    });
  }
  return { lat: 59.86, lon: 10.42, updatedAt: day.toISOString(), series };
}

let fetchMock: ReturnType<typeof vi.fn>;

/** Routes the two URLs this hook knows about; unknown ones fail the test. */
function stubFetch(over: { spots?: PotentialSpotsResponse; forecast?: WeatherForecast | null }) {
  fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes('/spots')) return Response.json(over.spots ?? spots());
    if (url.includes('/api/weather')) {
      return over.forecast === null
        ? new Response('nope', { status: 503 })
        : Response.json(over.forecast ?? forecastFor(new Date(), [6, 7, 8]));
    }
    throw new Error(`unstubbed ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
}

/**
 * Pinned to an early morning, because the window this suite asserts on is
 * *today's* — `windowForToday` looks forward from `now` to midnight, and the
 * default stub's good hours are 06:00–08:00. Left on the wall clock, every one
 * of these tests passed before breakfast and failed after it: the docker gate
 * went red at 20:35 one evening with nothing wrong in the code, which is the
 * failure this repo's raised test timeouts already exist to avoid — a red build
 * that silently leaves the last release undeployed.
 */
const MORNING = new Date(2026, 6, 15, 5, 0, 0);

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true, now: MORNING });
  stubFetch({});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useBestSpots', () => {
  it('does nothing at all while the list is closed', () => {
    renderHook(() => useBestSpots('', selection, view(), { enabled: false }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not ask below the cell zoom — there is nothing derived to rank', async () => {
    renderHook(() => useBestSpots('', selection, view(SEMSVANNET, 9), { enabled: true }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('lists the spots for the view and asks for the walk-in times with them', async () => {
    const { result } = renderHook(() => useBestSpots('', selection, view(), { enabled: true }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.spots).toHaveLength(1);
    expect(result.current.accessAvailable).toBe(true);
    const asked = new URL(String(fetchMock.mock.calls[0]![0]), 'http://test');
    expect(asked.pathname).toBe('/api/potential/lake-fishing/orret/spots');
    expect(asked.searchParams.get('bbox')).toBe('10.400000,59.840000,10.440000,59.870000');
  });

  it('couples the shortlist to today’s conditions window at the top spot', async () => {
    const { result } = renderHook(() => useBestSpots('', selection, view(), { enabled: true }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await waitFor(() => expect(result.current.window).not.toBeNull());
    const window = result.current.window!;
    expect(window.startMs).toBeLessThan(window.endMs);
    expect(window.peakMs).toBeGreaterThanOrEqual(window.startMs);
    expect(window.score).toBeGreaterThan(0);
    // One forecast for the whole shortlist, at the strongest spot — not one per
    // spot, which is what met.no's terms ask us not to do.
    const weatherCalls = fetchMock.mock.calls.filter((c) => String(c[0]).includes('/api/weather'));
    expect(weatherCalls).toHaveLength(1);
  });

  it('keeps the spots when the forecast fails — the window is the optional half', async () => {
    stubFetch({ forecast: null });
    const { result } = renderHook(() => useBestSpots('', selection, view(), { enabled: true }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.window).toBeNull();
    expect(result.current.windowNote).toBeNull();
  });

  it('passes an empty answer through as a finding, with the surface’s own words', async () => {
    stubFetch({
      spots: spots({
        spots: [],
        note: 'No standout water in view — this area reads much the same.',
      }),
    });
    const { result } = renderHook(() => useBestSpots('', selection, view(), { enabled: true }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await waitFor(() => expect(result.current.status).toBe('empty'));
    expect(result.current.note).toMatch(/No standout water/);
  });

  it('keeps both stand and paired habitat inside a visible saved permit area', async () => {
    const stand = (id: string, aimLng: number) =>
      spot({
        id,
        position: { lat: 59.85, lng: 10.42 },
        stand: {
          maxRangeM: 150,
          vantageM: 3,
          lanes: [],
          aim: { label: 'E', bearing: 90, distanceM: 100, position: { lat: 59.85, lng: aimLng } },
          warning: 'check',
        },
      });
    stubFetch({
      spots: spots({
        layer: 'hunt',
        target: 'radyr',
        vocabulary: 'hunt',
        mode: 'stands',
        spots: [stand('inside', 10.43), stand('aim-outside', 10.46)],
      }),
    });
    const area = {
      id: 'sleikebekk',
      name: 'Delområde Sleikebekk',
      bbox: SEMSVANNET,
      polygons: [
        [
          [
            [10.4, 59.84],
            [10.44, 59.84],
            [10.44, 59.87],
            [10.4, 59.87],
            [10.4, 59.84],
          ] as [number, number][],
        ],
      ],
    };
    const { result } = renderHook(() =>
      useBestSpots('', huntSelection, view(), { enabled: true, vocabulary: 'hunt', areas: [area] }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.spots.map((candidate) => candidate.id)).toEqual(['inside']);
    expect(result.current.note).toContain('Delområde Sleikebekk');
    expect(result.current.huntPhase?.phase).toBe('pre-rut');
  });

  it('asks again when a derived cell lands under the same viewport', async () => {
    const { rerender } = renderHook(
      ({ readyKey }: { readyKey: string }) =>
        useBestSpots('', selection, view(), { enabled: true, readyKey }),
      { initialProps: { readyKey: 'a' } },
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    const before = fetchMock.mock.calls.filter((c) => String(c[0]).includes('/spots')).length;
    rerender({ readyKey: 'b' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    const after = fetchMock.mock.calls.filter((c) => String(c[0]).includes('/spots')).length;
    expect(after).toBe(before + 1);
  });

  it('reports a failure without pretending the water is empty', async () => {
    fetchMock = vi.fn(async () => new Response('nope', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useBestSpots('', selection, view(), { enabled: true }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.note).toBe('Could not read this area.');
  });
});

describe('windowForToday', () => {
  const noon = () => {
    const at = new Date();
    at.setHours(12, 0, 0, 0);
    return at;
  };

  /**
   * The rule that makes the window useful: "best of the next 72 hours" happily
   * reports tomorrow's dawn, which answers a question nobody asked while
   * standing at the water this afternoon.
   */
  it('cuts the horizon at midnight rather than reaching into tomorrow', () => {
    const today = noon();
    const tomorrow = new Date(today.getTime() + 24 * 3600_000);
    // A forecast that only starts tomorrow leaves today with no rows at all.
    expect(
      windowForToday(forecastFor(tomorrow, [6, 7, 8]), { vocabulary: 'fishing', now: today }),
    ).toBeNull();
  });

  it('answers with today’s window even when tomorrow’s is better', () => {
    const today = noon();
    const forecast = forecastFor(today, [18, 19]);
    // Tomorrow's dawn is calmer and warmer, so it would win a 72-hour search.
    for (let i = 29; i <= 33; i++) {
      Object.assign(forecast.series[i]!, {
        temp: 14,
        windSpeed: 1,
        windGust: 1,
        cloud: 30,
        precip: 0,
        precipProb: 0,
      });
    }
    const window = windowForToday(forecast, { vocabulary: 'fishing', now: today })!;
    expect(new Date(window.startMs).getDate()).toBe(today.getDate());
  });

  it('finds this evening’s window and names its peak', () => {
    const today = noon();
    const window = windowForToday(forecastFor(today, [18, 19, 20]), {
      vocabulary: 'fishing',
      species: 'trout',
      now: today,
    });
    expect(window).not.toBeNull();
    expect(new Date(window!.startMs).getHours()).toBeGreaterThanOrEqual(17);
    expect(window!.summary.length).toBeGreaterThan(0);
  });
});

describe('stand wind', () => {
  const callingStand = spot({
    stand: {
      maxRangeM: 150,
      vantageM: 4,
      lanes: [],
      aim: { label: 'E', bearing: 90, distanceM: 110, position: { lat: 59.85, lng: 10.42 } },
      warning: 'check',
    },
  });

  it('greys a stand when scent travels toward its paired habitat', () => {
    // Wind from west travels east, the same bearing as the habitat.
    expect(standWindRisk(callingStand, { windFromDeg: 270 })).toBe('blown');
    expect(standWindRisk(callingStand, { windFromDeg: 90 })).toBe('good');
    expect(standWindRisk(callingStand, { windFromDeg: 0 })).toBe('crosswind');
  });
});
