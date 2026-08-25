import { describe, expect, it } from 'vitest';

import { norwayInstant } from './clock.js';
import {
  commuteBoardRows,
  commuteDurationLabel,
  commuteEstimateLabel,
  commuteJourney,
  commuteLeaveNow,
  commuteNowLabel,
  commuteOffDayNote,
  commuteSegments,
} from './dashboard.js';
import { legTimeParts } from './labels.js';
import type {
  TransitCommuteQuery,
  TransitLeg,
  TransitResult,
  TransitSituation,
  TransitTrip,
} from './model.js';

/** Tuesday 25 August 2026, 08:32 Norwegian summer time — the spec's own clock. */
const NOW = norwayInstant(2026, 7, 25, 8 * 60 + 32);
const at = (minutesOfDay: number) => norwayInstant(2026, 7, 25, minutesOfDay);
const hm = (hours: number, minutes: number) => at(hours * 60 + minutes);

const place = (name: string, quay?: string) => ({
  name,
  position: { lat: 59.9, lng: 10.6 },
  ...(quay ? { quay: { publicCode: quay } } : {}),
});

function ride(
  opts: Partial<TransitLeg> & {
    line: string;
    from: string;
    to: string;
    aimedStartMs: number;
    aimedEndMs: number;
  },
): TransitLeg {
  const { line, from, to, ...rest } = opts;
  return {
    mode: 'bus',
    distanceM: 5_000,
    durationMs: rest.aimedEndMs - rest.aimedStartMs,
    expectedStartMs: rest.aimedStartMs,
    expectedEndMs: rest.aimedEndMs,
    realtime: false,
    from: place(from),
    to: place(to),
    line: { id: `X:Line:${line}`, publicCode: line },
    intermediateStops: [],
    points: [],
    situations: [],
    ...rest,
  };
}

function walk(fromMs: number, toMs: number): TransitLeg {
  return {
    mode: 'foot',
    distanceM: 120,
    durationMs: toMs - fromMs,
    aimedStartMs: fromMs,
    expectedStartMs: fromMs,
    aimedEndMs: toMs,
    expectedEndMs: toMs,
    realtime: false,
    from: place('Asker stasjon'),
    to: place('Asker stasjon'),
    intermediateStops: [],
    points: [],
    situations: [],
  };
}

const trip = (...legs: TransitLeg[]): TransitTrip => ({
  startMs: legs[0]!.expectedStartMs,
  endMs: legs[legs.length - 1]!.expectedEndMs,
  durationMs: legs[legs.length - 1]!.expectedEndMs - legs[0]!.expectedStartMs,
  walkDistanceM: 120,
  legs,
});

/** The spec's own journey: 08:36 bus → 09:02 Asker → 09:11 train → 09:24. */
const specJourney = () =>
  trip(
    ride({
      line: '270',
      from: 'Engelsrud Terrasse',
      to: 'Asker stasjon',
      aimedStartMs: hm(8, 36),
      aimedEndMs: hm(9, 2),
    }),
    walk(hm(9, 2), hm(9, 4)),
    ride({
      line: 'L1',
      mode: 'rail',
      from: 'Asker stasjon',
      to: 'Nationaltheatret',
      aimedStartMs: hm(9, 11),
      aimedEndMs: hm(9, 24),
    }),
  );

const commuteQuery = (via = true): TransitCommuteQuery => ({
  from: { name: 'Engelsrud Terrasse', lat: 59.83, lng: 10.42 },
  via: via ? [{ name: 'Asker stasjon', lat: 59.83, lng: 10.43 }] : [],
  to: { name: 'Nationaltheatret', lat: 59.91, lng: 10.73 },
  filter: { select: [], exclude: [], modes: [] },
  outboundTime: { minutesOfDay: null, arriveBy: false },
  inboundTime: { minutesOfDay: null, arriveBy: false },
  days: [],
});

describe('commuteJourney', () => {
  it('reads the ends off the vehicles, not off the walk to the stop', () => {
    const journey = commuteJourney(specJourney(), NOW);
    expect(journey.departure.aimed).toBe('08:36');
    expect(journey.arrival.aimed).toBe('09:24');
    expect(journey.duration).toBe('48 min');
    expect(journey.scan).toBe('08:36 → 09:24 · 48 min');
  });

  it('computes the connection so nobody subtracts two clock times on a platform', () => {
    const journey = commuteJourney(specJourney(), NOW);
    expect(journey.connections).toHaveLength(1);
    expect(journey.connections[0]).toMatchObject({
      at: 'Asker stasjon',
      arrive: '09:02',
      depart: '09:11',
      label: '9 min',
      tight: false,
    });
  });

  it('flags a connection with no slack rather than presenting it as ordinary', () => {
    const tight = trip(
      ride({ line: '270', from: 'A', to: 'B', aimedStartMs: hm(8, 36), aimedEndMs: hm(9, 2) }),
      ride({ line: 'L1', from: 'B', to: 'C', aimedStartMs: hm(9, 4), aimedEndMs: hm(9, 24) }),
    );
    expect(commuteJourney(tight, NOW).connections[0]).toMatchObject({
      label: '2 min',
      tight: true,
    });
  });

  it('keeps the scheduled time primary when a live feed corrects it (§3)', () => {
    const late = trip(
      ride({
        line: '270',
        from: 'Engelsrud Terrasse',
        to: 'Asker stasjon',
        aimedStartMs: hm(8, 41),
        aimedEndMs: hm(9, 2),
        expectedStartMs: hm(8, 43),
        expectedEndMs: hm(9, 4),
        realtime: true,
      }),
    );
    const journey = commuteJourney(late, NOW);
    // The number the departure board at the stop shows.
    expect(journey.departure.aimed).toBe('08:41');
    // The correction, kept beside it rather than in place of it.
    expect(journey.departure.expected).toBe('08:43');
    expect(journey.departure.delay).toBe('+2 min');
    expect(journey.scan.startsWith('08:41')).toBe(true);
    expect(journey.state).toBe('delayed');
  });

  it('states a delay once — in the state and the estimate, not as a notice too', () => {
    // A measured delay is already said three ways (the row's state colour, the
    // estimate label, the leg's own "est." line). Restating it as a warning box
    // was four, and the box was the one that pushed the next journey's scan
    // line off the panel.
    const late = trip(
      ride({
        line: '270',
        from: 'A',
        to: 'B',
        aimedStartMs: hm(8, 41),
        aimedEndMs: hm(9, 2),
        expectedStartMs: hm(8, 49),
        expectedEndMs: hm(9, 10),
        realtime: true,
      }),
    );
    const journey = commuteJourney(late, NOW);
    expect(journey.disruptions).toEqual([]);
    expect(journey.state).toBe('delayed');
    expect(journey.departure.delay).toBe('+8 min');
  });

  it('tells a planned closure apart from an incident and a cancellation (§4)', () => {
    const situation = (extra: Partial<TransitSituation>): TransitSituation => ({
      id: `S${extra.summary ?? ''}`,
      summary: 'Signalfeil mellom Asker og Sandvika',
      severity: 'warning',
      ...extra,
    });
    const kind = (leg: Partial<TransitLeg>, s: Partial<TransitSituation>) =>
      commuteJourney(
        trip(
          ride({
            line: 'L1',
            from: 'A',
            to: 'B',
            aimedStartMs: hm(8, 41),
            aimedEndMs: hm(9, 2),
            situations: [situation(s)],
            ...leg,
          }),
        ),
        NOW,
      ).disruptions[0]?.kind;

    expect(kind({}, {})).toBe('incident');
    expect(kind({}, { planned: true })).toBe('planned');
    expect(kind({ replacement: true }, {})).toBe('replacement');
    // Leg facts beat prose: an operator publishing a cancellation as a `general`
    // report is still a cancellation.
    expect(kind({ cancelled: true }, { planned: true })).toBe('cancellation');
  });

  it('warns once about a situation attached to two legs of the same line', () => {
    const shared: TransitSituation = { id: 'SIT-1', summary: 'Delays on L1', severity: 'warning' };
    const twice = trip(
      ride({
        line: 'L1',
        from: 'A',
        to: 'B',
        aimedStartMs: hm(8, 36),
        aimedEndMs: hm(9, 2),
        situations: [shared],
      }),
      ride({
        line: 'L1',
        from: 'B',
        to: 'C',
        aimedStartMs: hm(9, 11),
        aimedEndMs: hm(9, 24),
        situations: [shared],
      }),
    );
    expect(commuteJourney(twice, NOW).disruptions).toHaveLength(1);
  });

  it('names the day only when the departure is not today', () => {
    expect(commuteJourney(specJourney(), NOW).dayNote).toBeNull();
    const tomorrow = trip(
      ride({
        line: '270',
        from: 'A',
        to: 'B',
        aimedStartMs: at(24 * 60 + 6 * 60),
        aimedEndMs: at(24 * 60 + 6 * 60 + 20),
      }),
    );
    expect(commuteJourney(tomorrow, NOW).dayNote).toBe('Tomorrow');
  });
});

describe('commuteSegments', () => {
  it('generates the four directed hops from three stops (§8)', () => {
    expect(commuteSegments(commuteQuery()).map((segment) => segment.label)).toEqual([
      'Engelsrud Terrasse → Asker stasjon',
      'Asker stasjon → Nationaltheatret',
      'Nationaltheatret → Asker stasjon',
      'Asker stasjon → Engelsrud Terrasse',
    ]);
  });

  it('generates none without an interchange — the journey list is already that board', () => {
    expect(commuteSegments(commuteQuery(false))).toEqual([]);
  });
});

describe('commuteBoardRows', () => {
  const result = (...trips: TransitTrip[]): TransitResult => ({ trips, problems: [] });

  it('puts the board in time order, whatever order the planner ranked it in', () => {
    // Measured shape: Entur answered 08:49, 08:59, 09:09, 09:04, 09:19 for
    // Asker → Nationaltheatret on 2026-08-25.
    const rows = commuteBoardRows(
      result(
        ...[
          [8, 49],
          [8, 59],
          [9, 9],
          [9, 4],
          [9, 19],
        ].map(([h, m]) =>
          trip(
            ride({
              line: 'R13',
              from: 'Asker stasjon',
              to: 'Nationaltheatret',
              aimedStartMs: hm(h!, m!),
              aimedEndMs: hm(h!, m!) + 18 * 60_000,
            }),
          ),
        ),
      ),
      NOW,
    );
    expect(rows.map((row) => row.aimed)).toEqual(['08:49', '08:59', '09:04', '09:09', '09:19']);
  });

  it('carries the arrival a stop board could never know', () => {
    const [row] = commuteBoardRows(
      result(
        trip(
          ride({
            line: '270',
            from: 'Engelsrud Terrasse',
            to: 'Asker stasjon',
            aimedStartMs: hm(8, 36),
            aimedEndMs: hm(9, 2),
          }),
        ),
      ),
      NOW,
    );
    expect(row).toMatchObject({ aimed: '08:36', arrival: '09:02', countdown: 'in 4 min' });
  });

  it('drops an all-walk answer: a true journey, but not a departure', () => {
    expect(commuteBoardRows(result(trip(walk(hm(8, 40), hm(8, 55)))), NOW)).toEqual([]);
  });
});

describe('commuteEstimateLabel', () => {
  const parts = (aimed: number, expected: number, realtime: boolean) =>
    legTimeParts({ aimedMs: aimed, expectedMs: expected, realtime });

  it('labels the estimate rather than replacing the scheduled time', () => {
    expect(commuteEstimateLabel(parts(hm(8, 41), hm(8, 43), true), false)).toBe('08:43 est.');
  });

  it('says a live service is on time, and a timetabled one is only timetabled', () => {
    expect(commuteEstimateLabel(parts(hm(8, 41), hm(8, 41), true), false)).toBe('On time');
    expect(commuteEstimateLabel(parts(hm(8, 41), hm(8, 41), false), false)).toBe('Timetable');
  });

  it('says cancelled above everything else', () => {
    expect(commuteEstimateLabel(parts(hm(8, 41), hm(8, 43), true), true)).toBe('Cancelled');
  });
});

describe('commuteLeaveNow', () => {
  const journeyAt = (h: number, m: number, expectedOffsetMs = 0) =>
    commuteJourney(
      trip(
        ride({
          line: '270',
          from: 'A',
          to: 'B',
          aimedStartMs: hm(h, m),
          aimedEndMs: hm(h, m) + 20 * 60_000,
          expectedStartMs: hm(h, m) + expectedOffsetMs,
          expectedEndMs: hm(h, m) + 20 * 60_000 + expectedOffsetMs,
          realtime: expectedOffsetMs !== 0,
        }),
      ),
      NOW,
    );

  it('offers the next departure and what missing it costs', () => {
    const { next, following } = commuteLeaveNow(
      [journeyAt(8, 36), journeyAt(8, 44), journeyAt(8, 51)],
      NOW,
    );
    expect(next?.departure.aimed).toBe('08:36');
    expect(following?.departure.aimed).toBe('08:44');
  });

  it('still offers a bus running late enough to still be catchable', () => {
    // Scheduled 08:30 (gone), running four minutes late, so it leaves at 08:34
    // — which is two minutes ago at 08:32 by the schedule and reachable by the
    // clock. Judged on the expected time, it is still the next departure.
    const { next } = commuteLeaveNow([journeyAt(8, 30, 4 * 60_000), journeyAt(8, 44)], NOW);
    expect(next?.departure.aimed).toBe('08:30');
  });
});

describe('labels', () => {
  it('formats durations the way a timetable prints them', () => {
    expect(commuteDurationLabel(48 * 60_000)).toBe('48 min');
    expect(commuteDurationLabel(60 * 60_000)).toBe('1 h');
    expect(commuteDurationLabel(72 * 60_000)).toBe('1 h 12 min');
  });

  it('says when it is, in Norwegian wall-clock terms', () => {
    expect(commuteNowLabel(NOW)).toBe('Tuesday 25 August · 08:32');
  });

  it('explains a weekday the commute is not saved for instead of blaming the timetable', () => {
    // Saturday, on a Mon–Fri commute.
    expect(commuteOffDayNote([1, 2, 3, 4, 5], 6)).toContain('not saved for today');
    expect(commuteOffDayNote([1, 2, 3, 4, 5], 2)).toBeNull();
    expect(commuteOffDayNote([], 6)).toBeNull();
  });
});
