import { describe, expect, it } from 'vitest';
import {
  assessFishingBite,
  assessHuntStand,
  bestWindows,
  buildPlanner,
  compass16,
  describeSunDay,
  forecastTable,
  pressureTrend,
  sunDay,
  sunPosition,
  windArrow,
  type ConditionAssessment,
  type PlannerHour,
  type WeatherForecast,
  type WeatherPoint,
} from './index.js';

const OSLO = { lat: 59.91, lon: 10.75 };

function mkPoint(overrides: Partial<WeatherPoint> = {}): WeatherPoint {
  return {
    time: '2026-07-19T12:00:00Z',
    temp: 15,
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

describe('sun', () => {
  it('computes a sensible Oslo midsummer day', () => {
    const day = sunDay(new Date('2026-06-21T12:00:00Z'), OSLO.lat, OSLO.lon);
    expect(day.sunrise).not.toBeNull();
    expect(day.sunset).not.toBeNull();
    // Midsummer Oslo: sunrise ~03:54 CEST (01:54 UTC), sunset ~22:44 CEST (20:44 UTC).
    expect(day.sunrise!.getUTCHours()).toBeGreaterThanOrEqual(1);
    expect(day.sunrise!.getUTCHours()).toBeLessThanOrEqual(2);
    expect(day.sunset!.getUTCHours()).toBeGreaterThanOrEqual(20);
    expect(day.sunset!.getUTCHours()).toBeLessThanOrEqual(21);
    expect(day.noonAltitude).toBeGreaterThan(50);
    expect(day.noonAltitude).toBeLessThan(56);
  });

  it('reports polar day in Tromsø at midsummer', () => {
    const day = sunDay(new Date('2026-06-21T12:00:00Z'), 69.65, 18.96);
    expect(day.sunrise).toBeNull();
    expect(day.sunset).toBeNull();
    expect(day.noonAltitude).toBeGreaterThan(40);
    // The two no-sunrise cases must be distinguishable, not both a blank.
    expect(day.polar).toBe('day');
    expect(day.daylightMs).toBe(86400000);
  });

  it('reports polar night in Tromsø at midwinter', () => {
    const day = sunDay(new Date('2026-12-21T12:00:00Z'), 69.65, 18.96);
    expect(day.sunrise).toBeNull();
    expect(day.polar).toBe('night');
    expect(day.daylightMs).toBe(0);
    // Even in polar night the sun clears -6°, so there is real twilight to plan by.
    expect(day.noonAltitude).toBeGreaterThan(-6);
    expect(day.dawn).not.toBeNull();
    expect(day.dusk).not.toBeNull();
  });

  it('brackets sunrise/sunset with civil twilight and measures daylight', () => {
    const day = sunDay(new Date('2026-06-21T12:00:00Z'), OSLO.lat, OSLO.lon);
    expect(day.dawn!.valueOf()).toBeLessThan(day.sunrise!.valueOf());
    expect(day.dusk!.valueOf()).toBeGreaterThan(day.sunset!.valueOf());
    expect(day.polar).toBeNull();
    // Oslo midsummer: a shade under 19 hours between sunrise and sunset.
    const hours = day.daylightMs / 3600000;
    expect(hours).toBeGreaterThan(18);
    expect(hours).toBeLessThan(19);
  });

  it('puts the midday sun roughly south and high, the midnight sun below the horizon', () => {
    const noon = sunPosition(new Date('2026-06-21T11:00:00Z'), OSLO.lat, OSLO.lon);
    expect(noon.altitude).toBeGreaterThan(45);
    expect(noon.azimuth).toBeGreaterThan(140);
    expect(noon.azimuth).toBeLessThan(220);
    const midnight = sunPosition(new Date('2026-06-21T23:00:00Z'), OSLO.lat, OSLO.lon);
    expect(midnight.altitude).toBeLessThan(0);
  });

  it('says the day in one line: sunrise, sunset, and how long it lasts', () => {
    const day = sunDay(new Date('2026-06-21T12:00:00Z'), OSLO.lat, OSLO.lon);
    // Clock times are local to the device, so assert the shape and the numbers
    // that are timezone-independent rather than a fixed CEST string.
    expect(describeSunDay(day)).toMatch(/^↑ \d\d:\d\d · ↓ \d\d:\d\d · 18 h \d+ min of daylight$/);
  });

  it('names the polar cases instead of showing a blank where they matter most', () => {
    const polarDay = sunDay(new Date('2026-06-21T12:00:00Z'), 69.65, 18.96);
    expect(describeSunDay(polarDay)).toBe('Midnight sun — the sun stays up all day');
    // Tromsø in December still has usable twilight, so the line names its hours.
    const polarNight = sunDay(new Date('2026-12-21T12:00:00Z'), 69.65, 18.96);
    expect(describeSunDay(polarNight)).toMatch(/^Polar night — twilight \d\d:\d\d–\d\d:\d\d$/);
    // Far enough north the sun never clears -6°: there is no twilight to name.
    const svalbard = sunDay(new Date('2026-12-21T12:00:00Z'), 78.22, 15.65);
    expect(describeSunDay(svalbard)).toBe('Polar night — no daylight or twilight');
  });

  it('labels compass points', () => {
    expect(compass16(0)).toBe('N');
    expect(compass16(90)).toBe('E');
    expect(compass16(202.5)).toBe('SSW');
    expect(compass16(359)).toBe('N');
  });
});

describe('assessFishingBite', () => {
  it('rates an overcast dawn with a light breeze and falling pressure as prime', () => {
    const a = assessFishingBite({
      point: mkPoint({ cloud: 85, windSpeed: 3, precip: 0.4 }),
      sunAltitudeDeg: 4,
      pressureTrendHpa: -2,
    });
    expect(a.rating).toBe('prime');
    expect(a.score).toBeGreaterThanOrEqual(72);
    expect(a.factors.map((f) => f.key)).toEqual(['light', 'temp', 'wind', 'precip', 'pressure']);
  });

  it('rates a cold clear-sky flat-calm midday poorly', () => {
    const a = assessFishingBite({
      point: mkPoint({ cloud: 5, windSpeed: 0.5, temp: 2 }),
      sunAltitudeDeg: 50,
    });
    expect(a.score).toBeLessThan(55);
    const light = a.factors.find((f) => f.key === 'light')!;
    expect(light.rating).toBe('poor');
  });

  it('keeps a warm-air reading at a fair floor (fish deep, not dead lake)', () => {
    const a = assessFishingBite({
      point: mkPoint({ temp: 30 }),
      sunAltitudeDeg: 4,
      species: 'trout',
    });
    const temp = a.factors.find((f) => f.key === 'temp')!;
    expect(temp.score).toBeGreaterThanOrEqual(0.5);
    expect(temp.detail).toContain('deep');
  });

  it('names the downwind shore in the wind advice', () => {
    const a = assessFishingBite({
      point: mkPoint({ windSpeed: 4, windFromDir: 270 }),
      sunAltitudeDeg: 4,
    });
    const wind = a.factors.find((f) => f.key === 'wind')!;
    expect(wind.detail).toContain('downwind (E) shore');
  });

  it('omits the pressure factor when no trend is known', () => {
    const a = assessFishingBite({ point: mkPoint(), sunAltitudeDeg: 4 });
    expect(a.factors.find((f) => f.key === 'pressure')).toBeUndefined();
  });
});

describe('assessHuntStand', () => {
  it('rates first light with a steady light wind highly', () => {
    const a = assessHuntStand({ point: mkPoint({ windSpeed: 3 }), sunAltitudeDeg: 2 });
    expect(a.rating).toBe('prime');
  });

  it('adds the thermal factor only on a defined slope', () => {
    const flat = assessHuntStand({ point: mkPoint(), sunAltitudeDeg: 2 });
    expect(flat.factors.find((f) => f.key === 'thermal')).toBeUndefined();
    const slope = assessHuntStand({
      point: mkPoint({ windSpeed: 2 }),
      sunAltitudeDeg: 2,
      slopeDeg: 12,
      aspectDeg: 90,
    });
    const thermal = slope.factors.find((f) => f.key === 'thermal')!;
    expect(thermal.detail).toContain('drains downhill to the E');
  });
});

describe('pressureTrend', () => {
  it('measures the change vs ~3 h earlier', () => {
    const series = [1013, 1012, 1011, 1010].map((p, i) =>
      mkPoint({ time: `2026-07-19T0${i}:00:00Z`, pressure: p }),
    );
    expect(pressureTrend(series, 3)).toBe(-3);
    expect(pressureTrend(series, 0)).toBeNull();
  });

  it('skips steps without pressure', () => {
    const series = [
      mkPoint({ time: '2026-07-19T00:00:00Z', pressure: 1010 }),
      mkPoint({ time: '2026-07-19T03:00:00Z', pressure: null }),
      mkPoint({ time: '2026-07-19T04:00:00Z', pressure: 1014 }),
    ];
    expect(pressureTrend(series, 2)).toBe(4);
  });
});

describe('buildPlanner', () => {
  const forecast: WeatherForecast = {
    ...OSLO,
    updatedAt: '2026-07-19T00:00:00Z',
    series: Array.from({ length: 30 }, (_, i) =>
      mkPoint({
        time: new Date(Date.parse('2026-07-19T00:00:00Z') + i * 3600_000).toISOString(),
        pressure: 1013 - i * 0.5,
      }),
    ),
  };

  it('drops past steps but keeps the one covering now', () => {
    const rows = buildPlanner(forecast, { now: new Date('2026-07-19T05:30:00Z') });
    expect(rows[0]!.point.time).toBe('2026-07-19T05:00:00.000Z');
  });

  it('caps the horizon and computes sun altitude per row', () => {
    const rows = buildPlanner(forecast, { now: new Date('2026-07-19T00:30:00Z'), maxHours: 12 });
    expect(rows.length).toBe(13); // inclusive horizon
    const noonRow = rows.find((r) => r.point.time.includes('T11:'))!;
    expect(noonRow.sunAltitudeDeg).toBeGreaterThan(40);
  });

  it('attaches assessments only when an activity kind is given', () => {
    const plain = buildPlanner(forecast, { now: new Date('2026-07-19T00:30:00Z') });
    expect(plain[0]!.assessment).toBeUndefined();
    const scored = buildPlanner(forecast, {
      now: new Date('2026-07-19T00:30:00Z'),
      kind: 'fishing',
    });
    expect(scored[5]!.assessment!.score).toBeGreaterThan(0);
    expect(scored[5]!.pressureTrendHpa).toBeLessThan(0);
  });
});

describe('bestWindows', () => {
  const row = (hourIdx: number, score: number | undefined): PlannerHour => ({
    point: mkPoint({}),
    timeMs: Date.parse('2026-07-19T00:00:00Z') + hourIdx * 3600_000,
    sunAltitudeDeg: 0,
    pressureTrendHpa: null,
    ...(score !== undefined
      ? { assessment: { score, rating: 'good', factors: [], summary: '' } as ConditionAssessment }
      : {}),
  });

  it('finds contiguous good runs and ranks by peak', () => {
    const hours = [40, 60, 75, 62, 30, 58, 59, 20].map((s, i) => row(i, s));
    const windows = bestWindows(hours);
    expect(windows.length).toBe(2);
    expect(windows[0]).toMatchObject({ startIdx: 1, endIdx: 3, peakIdx: 2, peakScore: 75 });
    expect(windows[1]).toMatchObject({ startIdx: 5, endIdx: 6, peakScore: 59 });
  });

  it('splits runs across forecast gaps (6-hourly tail)', () => {
    const hours = [row(0, 70), row(1, 70), row(7, 70)];
    const windows = bestWindows(hours);
    expect(windows.length).toBe(2);
    expect(windows[0]!.endIdx).toBe(1);
  });

  it('ignores unassessed rows', () => {
    expect(bestWindows([row(0, undefined), row(1, undefined)])).toEqual([]);
  });
});

describe('windArrow', () => {
  it('points where the wind blows (FROM + 180°), snapped to 8', () => {
    expect(windArrow(0)).toBe('↓'); // FROM north → blows south
    expect(windArrow(90)).toBe('←'); // FROM east → blows west
    expect(windArrow(180)).toBe('↑'); // FROM south → blows north
    expect(windArrow(270)).toBe('→'); // FROM west → blows east
  });
  it('wraps and rounds to the nearest octant', () => {
    expect(windArrow(360)).toBe('↓');
    expect(windArrow(-45)).toBe(windArrow(315));
    expect(windArrow(22)).toBe('↓'); // within 22.5° of N-from
    expect(windArrow(23)).toBe('↙'); // past the midpoint → NE-from
  });
});

describe('forecastTable', () => {
  // Local-time constructor so period grouping holds in any suite timezone.
  const at = (day: number, hour: number) => new Date(2026, 6, day, hour, 0).getTime();
  const hour = (day: number, h: number, o: Partial<WeatherPoint> = {}): PlannerHour => ({
    point: mkPoint({ time: new Date(at(day, h)).toISOString(), ...o }),
    timeMs: at(day, h),
    sunAltitudeDeg: 0,
    pressureTrendHpa: null,
  });

  it('groups a day into its four six-hour periods', () => {
    const rows = Array.from({ length: 24 }, (_, h) => hour(20, h));
    const table = forecastTable(rows);
    expect(table).toHaveLength(1);
    expect(table[0]!.periods.map((p) => p.label)).toEqual([
      'Night',
      'Morning',
      'Afternoon',
      'Evening',
    ]);
    expect(table[0]!.periods.map((p) => p.hoursLabel)).toEqual([
      '00–06',
      '06–12',
      '12–18',
      '18–24',
    ]);
    // 06:00 counts as Morning (the later period), so Night is hours 0–5.
    expect(table[0]!.periods[0]!.hours).toHaveLength(6);
    expect(table[0]!.periods[1]!.hours[0]!.timeMs).toBe(at(20, 6));
  });

  it('summarises temp range, precip total, and peak wind + its direction', () => {
    const rows = [
      hour(20, 6, { temp: 8, windSpeed: 3, windFromDir: 90, windGust: 5, precip: 0.4 }),
      hour(20, 7, { temp: 12, windSpeed: 9, windFromDir: 200, windGust: 14, precip: 1.1 }),
      hour(20, 8, { temp: 10, windSpeed: 6, windFromDir: 270, windGust: 8, precip: 0 }),
    ];
    const cell = forecastTable(rows)[0]!.periods[0]!;
    expect(cell.tempMin).toBe(8);
    expect(cell.tempMax).toBe(12);
    expect(cell.precipMm).toBeCloseTo(1.5, 5);
    expect(cell.windMax).toBe(9);
    expect(cell.gustMax).toBe(14);
    expect(cell.windFromDir).toBe(200); // direction at the windiest hour
  });

  it('picks the wettest hour as representative and selects it', () => {
    const rows = [
      hour(20, 12, { symbol: 'clearsky_day', precip: 0 }),
      hour(20, 13, { symbol: 'heavyrain', precip: 3 }),
      hour(20, 14, { symbol: 'cloudy', precip: 0.2 }),
    ];
    const cell = forecastTable(rows)[0]!.periods[0]!;
    expect(cell.symbol).toBe('heavyrain');
    expect(cell.selectIndex).toBe(1); // flat index of the wettest hour
  });

  it('keeps precip null when no step carried an amount', () => {
    const cell = forecastTable([hour(20, 1, { precip: null, windGust: null })])[0]!.periods[0]!;
    expect(cell.precipMm).toBeNull();
    expect(cell.gustMax).toBeNull();
  });

  it('omits absent periods and spans multiple days in order', () => {
    const rows = [hour(20, 20), hour(21, 8), hour(21, 9)];
    const table = forecastTable(rows);
    expect(table.map((d) => d.dateMs)).toEqual([at(20, 0), at(21, 0)]);
    expect(table[0]!.periods.map((p) => p.label)).toEqual(['Evening']);
    expect(table[1]!.periods.map((p) => p.label)).toEqual(['Morning']);
  });
});
