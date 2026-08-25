import {
  norwayInstant,
  type TransitCommuteQuery,
  type TransitCommuteResult,
  type TransitLeg,
  type TransitTrip,
} from '@atlas/transit';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useCommuteDashboard } from './useCommuteDashboard.js';
import type { CommuteController } from './useCommute.js';

/** Tuesday 25 August 2026, 08:32 Norwegian summer time. */
const NOW = norwayInstant(2026, 7, 25, 8 * 60 + 32);
const hm = (h: number, m: number) => norwayInstant(2026, 7, 25, h * 60 + m);

const place = (name: string) => ({ name, position: { lat: 59.9, lng: 10.6 } });

const ride = (line: string, from: string, to: string, start: number, end: number): TransitLeg => ({
  mode: 'bus',
  distanceM: 5_000,
  durationMs: end - start,
  aimedStartMs: start,
  expectedStartMs: start,
  aimedEndMs: end,
  expectedEndMs: end,
  realtime: false,
  from: place(from),
  to: place(to),
  line: { id: `X:Line:${line}`, publicCode: line },
  intermediateStops: [],
  points: [],
  situations: [],
});

const trip = (...legs: TransitLeg[]): TransitTrip => ({
  startMs: legs[0]!.expectedStartMs,
  endMs: legs[legs.length - 1]!.expectedEndMs,
  durationMs: legs[legs.length - 1]!.expectedEndMs - legs[0]!.expectedStartMs,
  walkDistanceM: 0,
  legs,
});

const query: TransitCommuteQuery = {
  from: { name: 'Engelsrud Terrasse', lat: 59.82, lng: 10.42 },
  via: [{ name: 'Asker stasjon', lat: 59.83, lng: 10.43 }],
  to: { name: 'Nationaltheatret', lat: 59.91, lng: 10.73 },
  filter: { select: [], exclude: [], modes: [] },
  outboundTime: { minutesOfDay: null, arriveBy: false },
  inboundTime: { minutesOfDay: null, arriveBy: false },
  days: [],
};

const result: TransitCommuteResult = {
  outbound: {
    trips: [
      trip(ride('270', 'Engelsrud Terrasse', 'Asker stasjon', hm(8, 36), hm(9, 2))),
      trip(ride('270', 'Engelsrud Terrasse', 'Asker stasjon', hm(8, 48), hm(9, 14))),
    ],
    problems: [],
  },
  inbound: { trips: [], problems: [] },
  segments: [
    {
      id: 'outbound-1',
      result: {
        trips: [trip(ride('L1', 'Asker stasjon', 'Nationaltheatret', hm(9, 11), hm(9, 24)))],
        problems: [],
      },
    },
  ],
};

function controller(over: Partial<CommuteController> = {}): CommuteController {
  return {
    ready: true,
    config: {
      from: null,
      via: null,
      to: null,
      select: [],
      exclude: [],
      modes: [],
      outboundTime: { minutesOfDay: null, arriveBy: false },
      inboundTime: { minutesOfDay: null, arriveBy: false },
      days: [],
    },
    setConfig: () => {},
    query,
    result,
    loading: false,
    error: null,
    updatedMs: NOW,
    refresh: () => {},
    emptyReason: () => 'none',
    ...over,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useCommuteDashboard', () => {
  it('leads with the journeys and what leaving now gets you', () => {
    const { result: hook, unmount } = renderHook(() => useCommuteDashboard(controller()));
    expect(hook.current.routeLabel).toBe('Engelsrud Terrasse → Nationaltheatret');
    expect(hook.current.nowLabel).toBe('Tuesday 25 August · 08:32');
    expect(hook.current.journeys.map((journey) => journey.scan)).toEqual([
      '08:36 → 09:02 · 26 min',
      '08:48 → 09:14 · 26 min',
    ]);
    expect(hook.current.leaveNow.next?.departure.aimed).toBe('08:36');
    expect(hook.current.leaveNow.following?.departure.aimed).toBe('08:48');
    unmount();
  });

  it('keeps the countdowns alive', () => {
    const { result: hook, unmount } = renderHook(() => useCommuteDashboard(controller()));
    expect(hook.current.boards[1]?.rows[0]?.countdown).toBe('in 39 min');
    act(() => {
      vi.advanceTimersByTime(10 * 60_000);
    });
    expect(hook.current.nowLabel).toBe('Tuesday 25 August · 08:42');
    expect(hook.current.boards[1]?.rows[0]?.countdown).toBe('in 29 min');
    unmount();
  });

  it('orders the per-leg boards with the direction being travelled first', () => {
    const { result: hook, unmount } = renderHook(() => useCommuteDashboard(controller()));
    expect(hook.current.boards.map((board) => board.segment.id)).toEqual([
      'outbound-0',
      'outbound-1',
      'inbound-0',
      'inbound-1',
    ]);
    act(() => hook.current.setDirection('inbound'));
    expect(hook.current.boards.map((board) => board.segment.id)).toEqual([
      'inbound-0',
      'inbound-1',
      'outbound-0',
      'outbound-1',
    ]);
    unmount();
  });

  it('tells an unchecked hop apart from one where nothing runs', () => {
    const { result: hook, unmount } = renderHook(() =>
      useCommuteDashboard(
        controller({
          result: {
            ...result,
            segments: [
              ...result.segments!,
              // Answered, and genuinely empty.
              { id: 'outbound-0', result: { trips: [], problems: [] } },
            ],
          },
        }),
      ),
    );
    const note = (id: string) => hook.current.boards.find((board) => board.segment.id === id)?.note;
    expect(note('outbound-0')).toBe('Nothing runs in this window');
    // `inbound-0` never came back at all — the backend dropped a failed hop.
    // Calling that "nothing runs" would report a healthy corridor as dead.
    expect(note('inbound-0')).toBe('Could not be checked just now.');
    unmount();
  });

  it('offers no per-leg boards for a commute with no interchange', () => {
    const { result: hook, unmount } = renderHook(() =>
      useCommuteDashboard(controller({ query: { ...query, via: [] } })),
    );
    expect(hook.current.hasBoards).toBe(false);
    expect(hook.current.boards).toEqual([]);
    unmount();
  });

  it('offers none against a backend that does not answer them', () => {
    // An older server omits `segments` entirely. A Departures tab over four
    // boards it cannot fill is worse than no tab.
    const { result: hook, unmount } = renderHook(() =>
      useCommuteDashboard(
        controller({ result: { outbound: result.outbound, inbound: result.inbound } }),
      ),
    );
    expect(hook.current.hasBoards).toBe(false);
    unmount();
  });

  it('blames the line filter for its own empty answer, not the timetable', () => {
    const { result: hook, unmount } = renderHook(() =>
      useCommuteDashboard(
        controller({
          result: { outbound: { trips: [], problems: [] }, inbound: { trips: [], problems: [] } },
          emptyReason: () => 'filtered',
        }),
      ),
    );
    expect(hook.current.emptyFromFilter).toBe(true);
    expect(hook.current.emptyNote).toContain('chosen lines');
    unmount();
  });

  it('expands one journey at a time', () => {
    const { result: hook, unmount } = renderHook(() => useCommuteDashboard(controller()));
    const [first, second] = hook.current.journeys;
    act(() => hook.current.toggle(first!.key));
    expect(hook.current.expanded).toBe(first!.key);
    act(() => hook.current.toggle(second!.key));
    expect(hook.current.expanded).toBe(second!.key);
    act(() => hook.current.toggle(second!.key));
    expect(hook.current.expanded).toBeNull();
    unmount();
  });

  it('explains a weekday the commute is not saved for', () => {
    const { result: hook, unmount } = renderHook(() =>
      // Tuesday is ISO 2; a Wed–Fri commute does not run today.
      useCommuteDashboard(controller({ query: { ...query, days: [3, 4, 5] } })),
    );
    expect(hook.current.offDayNote).toContain('not saved for today');
    unmount();
  });
});
