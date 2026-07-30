import { describe, expect, it } from 'vitest';
import { norwayInstant } from './clock.js';
import {
  commuteRefreshAtMs,
  commuteRouteLabel,
  commuteWidgetBoard,
  departureWidgetRow,
  tripWidgetRow,
  windowOpensAtMs,
  type TransitWidgetRow,
} from './widget.js';
import type { TransitCommuteQuery, TransitDeparture, TransitLeg, TransitTrip } from './model.js';

const NOW = norwayInstant(2026, 6, 30, 7 * 60); // Thursday 07:00, summer time.
const at = (minutesOfDay: number) => norwayInstant(2026, 6, 30, minutesOfDay);

const place = (name: string, quay?: string) => ({
  name,
  position: { lat: 59.9, lng: 10.6 },
  ...(quay ? { quay: { publicCode: quay } } : {}),
});

function ride(
  publicCode: string,
  aimedMs: number,
  expectedMs = aimedMs,
  quay?: string,
): TransitLeg {
  return {
    mode: 'bus',
    distanceM: 1_000,
    durationMs: 600_000,
    aimedStartMs: aimedMs,
    expectedStartMs: expectedMs,
    aimedEndMs: aimedMs + 600_000,
    expectedEndMs: expectedMs + 600_000,
    realtime: expectedMs !== aimedMs,
    from: place('Engelsrud', quay),
    to: place('Asker stasjon'),
    line: { id: `X:Line:${publicCode}`, publicCode },
    intermediateStops: [],
    points: [],
    situations: [],
  };
}

function walk(fromMs: number): TransitLeg {
  return {
    mode: 'foot',
    distanceM: 300,
    durationMs: 240_000,
    aimedStartMs: fromMs,
    expectedStartMs: fromMs,
    aimedEndMs: fromMs + 240_000,
    expectedEndMs: fromMs + 240_000,
    realtime: false,
    from: place('Home'),
    to: place('Engelsrud'),
    intermediateStops: [],
    points: [],
    situations: [],
  };
}

const trip = (...legs: TransitLeg[]): TransitTrip => ({
  startMs: legs[0]!.expectedStartMs,
  endMs: legs[legs.length - 1]!.expectedEndMs,
  durationMs: 1_800_000,
  walkDistanceM: 300,
  legs,
});

const commute = (over: Partial<TransitCommuteQuery> = {}): TransitCommuteQuery => ({
  from: { name: 'Engelsrud', lat: 59.82, lng: 10.37 },
  via: [],
  to: { name: 'Nationaltheatret', lat: 59.91, lng: 10.73 },
  filter: { select: [], exclude: [], modes: [] },
  outboundTime: { minutesOfDay: null, arriveBy: false },
  inboundTime: { minutesOfDay: null, arriveBy: false },
  days: [],
  ...over,
});

describe('tripWidgetRow', () => {
  it('reads the way a commuter reads it', () => {
    const row = tripWidgetRow(
      trip(walk(at(7 * 60 + 2)), ride('280', at(7 * 60 + 12), at(7 * 60 + 12), '2')),
      NOW,
    );
    expect(row.text).toBe('07:12 · in 12 min · 280 · plt 2');
    expect(row.delayMin).toBeNull();
    expect(row.aimed).toBeNull();
    expect(row.whenMs).toBe(at(7 * 60 + 12));
  });

  it('shows the delay against the timetable, and keeps the aimed time', () => {
    const row = tripWidgetRow(trip(ride('280', at(7 * 60 + 10), at(7 * 60 + 16))), NOW);
    expect(row.text).toBe('07:16 (+6) · in 16 min · 280');
    expect(row.delayMin).toBe(6);
    expect(row.aimed).toBe('07:10');
  });

  it('names every vehicle in ride order', () => {
    const row = tripWidgetRow(
      trip(walk(at(7 * 60)), ride('280', at(7 * 60 + 12)), ride('RE10', at(7 * 60 + 30))),
      NOW,
    );
    expect(row.text).toContain('280 → RE10');
  });

  it('counts down from the vehicle, not from the walk to the stop', () => {
    // The old widget printed the journey's own start — which is when you leave
    // the house, not when the bus goes.
    const row = tripWidgetRow(trip(walk(at(7 * 60 + 1)), ride('280', at(7 * 60 + 21))), NOW);
    expect(row.countdownMin).toBe(21);
  });

  it('carries the disruption the previous widget dropped', () => {
    const leg = ride('280', at(7 * 60 + 12));
    leg.situations = [{ summary: 'Innstilt avgang', severity: 'severe' }];
    expect(tripWidgetRow(trip(leg), NOW).note).toBe('Innstilt avgang');
  });

  it('says "now" rather than counting into the past', () => {
    expect(tripWidgetRow(trip(ride('280', at(6 * 60 + 55))), NOW).text).toContain('now');
    expect(tripWidgetRow(trip(ride('280', at(6 * 60 + 55))), NOW).countdownMin).toBe(0);
  });

  it('reads hours out loud past the first one', () => {
    expect(tripWidgetRow(trip(ride('280', at(9 * 60 + 5))), NOW).text).toContain('in 2 h 5 min');
  });
});

describe('departureWidgetRow', () => {
  const departure = (over: Partial<TransitDeparture> = {}): TransitDeparture => ({
    id: 'x',
    mode: 'bus',
    aimedDepartureMs: at(7 * 60 + 22),
    expectedDepartureMs: at(7 * 60 + 22),
    realtime: true,
    cancelled: false,
    destination: 'Dikemark',
    line: { id: 'RUT:Line:280', publicCode: '280' },
    quay: { publicCode: '1' },
    situations: [],
    ...over,
  });

  it('always states the direction — one line at one stop runs both ways', () => {
    expect(departureWidgetRow(departure(), NOW).text).toBe(
      '07:22 · in 22 min · 280 → Dikemark · plt 1',
    );
  });

  it('makes a cancellation explicit instead of counting down to it', () => {
    const row = departureWidgetRow(departure({ cancelled: true }), NOW);
    expect(row.text).toBe('07:22 · cancelled · 280 → Dikemark');
    expect(row.cancelled).toBe(true);
  });
});

describe('commuteRefreshAtMs', () => {
  const row = (whenMs: number): TransitWidgetRow => ({
    whenMs,
    text: '',
    aimed: null,
    countdownMin: 0,
    delayMin: null,
    cancelled: false,
    note: null,
  });

  it('wakes two minutes before the next departure', () => {
    expect(commuteRefreshAtMs(commute(), [row(at(7 * 60 + 30))], NOW)).toBe(at(7 * 60 + 28));
  });

  it('never asks sooner than five minutes, so a live delay has time to land', () => {
    expect(commuteRefreshAtMs(commute(), [row(at(7 * 60 + 3))], NOW)).toBe(at(7 * 60 + 5));
  });

  it('follows the commute window, not the wall clock, when nothing is upcoming', () => {
    // 23:00 on a Saturday with a weekday 07:10 commute: the old fixed 15-minute
    // period asked all night and all weekend.
    const saturdayNight = norwayInstant(2026, 7, 1, 23 * 60);
    const query = commute({
      days: [1, 2, 3, 4, 5],
      outboundTime: { minutesOfDay: 7 * 60 + 10, arriveBy: false },
    });
    const next = commuteRefreshAtMs(query, [], saturdayNight);
    // Monday 06:55 is more than six hours away, so it is capped — but the cap is
    // hours, not the quarter of an hour it used to be.
    expect(next - saturdayNight).toBe(6 * 60 * 60_000);
  });

  it('wakes a quarter of an hour before the window opens', () => {
    const query = commute({ outboundTime: { minutesOfDay: 9 * 60, arriveBy: false } });
    expect(commuteRefreshAtMs(query, [], at(7 * 60))).toBe(at(8 * 60 + 45));
  });
});

describe('windowOpensAtMs', () => {
  it('is now for a commute with no times', () => {
    expect(windowOpensAtMs(commute(), NOW)).toBe(NOW);
  });

  it('takes whichever direction comes first', () => {
    const query = commute({
      outboundTime: { minutesOfDay: 7 * 60 + 10, arriveBy: false },
      inboundTime: { minutesOfDay: 16 * 60, arriveBy: false },
    });
    expect(windowOpensAtMs(query, at(12 * 60))).toBe(at(16 * 60));
  });
});

describe('commuteWidgetBoard', () => {
  const result = {
    trips: [trip(walk(at(7 * 60 + 2)), ride('280', at(7 * 60 + 12), at(7 * 60 + 12), '2'))],
    problems: [],
  };

  it('names the route and the direction, and dates its own answer', () => {
    const board = commuteWidgetBoard({
      query: commute({ via: [{ name: 'Asker stasjon', lat: 59.83, lng: 10.43 }] }),
      results: [{ key: 'outbound', result, emptyReason: 'upstream' }],
      nowMs: NOW,
    });
    expect(board.route).toBe('Engelsrud ↔ Nationaltheatret · via Asker stasjon');
    expect(board.directions[0]!.label).toBe('Engelsrud → Nationaltheatret');
    expect(board.directions[0]!.rows[0]!.text).toBe('07:12 · in 12 min · 280 · plt 2');
    expect(board.status).toBe('Entur live · checked 07:00');
  });

  it('tells "nothing runs" apart from "your lines removed everything"', () => {
    const empty = { trips: [], problems: [] };
    const upstream = commuteWidgetBoard({
      query: commute(),
      results: [{ key: 'outbound', result: empty, emptyReason: 'upstream' }],
      nowMs: NOW,
    });
    expect(upstream.status).toBe('Nothing runs in this window · checked 07:00');
    const filtered = commuteWidgetBoard({
      query: commute(),
      results: [{ key: 'inbound', result: empty, emptyReason: 'filtered' }],
      nowMs: NOW,
    });
    expect(filtered.directions[0]!.note).toBe('No journey uses only your chosen lines');
  });

  it('trims to what the layout can hold and schedules against the earliest row', () => {
    const board = commuteWidgetBoard({
      query: commute(),
      results: [
        {
          key: 'outbound',
          result: {
            trips: [
              trip(ride('280', at(8 * 60))),
              trip(ride('280', at(7 * 60 + 40))),
              trip(ride('280', at(9 * 60))),
            ],
            problems: [],
          },
          emptyReason: 'upstream',
        },
      ],
      nowMs: NOW,
      maxRows: 2,
    });
    expect(board.directions[0]!.rows).toHaveLength(2);
    expect(board.nextRefreshMs).toBe(at(7 * 60 + 38));
  });
});

describe('commuteRouteLabel', () => {
  it('reads both ways round, because the commute does', () => {
    expect(commuteRouteLabel(commute())).toBe('Engelsrud ↔ Nationaltheatret');
  });
});
