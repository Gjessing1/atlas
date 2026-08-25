import { describe, expect, it } from 'vitest';
import {
  commuteEmptyReason,
  commuteLineFilter,
  commuteSegmentQueries,
  commuteTransitQueries,
  commuteTripMatches,
  defaultCommuteDirection,
  filterCommuteResult,
} from './commute.js';
import { norwayInstant } from './clock.js';
import type {
  TransitCommuteFilter,
  TransitCommuteQuery,
  TransitLeg,
  TransitLineRef,
  TransitTrip,
} from './model.js';

const place = (name: string) => ({ name, position: { lat: 59.9, lng: 10.6 } });

const line = (id: string, publicCode: string, mode: TransitLineRef['mode']): TransitLineRef => ({
  id,
  publicCode,
  mode,
});

const BUS_280 = line('RUT:Line:280', '280', 'bus');
const RAIL_RE10 = line('VYG:Line:RE10', 'RE10', 'rail');
const RAIL_L1 = line('VYG:Line:L1', 'L1', 'rail');
const METRO_5 = line('RUT:Line:5', '5', 'metro');

function leg(mode: TransitLeg['mode'], lineId?: string, publicCode = '?'): TransitLeg {
  return {
    mode,
    distanceM: 1_000,
    durationMs: 300_000,
    aimedStartMs: 1,
    expectedStartMs: 1,
    aimedEndMs: 2,
    expectedEndMs: 2,
    realtime: true,
    from: place('Asker stasjon'),
    to: place('Nationaltheatret'),
    ...(lineId ? { line: { id: lineId, publicCode } } : {}),
    intermediateStops: [],
    points: [],
    situations: [],
  };
}

const trip = (...legs: TransitLeg[]): TransitTrip => ({
  startMs: 1,
  endMs: 2,
  durationMs: 1,
  walkDistanceM: 0,
  legs,
});

const filter = (over: Partial<TransitCommuteFilter> = {}): TransitCommuteFilter => ({
  select: [],
  exclude: [],
  modes: [],
  ...over,
});

const commute = (over: Partial<TransitCommuteQuery> = {}): TransitCommuteQuery => ({
  from: { name: 'Engelsrud', lat: 59.82, lng: 10.37, stopId: 'NSR:StopPlace:3369' },
  via: [],
  to: { name: 'Nationaltheatret', lat: 59.91, lng: 10.73, stopId: 'NSR:StopPlace:58404' },
  filter: filter(),
  outboundTime: { minutesOfDay: null, arriveBy: false },
  inboundTime: { minutesOfDay: null, arriveBy: false },
  days: [],
  ...over,
});

// A Thursday in July (summer time, so Norway is UTC+2).
const THURSDAY_0630 = norwayInstant(2026, 6, 30, 6 * 60 + 30);

describe('commute line filter', () => {
  it('disappears entirely when no line is chosen, rather than becoming an empty list', () => {
    // `filters: []` is not "no filter" upstream — it is "match nothing", and it
    // answers noTransitConnection on a corridor with five journeys.
    expect(commuteLineFilter(filter())).toBeUndefined();
  });

  it('carries ids, not the codes a user reads', () => {
    expect(commuteLineFilter(filter({ select: [BUS_280], exclude: [RAIL_L1] }))).toEqual({
      select: ['RUT:Line:280'],
      exclude: ['VYG:Line:L1'],
    });
  });
});

describe('saved commute safety net', () => {
  it('allows walking and every mode when nothing is restricted', () => {
    expect(
      commuteTripMatches(
        trip(leg('foot'), leg('bus', BUS_280.id, '280'), leg('metro', METRO_5.id, '5')),
        filter(),
      ),
    ).toBe(true);
  });

  it('no longer secretly forbids the metro leg that finishes an Oslo journey', () => {
    const journey = trip(leg('bus', BUS_280.id, '280'), leg('metro', METRO_5.id, '5'));
    expect(commuteTripMatches(journey, filter({ select: [BUS_280, METRO_5] }))).toBe(true);
  });

  it('rejects a line the commute excluded, and one outside a non-empty selection', () => {
    expect(
      commuteTripMatches(trip(leg('rail', RAIL_L1.id, 'L1')), filter({ exclude: [RAIL_L1] })),
    ).toBe(false);
    expect(
      commuteTripMatches(trip(leg('rail', RAIL_L1.id, 'L1')), filter({ select: [RAIL_RE10] })),
    ).toBe(false);
  });

  it('lets a ride leg with no line id through rather than hiding a real departure', () => {
    expect(commuteTripMatches(trip(leg('water')), filter({ select: [BUS_280] }))).toBe(true);
  });

  it('honours a mode selection, expanding Bus to include a coach', () => {
    expect(
      commuteTripMatches(trip(leg('coach', BUS_280.id, '280')), filter({ modes: ['bus'] })),
    ).toBe(true);
    expect(
      commuteTripMatches(trip(leg('metro', METRO_5.id, '5')), filter({ modes: ['bus'] })),
    ).toBe(false);
  });

  it('preserves result metadata while removing non-matching options', () => {
    const accepted = trip(leg('bus', BUS_280.id, '280'));
    const rejected = trip(leg('rail', RAIL_L1.id, 'L1'));
    expect(
      filterCommuteResult(
        { trips: [rejected, accepted], problems: [], nextCursor: 'later' },
        filter({ select: [BUS_280] }),
      ),
    ).toEqual({ trips: [accepted], problems: [], nextCursor: 'later' });
  });
});

describe('commute queries', () => {
  it('reverses both ends and the ordered interchanges for the return query', () => {
    const asker = { name: 'Asker stasjon', lat: 59.83, lng: 10.43 };
    const query = commute({ via: [asker] });
    const queries = commuteTransitQueries(query, THURSDAY_0630);
    expect(queries.outbound).toMatchObject({ from: query.from, via: [asker], to: query.to });
    expect(queries.inbound).toMatchObject({ from: query.to, via: [asker], to: query.from });
  });

  it('asks the planner for the chosen lines instead of filtering the answer', () => {
    const queries = commuteTransitQueries(
      commute({ filter: filter({ select: [BUS_280, RAIL_RE10], exclude: [RAIL_L1] }) }),
      THURSDAY_0630,
    );
    expect(queries.outbound.lineFilter).toEqual({
      select: ['RUT:Line:280', 'VYG:Line:RE10'],
      exclude: ['VYG:Line:L1'],
    });
    expect(queries.inbound.lineFilter).toEqual(queries.outbound.lineFilter);
  });

  it('sends no modes at all by default, so no ride mode is secretly disqualified', () => {
    const queries = commuteTransitQueries(commute(), THURSDAY_0630);
    expect(queries.outbound.modes).toBeUndefined();
    expect(queries.outbound.dateTimeMs).toBeUndefined();
  });

  it('asks about tomorrow morning when the evening board is opened', () => {
    // 22:30 Thursday, outbound saved as 07:10 — the answer must be Friday's
    // 07:10, not a search window widened until something falls out.
    const evening = norwayInstant(2026, 6, 30, 22 * 60 + 30);
    const queries = commuteTransitQueries(
      commute({ outboundTime: { minutesOfDay: 7 * 60 + 10, arriveBy: false } }),
      evening,
    );
    expect(queries.outbound.dateTimeMs).toBe(norwayInstant(2026, 6, 31, 7 * 60 + 10));
    expect(queries.outbound.arriveBy).toBeUndefined();
  });

  it('skips a day the commute does not run', () => {
    // Saturday 2026-08-01: a weekday-only commute next runs on Monday the 3rd.
    const saturday = norwayInstant(2026, 7, 1, 9 * 60);
    const queries = commuteTransitQueries(
      commute({
        days: [1, 2, 3, 4, 5],
        outboundTime: { minutesOfDay: 7 * 60 + 10, arriveBy: false },
      }),
      saturday,
    );
    expect(queries.outbound.dateTimeMs).toBe(norwayInstant(2026, 7, 3, 7 * 60 + 10));
  });

  it('passes an arrive-by time through as one', () => {
    const queries = commuteTransitQueries(
      commute({ outboundTime: { minutesOfDay: 8 * 60 + 30, arriveBy: true } }),
      THURSDAY_0630,
    );
    expect(queries.outbound.arriveBy).toBe(true);
    expect(queries.outbound.dateTimeMs).toBe(norwayInstant(2026, 6, 30, 8 * 60 + 30));
  });
});

describe('empty answers', () => {
  const empty = (codes: ('noTransitConnection' | 'noTransitConnectionInSearchWindow')[]) => ({
    trips: [],
    problems: codes.map((code) => ({ code })),
  });

  it('blames the line selection when a restricted corridor reports no connection', () => {
    expect(commuteEmptyReason(empty(['noTransitConnection']), filter({ select: [BUS_280] }))).toBe(
      'filtered',
    );
  });

  it('blames the timetable when nothing is restricted', () => {
    expect(commuteEmptyReason(empty(['noTransitConnection']), filter())).toBe('upstream');
  });

  it('blames the timetable for an empty search window even with lines chosen', () => {
    expect(
      commuteEmptyReason(
        empty(['noTransitConnectionInSearchWindow']),
        filter({ select: [BUS_280] }),
      ),
    ).toBe('upstream');
  });

  it('blames the selection when the safety net threw away every upstream journey', () => {
    expect(commuteEmptyReason({ trips: [], problems: [] }, filter(), 3)).toBe('filtered');
  });
});

describe('default direction', () => {
  const times = commute({
    outboundTime: { minutesOfDay: 7 * 60 + 10, arriveBy: false },
    inboundTime: { minutesOfDay: 16 * 60, arriveBy: false },
  });

  it('shows the way out before the outbound time', () => {
    expect(defaultCommuteDirection(times, norwayInstant(2026, 6, 30, 6 * 60))).toBe('outbound');
  });

  it('shows the way home after it', () => {
    expect(defaultCommuteDirection(times, norwayInstant(2026, 6, 30, 9 * 60))).toBe('inbound');
  });

  it('is back to the way out once the evening return has gone', () => {
    expect(defaultCommuteDirection(times, norwayInstant(2026, 6, 30, 22 * 60))).toBe('outbound');
  });

  it('stays outbound when no time is saved', () => {
    expect(defaultCommuteDirection(commute(), THURSDAY_0630)).toBe('outbound');
  });
});

describe('commuteSegmentQueries', () => {
  const withVia = commute({
    via: [{ name: 'Asker stasjon', lat: 59.83, lng: 10.43, stopId: 'NSR:StopPlace:59616' }],
    filter: filter({ select: [BUS_280], modes: ['bus'] }),
  });

  it('asks one question per directed hop, carrying the commute rules', () => {
    const queries = commuteSegmentQueries(withVia, 5);
    expect(queries.map((entry) => entry.id)).toEqual([
      'outbound-0',
      'outbound-1',
      'inbound-0',
      'inbound-1',
    ]);
    expect(queries[0]!.query).toMatchObject({
      from: { stopId: 'NSR:StopPlace:3369' },
      to: { stopId: 'NSR:StopPlace:59616' },
      limit: 5,
      modes: ['bus'],
      lineFilter: { select: ['RUT:Line:280'] },
    });
  });

  it('never pins a hop to the commute time — these boards answer "what leaves next"', () => {
    const timed = commuteSegmentQueries(
      commute({
        via: [{ name: 'Asker stasjon', lat: 59.83, lng: 10.43 }],
        outboundTime: { minutesOfDay: 7 * 60 + 10, arriveBy: false },
      }),
      5,
    );
    expect(timed.every((entry) => entry.query.dateTimeMs === undefined)).toBe(true);
  });

  it('asks nothing at all without an interchange', () => {
    expect(commuteSegmentQueries(commute(), 5)).toEqual([]);
  });
});
