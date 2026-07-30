import { describe, expect, it } from 'vitest';
import {
  nextCommuteInstant,
  norwayClock,
  norwayInstant,
  norwayOffsetMinutes,
  norwayTime,
  runsOnWeekday,
} from './clock.js';

describe('norwayOffsetMinutes', () => {
  it('is UTC+1 in winter and UTC+2 in summer', () => {
    expect(norwayOffsetMinutes(Date.UTC(2026, 0, 15, 12))).toBe(60);
    expect(norwayOffsetMinutes(Date.UTC(2026, 6, 15, 12))).toBe(120);
  });

  it('switches on the EU changeover, last Sunday of March and October at 01:00 UTC', () => {
    // 2026: 29 March and 25 October.
    expect(norwayOffsetMinutes(Date.UTC(2026, 2, 29, 0, 59))).toBe(60);
    expect(norwayOffsetMinutes(Date.UTC(2026, 2, 29, 1, 0))).toBe(120);
    expect(norwayOffsetMinutes(Date.UTC(2026, 9, 25, 0, 59))).toBe(120);
    expect(norwayOffsetMinutes(Date.UTC(2026, 9, 25, 1, 0))).toBe(60);
  });

  it('finds the changeover when the month ends on a Sunday', () => {
    // 2027: 28 March and 31 October — the October one *is* the last day.
    expect(norwayOffsetMinutes(Date.UTC(2027, 9, 31, 0, 59))).toBe(120);
    expect(norwayOffsetMinutes(Date.UTC(2027, 9, 31, 1, 0))).toBe(60);
  });
});

describe('norwayClock', () => {
  it('renders Norwegian wall-clock time regardless of the runtime zone', () => {
    // This is the bug the whole module exists for: a container clock on UTC
    // would print 05:33 for a train that leaves at 07:33.
    expect(norwayClock(Date.parse('2026-07-21T07:33:00+02:00'))).toBe('07:33');
    expect(norwayClock(Date.parse('2026-01-21T07:33:00+01:00'))).toBe('07:33');
  });
});

describe('norwayTime / norwayInstant', () => {
  it('round-trips a local date and clock time', () => {
    const at = norwayInstant(2026, 6, 30, 7 * 60 + 10);
    expect(norwayClock(at)).toBe('07:10');
    expect(norwayTime(at)).toMatchObject({ year: 2026, month: 6, day: 30, minutesOfDay: 430 });
  });

  it('numbers weekdays the way a commute is described (Monday = 1, Sunday = 7)', () => {
    // 2026-07-30 is a Thursday; 2026-08-02 a Sunday.
    expect(norwayTime(norwayInstant(2026, 6, 30, 600)).weekday).toBe(4);
    expect(norwayTime(norwayInstant(2026, 7, 2, 600)).weekday).toBe(7);
  });

  it('resolves a summer morning to the right instant, not one an hour off', () => {
    expect(new Date(norwayInstant(2026, 6, 30, 7 * 60 + 10)).toISOString()).toBe(
      '2026-07-30T05:10:00.000Z',
    );
    expect(new Date(norwayInstant(2026, 0, 30, 7 * 60 + 10)).toISOString()).toBe(
      '2026-01-30T06:10:00.000Z',
    );
  });
});

describe('nextCommuteInstant', () => {
  const thursdayMorning = norwayInstant(2026, 6, 30, 6 * 60);

  it('is now when the commute has no time of day', () => {
    expect(nextCommuteInstant(null, [], thursdayMorning)).toBe(thursdayMorning);
  });

  it('is today when the time is still ahead', () => {
    expect(nextCommuteInstant(7 * 60 + 10, [], thursdayMorning)).toBe(
      norwayInstant(2026, 6, 30, 7 * 60 + 10),
    );
  });

  it('is tomorrow once it has passed', () => {
    const evening = norwayInstant(2026, 6, 30, 22 * 60 + 30);
    expect(nextCommuteInstant(7 * 60 + 10, [], evening)).toBe(
      norwayInstant(2026, 6, 31, 7 * 60 + 10),
    );
  });

  it('skips to Monday for a weekday commute asked on a Saturday', () => {
    const saturday = norwayInstant(2026, 7, 1, 9 * 60);
    expect(nextCommuteInstant(7 * 60 + 10, [1, 2, 3, 4, 5], saturday)).toBe(
      norwayInstant(2026, 7, 3, 7 * 60 + 10),
    );
  });

  it('crosses a month boundary', () => {
    const lastEvening = norwayInstant(2026, 6, 31, 23 * 60);
    expect(nextCommuteInstant(7 * 60, [], lastEvening)).toBe(norwayInstant(2026, 7, 1, 7 * 60));
  });

  it('crosses the autumn changeover, keeping the wall-clock time', () => {
    const before = norwayInstant(2026, 9, 24, 12 * 60);
    const next = nextCommuteInstant(7 * 60, [], before);
    // 25 October is the switch back to UTC+1; 07:00 still means 07:00.
    expect(norwayClock(next)).toBe('07:00');
    expect(new Date(next).toISOString()).toBe('2026-10-25T06:00:00.000Z');
  });
});

describe('runsOnWeekday', () => {
  it('treats an empty day list as every day', () => {
    expect(runsOnWeekday([], 7)).toBe(true);
    expect(runsOnWeekday([1, 2, 3, 4, 5], 7)).toBe(false);
    expect(runsOnWeekday([1, 2, 3, 4, 5], 3)).toBe(true);
  });
});
