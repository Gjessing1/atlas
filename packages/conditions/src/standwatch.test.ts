import type { PlaceStand } from '@atlas/core';
import { describe, expect, it } from 'vitest';
import { assessConditions } from './conditions.js';
import {
  compareStandCells,
  standSitWindow,
  standWatchDays,
  STAND_BOARD_DAYS,
  type StandDayCell,
} from './standwatch.js';
import type { WeatherForecast, WeatherPoint } from './weather.js';

const OSLO = { lat: 59.91, lon: 10.75 };
/** Tromsø: north of the Arctic Circle, and roe country is creeping that way. */
const TROMSO = { lat: 69.65, lon: 18.96 };

function mkPoint(overrides: Partial<WeatherPoint> = {}): WeatherPoint {
  return {
    time: '2026-07-19T12:00:00Z',
    temp: 12,
    windSpeed: 3,
    windGust: null,
    windFromDir: 270,
    cloud: 50,
    humidity: 70,
    pressure: 1013,
    precip: 0,
    precipProb: 0,
    symbol: 'partlycloudy_day',
    ...overrides,
  };
}

/**
 * A forecast in met.no's real shape: hourly for three days, then 6-hourly out to
 * ten — which is exactly the boundary the board has to be honest about.
 */
function mkForecast(
  startIso: string,
  at: { lat: number; lon: number } = OSLO,
  overrides: (index: number, timeMs: number) => Partial<WeatherPoint> = () => ({}),
): WeatherForecast {
  const start = Date.parse(startIso);
  const series: WeatherPoint[] = [];
  for (let hour = 0; hour <= 72; hour++) {
    const timeMs = start + hour * 3600_000;
    series.push(mkPoint({ time: new Date(timeMs).toISOString(), ...overrides(hour, timeMs) }));
  }
  for (let step = 1; step <= 28; step++) {
    const timeMs = start + (72 + step * 6) * 3600_000;
    series.push(mkPoint({ time: new Date(timeMs).toISOString(), ...overrides(72 + step, timeMs) }));
  }
  return { ...at, updatedAt: startIso, series };
}

function stand(overrides: Partial<PlaceStand> = {}): PlaceStand {
  return {
    kind: 'stand',
    source: 'atlas-potential',
    target: 'Rådyr ▸ brunst',
    // Habitat to the east: a west wind carries scent straight onto it.
    aim: { label: 'E', bearing: 90, distanceM: 45, position: { lat: 59.91, lng: 10.76 } },
    vantageM: 5,
    maxRangeM: 150,
    lanes: [
      { key: 'n', label: 'N', bearing: 0, rangeM: 20 },
      { key: 'e', label: 'E', bearing: 90, rangeM: 130 },
      { key: 's', label: 'S', bearing: 180, rangeM: 40 },
      { key: 'w', label: 'W', bearing: 270, rangeM: 0 },
    ],
    approach: null,
    bandLabel: 'Prime ground',
    warning: 'Terrain visibility is not a backstop check.',
    savedAt: Date.UTC(2026, 6, 1, 12),
    ...overrides,
  };
}

describe('standSitWindow', () => {
  const july = new Date('2026-07-19T12:00:00Z');

  it('brackets the morning sit on first light, not on a clock hour', () => {
    const day = standSitWindow(july, OSLO.lat, OSLO.lon, 'morning');
    // Oslo mid-July: civil dawn ~02:15 UTC, sunrise ~02:20 UTC.
    expect(day.startMs).toBeLessThan(day.endMs);
    expect(new Date(day.startMs).getUTCHours()).toBeLessThanOrEqual(3);
    expect(day.polar).toBeNull();
  });

  it('puts the evening sit after the morning one on the same date', () => {
    const morning = standSitWindow(july, OSLO.lat, OSLO.lon, 'morning');
    const evening = standSitWindow(july, OSLO.lat, OSLO.lon, 'evening');
    expect(evening.startMs).toBeGreaterThan(morning.endMs);
  });

  // The rut peaks in late July, which in Nordland and Troms is still midnight
  // sun. A board that silently returned midnight would be wrong exactly where a
  // hunter cannot check it by looking out of the window.
  it('says when the midnight sun collapses the two sits into one', () => {
    const window = standSitWindow(july, TROMSO.lat, TROMSO.lon, 'morning');
    expect(window.polar).toBe('day');
    expect(window.endMs - window.startMs).toBe(3 * 3600_000);
  });

  it('falls back to the brightest hours in polar night', () => {
    const december = new Date('2026-12-19T12:00:00Z');
    const morning = standSitWindow(december, TROMSO.lat, TROMSO.lon, 'morning');
    const evening = standSitWindow(december, TROMSO.lat, TROMSO.lon, 'evening');
    expect(morning.polar).toBe('night');
    expect(morning.endMs).toBe(evening.startMs);
  });
});

describe('standWatchDays', () => {
  const now = new Date('2026-07-19T09:00:00Z');
  const forecast = mkForecast('2026-07-19T00:00:00Z');

  it('gives one cell per day out to the board horizon', () => {
    const days = standWatchDays(stand(), forecast, 'evening', { now });
    expect(days).toHaveLength(STAND_BOARD_DAYS);
    expect(new Set(days.map((d) => d.dayMs)).size).toBe(STAND_BOARD_DAYS);
  });

  // The one-hour-for-both-sits bug this file exists to end: the wind swings at
  // midday, and morning and evening must not inherit each other's verdict.
  it('reads morning and evening separately when the wind swings between them', () => {
    const swinging = mkForecast('2026-07-19T00:00:00Z', OSLO, (_, timeMs) => ({
      // West wind (scent east, onto the habitat) before 12:00 UTC, east after.
      windFromDir: new Date(timeMs).getUTCHours() < 12 ? 270 : 90,
    }));
    const morning = standWatchDays(stand(), swinging, 'morning', { now })[1]!;
    const evening = standWatchDays(stand(), swinging, 'evening', { now })[1]!;
    expect(morning.scent!.verdict).toBe('blown');
    expect(evening.scent!.verdict).toBe('good');
  });

  // A score can be averaged; being winded cannot. One bad hour inside the sit
  // is the verdict, because it ends the sit.
  it('reports the worst hour of the sit, not its kindest', () => {
    const gusting = mkForecast('2026-07-19T00:00:00Z', OSLO, (_, timeMs) => ({
      // Clean all evening except one hour that swings onto the habitat.
      windFromDir: new Date(timeMs).getUTCHours() === 18 ? 270 : 90,
    }));
    const evening = standWatchDays(stand(), gusting, 'evening', { now })[0]!;
    expect(evening.scent!.verdict).toBe('blown');
    // And the arrow shown is the one that produced the verdict.
    expect(evening.windFromDeg).toBe(270);
  });

  it('marks the 6-hourly tail coarse rather than pretending to an hour', () => {
    const days = standWatchDays(stand(), forecast, 'evening', { now });
    expect(days.slice(0, 3).every((day) => !day.coarse)).toBe(true);
    expect(days.slice(4).some((day) => day.coarse)).toBe(true);
  });

  // The sun needs no forecast, so the timing of a day-nine sit is exact even
  // where its weather has run out entirely.
  it('keeps the window even past the forecast, and says the weather is gone', () => {
    const short: WeatherForecast = { ...forecast, series: forecast.series.slice(0, 24) };
    const last = standWatchDays(stand(), short, 'evening', { now }).at(-1)!;
    expect(last.window.endMs).toBeGreaterThan(last.window.startMs);
    expect(last.rating).toBeNull();
    expect(last.note).toContain('Beyond the forecast');
  });

  it('has cells but no ratings with no forecast at all', () => {
    const days = standWatchDays(stand(), null, 'morning', { now });
    expect(days).toHaveLength(STAND_BOARD_DAYS);
    expect(days.every((day) => day.score === null)).toBe(true);
  });

  // The dead-code fix: a slope reaches the hunt model through the planner now,
  // so a stand on a hillside is scored differently from one on the flat.
  it('lets the stand slope reach the thermal factor', () => {
    const flat = standWatchDays(stand(), forecast, 'morning', { now })[1]!;
    const hill = standWatchDays(stand(), forecast, 'morning', {
      now,
      slopeDeg: 14,
      aspectDeg: 200,
    })[1]!;
    expect(hill.score).not.toBe(flat.score);
  });
});

describe('assessConditions', () => {
  it('forwards slope and aspect to the hunt model instead of dropping them', () => {
    const input = {
      point: mkPoint({ windSpeed: 2 }),
      sunAltitudeDeg: 2,
      slopeDeg: 12,
      aspectDeg: 180,
    };
    const withSlope = assessConditions('hunting', input);
    const without = assessConditions('hunting', { ...input, slopeDeg: null, aspectDeg: null });
    expect(withSlope.factors.map((f) => f.key)).toContain('thermal');
    expect(without.factors.map((f) => f.key)).not.toContain('thermal');
    expect(withSlope.factors.find((f) => f.key === 'thermal')!.detail).toContain('drains downhill');
  });
});

describe('compareStandCells', () => {
  const cell = (over: Partial<StandDayCell>): StandDayCell => ({
    dayMs: 0,
    sit: 'evening',
    window: { startMs: 0, endMs: 1, polar: null },
    rating: 'good',
    score: 60,
    scent: null,
    windFromDeg: null,
    windSpeed: null,
    coarse: false,
    note: null,
    ...over,
  });
  const scent = (verdict: 'good' | 'crosswind' | 'blown') => ({
    verdict,
    exposure: 0.5,
    scentToDeg: 90,
    scentToLabel: 'E',
    detail: '',
  });

  // A prime stand you are blown out of is not tonight's plan, and the board must
  // never present it above a fair one the wind allows.
  it('puts a clean wind above a higher score that is blown', () => {
    const blownPrime = cell({ score: 90, scent: scent('blown') });
    const cleanFair = cell({ score: 45, scent: scent('good') });
    expect(compareStandCells(blownPrime, cleanFair)).toBeGreaterThan(0);
  });

  it('falls back to the score inside one verdict', () => {
    const better = cell({ score: 70, scent: scent('good') });
    const worse = cell({ score: 50, scent: scent('good') });
    expect(compareStandCells(better, worse)).toBeLessThan(0);
  });

  it('sorts cells with no forecast last without calling them bad', () => {
    expect(compareStandCells(cell({ score: null }), cell({ score: 20 }))).toBeGreaterThan(0);
    expect(compareStandCells(null, cell({ score: 20 }))).toBeGreaterThan(0);
  });
});
