import { describe, expect, it } from 'vitest';

import { transitAlightAlarms, transitCountdown, transitGuidanceAt } from './guidance.js';
import type { TransitLeg, TransitPlace, TransitTrip } from './model.js';

const at = (minutes: number) => Date.UTC(2026, 7, 3, 7, minutes);
const place = (name: string, quay?: string): TransitPlace => ({
  name,
  position: { lat: 59.9, lng: 10.7 },
  ...(quay ? { quay: { publicCode: quay } } : {}),
});
const leg = (
  mode: TransitLeg['mode'],
  start: number,
  end: number,
  from: string,
  to: string,
): TransitLeg => ({
  mode,
  distanceM: 1_000,
  durationMs: at(end) - at(start),
  aimedStartMs: at(start),
  expectedStartMs: at(start),
  aimedEndMs: at(end),
  expectedEndMs: at(end),
  realtime: mode !== 'foot',
  from: place(from, mode === 'foot' ? undefined : '2'),
  to: place(to),
  ...(mode === 'foot' ? {} : { line: { publicCode: 'R14', headsign: 'Kongsvinger' } }),
  intermediateStops: [],
  points: [],
  situations: [],
});
const trip: TransitTrip = {
  startMs: at(0),
  endMs: at(40),
  durationMs: 40 * 60_000,
  walkDistanceM: 800,
  legs: [
    leg('foot', 0, 5, 'Home', 'Asker'),
    leg('rail', 8, 35, 'Asker', 'Nationaltheatret'),
    leg('foot', 35, 40, 'Nationaltheatret', 'Office'),
  ],
};

describe('transitGuidanceAt', () => {
  it('leads with the walk before departure', () => {
    expect(transitGuidanceAt(trip, at(-2))).toMatchObject({
      phase: 'waiting',
      headline: 'Walk to Asker',
      countdown: 'in 2 min',
    });
  });

  it('turns the gap at the station into an explicit boarding countdown', () => {
    expect(transitGuidanceAt(trip, at(6))).toMatchObject({
      phase: 'transfer',
      legIndex: 1,
      headline: 'Board line R14',
      detail: 'Asker · platform 2 toward Kongsvinger',
      countdown: 'in 2 min',
    });
  });

  it('warns during the final two minutes of a ridden leg', () => {
    expect(transitGuidanceAt(trip, at(34))).toMatchObject({
      phase: 'riding',
      headline: 'Get off at Nationaltheatret',
      alightSoon: true,
    });
  });

  it('finishes without trying to reroute a timetable journey', () => {
    expect(transitGuidanceAt(trip, at(41))).toMatchObject({
      phase: 'arrived',
      headline: 'Arrived at Office',
      actionAtMs: null,
    });
  });
});

describe('transitAlightAlarms', () => {
  it('schedules one warning per future ride and no walking alarms', () => {
    expect(transitAlightAlarms(trip, at(0))).toEqual([
      {
        id: `1:${at(35)}`,
        triggerAtMs: at(33),
        arrivalAtMs: at(35),
        title: 'Get off soon',
        body: 'Line R14: get ready for Nationaltheatret.',
      },
    ]);
  });

  it('fires promptly when guidance starts inside the warning window', () => {
    expect(transitAlightAlarms(trip, at(34))[0]?.triggerAtMs).toBe(at(34) + 1_000);
  });
});

it('formats long and immediate countdowns without seconds noise', () => {
  expect(transitCountdown(at(0), at(0) - 30_000)).toBe('now');
  expect(transitCountdown(at(0), at(0) - 65 * 60_000)).toBe('in 1 h 5 min');
});
