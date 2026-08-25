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
    expect(row.text).toBe('07:12 → 07:22 · 10 min · 280 · plt 2');
    // The same row, part by part — this is what the widget lays out, and `text`
    // is only its one-line reading.
    expect(row.time).toBe('07:12');
    // The board's own scan line, as far as one row carries it: a widget that
    // says only when you leave answers half of what the panel two taps away
    // would have told you.
    expect(row.arrival).toBe('07:22');
    expect(row.duration).toBe('10 min');
    expect(row.lines).toBe('280');
    expect(row.changes).toBeNull();
    expect(row.platform).toBe('plt 2');
    // One vehicle, whose window is the scan line already: the leg is there for
    // a client that lays legs out, but the one-line form does not repeat it.
    expect(row.legs).toEqual([
      {
        line: '280',
        mode: 'bus',
        window: '07:12 → 07:22',
        text: '280 07:12 → 07:22',
        change: null,
        wait: null,
        state: 'scheduled',
      },
    ]);
    expect(row.legsText).toBe('280');
    expect(row.statusLabel).toBeNull();
    expect(row.delayLabel).toBeNull();
    expect(row.delayMin).toBeNull();
    expect(row.expected).toBeNull();
    expect(row.whenMs).toBe(at(7 * 60 + 12));
    expect(row.realtime).toBe(false);
    // No live feed behind it: a weaker promise than a realtime departure, and
    // the widget draws it as one.
    expect(row.state).toBe('scheduled');
  });

  /**
   * §3, on the home screen this time: the timetable's number is the primary one
   * and the correction sits beside it. The widget used to print 07:16 — the
   * *expected* time — which disagreed with the sign at the stop, with the app's
   * own commute board and with the timetable the reader has memorised.
   */
  it('leads with the scheduled time and puts the correction beside it', () => {
    const liveRide = ride('280', at(7 * 60 + 10), at(7 * 60 + 16));
    liveRide.startPredictionInaccurate = true;
    const row = tripWidgetRow(trip(liveRide), NOW);
    expect(row.text).toBe('07:10 (+6) → 07:20 · 10 min · 280');
    expect(row.time).toBe('07:10');
    expect(row.expected).toBe('07:16');
    expect(row.delayLabel).toBe('+6');
    expect(row.delayMin).toBe(6);
    // The row still knows when the bus actually comes — a departure board may
    // print 07:10 for ever, and the refresh schedule is measured from this.
    expect(row.whenMs).toBe(at(7 * 60 + 16));
    expect(row.realtime).toBe(true);
    expect(row.predictionInaccurate).toBe(true);
    expect(row.state).toBe('delayed');
  });

  it('calls a service running ahead of the timetable early, not late', () => {
    const row = tripWidgetRow(trip(ride('280', at(7 * 60 + 20), at(7 * 60 + 17))), NOW);
    expect(row.delayLabel).toBe('-3');
    expect(row.state).toBe('early');
    expect(row.text).toBe('07:20 (-3) → 07:30 · 10 min · 280');
  });

  /**
   * The complaint this batch answers, at widget scale: "🚌 280 → 🚆 RE10" says a
   * train is involved and nothing about when it leaves Asker.
   */
  it('gives every vehicle its own window, so a two-leg journey is not two mysteries', () => {
    const bus = ride('280', at(7 * 60 + 12));
    const train = ride('RE10', at(7 * 60 + 31));
    train.from = place('Asker stasjon');
    train.to = place('Nationaltheatret');
    const row = tripWidgetRow(trip(walk(at(7 * 60)), bus, train), NOW);
    expect(row.lines).toBe('280 → RE10');
    expect(row.changes).toBe('9 min at Asker stasjon');
    expect(row.arrival).toBe('07:41');
    expect(row.duration).toBe('29 min');
    // The panel's leg strip, part by part: when the bus goes, when the train
    // goes, and how long you stand at Asker between them.
    expect(row.legs.map((leg) => leg.text)).toEqual(['280 07:12 → 07:22', 'RE10 07:31 → 07:41']);
    // The change belongs to the vehicle it precedes, not to the one it follows.
    expect(row.legs[0]!.change).toBeNull();
    expect(row.legs[1]!.change).toBe('9 min at Asker stasjon');
    expect(row.legs[1]!.wait).toBe('9 min');
    expect(row.legsText).toBe('280 07:12 → 07:22 · 9 min at Asker stasjon · RE10 07:31 → 07:41');
    expect(row.text).toBe(
      '07:12 → 07:41 · 29 min · 280 07:12 → 07:22 · 9 min at Asker stasjon · RE10 07:31 → 07:41',
    );
  });

  it('is live when the feed is behind the time and it is running to it', () => {
    const onTime = ride('280', at(7 * 60 + 20));
    onTime.realtime = true;
    expect(tripWidgetRow(trip(onTime), NOW).state).toBe('live');
  });

  it('names every vehicle in ride order', () => {
    const row = tripWidgetRow(
      trip(walk(at(7 * 60)), ride('280', at(7 * 60 + 12)), ride('RE10', at(7 * 60 + 30))),
      NOW,
    );
    expect(row.lines).toBe('280 → RE10');
    expect(row.legs.map((leg) => leg.line)).toEqual(['280', 'RE10']);
  });

  it('times the row from the vehicle, not from the walk to the stop', () => {
    // The old widget printed the journey's own start — which is when you leave
    // the house, not when the bus goes. `whenMs` is also what the refresh
    // schedule wakes two minutes before.
    const row = tripWidgetRow(trip(walk(at(7 * 60 + 1)), ride('280', at(7 * 60 + 21))), NOW);
    expect(row.time).toBe('07:21');
    expect(row.whenMs).toBe(at(7 * 60 + 21));
  });

  it('carries the disruption the previous widget dropped', () => {
    const leg = ride('280', at(7 * 60 + 12));
    leg.situations = [{ summary: 'Innstilt avgang', severity: 'severe' }];
    expect(tripWidgetRow(trip(leg), NOW).note).toBe('Innstilt avgang');
  });

  /**
   * The countdown is gone, and this is what took its place: nothing. It
   * restated the departure time, it was the widest column on the line, and it
   * was the only part of a row that stopped being true while being looked at.
   */
  it('states a timetable rather than counting down to it', () => {
    const row = tripWidgetRow(trip(ride('280', at(6 * 60 + 55))), NOW);
    expect(row.text).toBe('06:55 → 07:05 · 10 min · 280');
    expect(row.text).not.toMatch(/\b(now|in \d)\b/);
    expect(row.statusLabel).toBeNull();
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
    const row = departureWidgetRow(departure());
    expect(row.text).toBe('07:22 · 280 → Dikemark · plt 1');
    // A departure is not a journey: there is no strip to draw, and no arrival
    // at a far end this board was never told about.
    expect(row.legs).toEqual([]);
    expect(row.legsText).toBe('280 → Dikemark');
    expect(row.arrival).toBeNull();
  });

  it('says a cancellation in words, since a struck-through time is only a colour', () => {
    // The expected time of a cancelled departure is the ghost of a service that
    // will not run, and there is no platform to walk to.
    const row = departureWidgetRow(
      departure({ cancelled: true, expectedDepartureMs: at(7 * 60 + 29) }),
    );
    expect(row.text).toBe('07:22 · Cancelled · 280 → Dikemark');
    expect(row.time).toBe('07:22');
    expect(row.statusLabel).toBe('Cancelled');
    expect(row.platform).toBeNull();
    expect(row.delayLabel).toBeNull();
    expect(row.cancelled).toBe(true);
    expect(row.state).toBe('cancelled');
  });
});

describe('commuteRefreshAtMs', () => {
  const row = (whenMs: number): TransitWidgetRow => ({
    whenMs,
    time: '',
    expected: null,
    delayLabel: null,
    delayMin: null,
    arrival: null,
    duration: null,
    lines: '',
    changes: null,
    legs: [],
    legsText: '',
    platform: null,
    statusLabel: null,
    realtime: false,
    predictionInaccurate: false,
    cancelled: false,
    state: 'scheduled',
    note: null,
    text: '',
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
      results: [{ key: 'outbound', result, emptyReason: 'none' }],
      nowMs: NOW,
    });
    expect(board.route).toBe('Engelsrud ↔ Nationaltheatret · via Asker stasjon');
    expect(board.directions[0]!.label).toBe('Engelsrud → Nationaltheatret');
    expect(board.directions[0]!.rows[0]!.text).toBe('07:12 → 07:22 · 10 min · 280 · plt 2');
    expect(board.directions[0]!.note).toBeNull();
    expect(board.status).toBe('Entur live · checked 07:00');
    // The clock is in the board twice on purpose: `status` for a surface that
    // can only paint a line, `checkedMs` for one that can age it as it sits.
    expect(board.source).toBe('Entur live');
    expect(board.checked).toBe('checked 07:00');
    expect(board.checkedMs).toBe(NOW);
  });

  it('tells "nothing runs" apart from "your lines removed everything"', () => {
    const empty = { trips: [], problems: [] };
    const upstream = commuteWidgetBoard({
      query: commute(),
      results: [{ key: 'outbound', result: empty, emptyReason: 'upstream' }],
      nowMs: NOW,
    });
    expect(upstream.status).toBe('Nothing runs in this window · checked 07:00');
    expect(upstream.source).toBe('Nothing runs in this window');
    const filtered = commuteWidgetBoard({
      query: commute(),
      results: [{ key: 'inbound', result: empty, emptyReason: 'filtered' }],
      nowMs: NOW,
    });
    expect(filtered.directions[0]!.note).toBe('No journey uses only your chosen lines');
  });

  /**
   * The home screen has room for three rows, so *which* three is the whole
   * question. Entur ranks rather than sorts, and the widget used to take the
   * head of that ranking: on the live corridor that put 20:42 above 20:29 and
   * spent one of its three rows on a second way to catch the same 20:42 bus.
   */
  it('keeps the earliest departures, in time order, one row per departure', () => {
    const laterTrain = trip(ride('280', at(7 * 60 + 40)));
    // Same bus, a slower connection at the far end: not a second row.
    laterTrain.legs[0]!.aimedEndMs += 20 * 60_000;
    laterTrain.legs[0]!.expectedEndMs += 20 * 60_000;
    const board = commuteWidgetBoard({
      query: commute(),
      results: [
        {
          key: 'outbound',
          result: {
            trips: [
              trip(ride('280', at(8 * 60))),
              laterTrain,
              trip(ride('280', at(7 * 60 + 40))),
              trip(ride('280', at(7 * 60 + 20))),
            ],
            problems: [],
          },
          emptyReason: 'none',
        },
      ],
      nowMs: NOW,
      maxRows: 3,
    });
    expect(board.directions[0]!.rows.map((row) => row.time)).toEqual(['07:20', '07:40', '08:00']);
    expect(board.directions[0]!.rows[1]!.arrival).toBe('07:50');
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
