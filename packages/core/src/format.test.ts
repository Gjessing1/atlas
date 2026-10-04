import { describe, expect, it } from 'vitest';
import {
  fmtClock,
  fmtCoords,
  fmtCompactDuration,
  fmtDayClock,
  fmtDayLabel,
  fmtDistanceM,
  fmtDuration,
  fmtEta,
  fmtKm,
  fmtWhenClock,
  garminActivityLabel,
  garminSportFolder,
  trackSummary,
} from './index.js';

describe('fmtClock', () => {
  // Local-time constructor, so these hold whatever timezone the suite runs in.
  const at = (h: number, m: number) => new Date(2026, 6, 20, h, m).getTime();

  it('formats 24-hour with a zero-padded hour', () => {
    expect(fmtClock(at(21, 5))).toBe('21:05');
    expect(fmtClock(at(9, 5))).toBe('09:05');
  });

  it('renders midnight as 00:xx, never 24:xx or 12 AM', () => {
    expect(fmtClock(at(0, 5))).toBe('00:05');
    expect(fmtClock(at(12, 0))).toBe('12:00');
  });

  it('never emits an AM/PM marker', () => {
    for (let h = 0; h < 24; h++) {
      expect(fmtClock(at(h, 30))).toMatch(/^\d{2}:30$/);
    }
  });
});

describe('Garmin activity labels', () => {
  it('shows the imported activity kind without exposing the Garmin id tag', () => {
    expect(garminActivityLabel(['garmin:123', 'trail_running'])).toBe('Trail running');
    expect(garminActivityLabel(['garmin:124', 'backcountry_skiing'])).toBe('Backcountry skiing');
    expect(garminActivityLabel(['garmin:125'])).toBeNull();
    expect(garminActivityLabel(['trail_running'])).toBeNull();
    expect(garminActivityLabel(['garmin-course:9', 'skating_ws'])).toBe('Ice skating');
    expect(garminActivityLabel(['garmin:126', 'resort_skiing_snowboarding_ws'])).toBe(
      'Resort skiing snowboarding',
    );
  });

  it('files every kind of run together and keeps skating, skiing and hiking apart', () => {
    for (const type of ['running', 'trail_running', 'treadmill_running', 'virtual_run'])
      expect(garminSportFolder(type)).toBe('Running');
    expect(garminSportFolder('mountain_biking')).toBe('Cycling');
    expect(garminSportFolder('e_bike_mountain')).toBe('Cycling');
    expect(garminSportFolder('skate_skiing_ws')).toBe('Skiing');
    expect(garminSportFolder('skating_ws')).toBe('Skating');
    expect(garminSportFolder('inline_skating')).toBe('Skating');
    expect(garminSportFolder('mountaineering')).toBe('Hiking');
    expect(garminSportFolder('open_water_swimming')).toBe('Swimming');
    expect(garminSportFolder('stand_up_paddleboarding')).toBe('Paddling');
    expect(garminSportFolder('golf')).toBe('Golf');
    expect(garminSportFolder(null)).toBe('Other');
  });
});

describe('fmtWhenClock', () => {
  const on = (day: number, h: number, m: number) => new Date(2026, 6, day, h, m).getTime();
  const now = on(20, 12, 0);

  it('says only the clock when the time is today', () => {
    expect(fmtWhenClock(on(20, 7, 30), now)).toBe('07:30');
    expect(fmtWhenClock(on(20, 23, 59), now)).toBe('23:59');
  });

  it('names the day once the time is not today', () => {
    // A departure stepped past midnight reading "00:30" would look like half
    // past midnight this morning — twenty-three hours in the wrong direction.
    expect(fmtWhenClock(on(21, 0, 30), now)).toBe(fmtDayClock(on(21, 0, 30)));
    expect(fmtWhenClock(on(19, 22, 0), now)).toBe(fmtDayClock(on(19, 22, 0)));
  });

  it('compares calendar days, not elapsed hours', () => {
    // 23:30 and 00:30 are an hour apart and still different days.
    expect(fmtWhenClock(on(21, 0, 30), on(20, 23, 30))).toBe(fmtDayClock(on(21, 0, 30)));
  });
});

describe('fmtDayLabel', () => {
  const on = (day: number, h: number) => new Date(2026, 6, day, h, 0).getTime();
  const now = on(20, 12);

  it('names yesterday, today and tomorrow', () => {
    expect(fmtDayLabel(on(20, 3), now)).toBe('Today');
    expect(fmtDayLabel(on(20, 23), now)).toBe('Today');
    expect(fmtDayLabel(on(21, 0), now)).toBe('Tomorrow');
    expect(fmtDayLabel(on(19, 23), now)).toBe('Yesterday');
  });

  it('uses weekday + day number further out', () => {
    // 2026-07-22 is a Wednesday.
    expect(fmtDayLabel(on(22, 9), now)).toBe(
      `${new Date(on(22, 9)).toLocaleDateString([], { weekday: 'short' })} 22`,
    );
  });

  it('compares calendar days, not elapsed hours', () => {
    // 23:00 → 01:00 is two hours but a day apart.
    expect(fmtDayLabel(on(21, 1), on(20, 23))).toBe('Tomorrow');
  });
});

describe('distance & coordinate formatting', () => {
  it('formats coordinates and distances for display', () => {
    expect(fmtCoords({ lat: 59.9139456, lng: 10.7522123 })).toBe('59.91395, 10.75221');
    expect(fmtDistanceM(42.4)).toBe('42 m');
    // Above 100 m the last digit would only track GPS jitter.
    expect(fmtDistanceM(347)).toBe('350 m');
    expect(fmtDistanceM(1240)).toBe('1.2 km');
    expect(fmtDistanceM(24_800)).toBe('25 km');
  });

  it('keeps the metre/kilometre boundary at exactly 1000 m', () => {
    expect(fmtKm(999)).toBe('999 m');
    expect(fmtKm(1000)).toBe('1.0 km');
    // Unlike the live readout, a static total keeps its precision at any size.
    expect(fmtKm(347)).toBe('347 m');
    expect(fmtKm(24_800)).toBe('24.8 km');
    expect(fmtKm(0)).toBe('0 m');
  });
});

describe('fmtCompactDuration', () => {
  it('keeps route-mode comparisons compact', () => {
    expect(fmtCompactDuration(27 * 3600_000 + 4 * 60_000)).toBe('27h 4m');
    expect(fmtCompactDuration(42 * 60_000)).toBe('42m');
  });
});

describe('fmtDuration', () => {
  it('splits hours only above the hour', () => {
    expect(fmtDuration(0)).toBe('0 min');
    expect(fmtDuration(45 * 60_000)).toBe('45 min');
    expect(fmtDuration(125 * 60_000)).toBe('2 h 5 min');
  });

  it('rounds to whole minutes before splitting', () => {
    // 59.98 min: the two apps used to render this as "1 h 0 min" and "59 min".
    expect(fmtDuration(3_599_000)).toBe('1 h 0 min');
    expect(fmtDuration(59.6 * 60_000)).toBe('1 h 0 min');
    expect(fmtDuration(29_000)).toBe('0 min');
  });
});

describe('fmtEta', () => {
  it('is the clock time a trip of this length ends at', () => {
    const at = (h: number, m: number) => new Date(2026, 6, 20, h, m).getTime();
    expect(fmtEta(90 * 60_000, at(21, 5))).toBe('22:35');
    // Past midnight is an ordinary answer, not a wrap-around bug.
    expect(fmtEta(60 * 60_000, at(23, 30))).toBe('00:30');
  });
});

describe('trackSummary', () => {
  it('joins the stats a track actually has', () => {
    expect(trackSummary({ distanceM: 12_400, durationMs: 3 * 3_600_000, ascentM: 640.4 })).toBe(
      '12.4 km · 3 h 0 min · ↗ 640 m',
    );
    expect(trackSummary({ distanceM: 850 })).toBe('850 m');
  });

  it('drops a zero duration or ascent rather than printing "0 min"', () => {
    // An imported route has geometry but no timestamps and often no elevation;
    // "0 min · ↗ 0 m" reads as a measurement, not as an absent one.
    expect(trackSummary({ distanceM: 2000, durationMs: 0, ascentM: 0 })).toBe('2.0 km');
  });

  it('still says something when nothing was measurable', () => {
    expect(trackSummary({})).toBe('no stats');
  });
});
