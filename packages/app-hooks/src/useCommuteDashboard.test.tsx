import {
  norwayInstant,
  type TransitCommuteQuery,
  type TransitCommuteResult,
  type TransitLeg,
  type TransitTrip,
} from '@atlas/transit';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useCommuteDashboard, type CommuteDashboard } from './useCommuteDashboard.js';
import { committedTrip, type CommuteController } from './useCommute.js';

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
  const base = {
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
    commit: null,
    setCommit: () => {},
    ...over,
  } as CommuteController;
  // What `useCommute` hands the board: the trip the commitment names in the
  // answer, unless a test supplies the kept copy itself.
  const trip = base.commit ? committedTrip(base.result, base.query, base.commit) : null;
  return {
    ...base,
    tracked:
      over.tracked !== undefined
        ? over.tracked
        : trip
          ? { trip, updatedMs: base.updatedMs ?? NOW }
          : null,
  };
}

/** A journey with a change, which is what TRANSIT.md §7's block is about. */
const twoLeg = (departMs: number) =>
  trip(ride('270', 'Engelsrud Terrasse', 'Asker stasjon', departMs, departMs + 26 * 60_000), {
    ...ride(
      'L1',
      'Asker stasjon',
      'Nationaltheatret',
      departMs + 35 * 60_000,
      departMs + 48 * 60_000,
    ),
    mode: 'rail',
  });

const trackedResult: TransitCommuteResult = {
  ...result,
  outbound: { trips: [twoLeg(hm(8, 36)), twoLeg(hm(8, 48))], problems: [] },
};

const commitFor = (departMs: number) => ({
  direction: 'outbound' as const,
  departureMs: departMs,
  line: '270',
});

/** The journey list a door mode shows, which is what most of these assert against. */
const only = (hook: { current: CommuteDashboard }) => hook.current.section!;

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
    // A door mode is journeys and nothing else: the departure boards belong to
    // the mode that is about a stop.
    expect(hook.current.boards).toEqual([]);
    expect(only(hook).journeys.map((journey) => journey.scan)).toEqual([
      '08:36 → 09:02 · 26 min',
      '08:48 → 09:14 · 26 min',
    ]);
    expect(only(hook).leaveNow.next?.departure.aimed).toBe('08:36');
    expect(only(hook).leadLabel).toBe('If I leave now');
    // The list beneath the headline starts *after* it. Showing the 08:36 as its
    // own first row put the same departure on one screen twice, in the slot
    // where "and if I miss it?" belongs.
    expect(only(hook).laterJourneys.map((journey) => journey.departure.aimed)).toEqual(['08:48']);
    unmount();
  });

  it('keeps the countdowns alive', () => {
    const { result: hook, unmount } = renderHook(() => useCommuteDashboard(controller()));
    act(() => hook.current.setMode('interchange'));
    expect(hook.current.boards[0]?.rows[0]?.countdown).toBe('in 39 min');
    act(() => {
      vi.advanceTimersByTime(10 * 60_000);
    });
    expect(hook.current.nowLabel).toBe('Tuesday 25 August · 08:42');
    expect(hook.current.boards[0]?.rows[0]?.countdown).toBe('in 29 min');
    unmount();
  });

  it('draws only the hops that leave the change, and only there', () => {
    const { result: hook, unmount } = renderHook(() => useCommuteDashboard(controller()));
    // A door mode answers with journeys; the boards are the middle mode's.
    expect(hook.current.boards).toEqual([]);
    act(() => hook.current.setMode('inbound'));
    expect(hook.current.boards).toEqual([]);
    act(() => hook.current.setMode('interchange'));
    // The train in and the bus home. Never `outbound-0` or `inbound-0` — those
    // leave the doors, and a board of departures from your own front door has
    // no business under a mode about the station.
    expect(hook.current.boards.map((board) => board.segment.id)).toEqual([
      'outbound-1',
      'inbound-1',
    ]);
    expect(hook.current.boards.map((board) => board.segment.from.name)).toEqual([
      'Asker stasjon',
      'Asker stasjon',
    ]);
    unmount();
  });

  it('tells an unchecked hop apart from one where nothing runs', () => {
    const { result: hook, unmount } = renderHook(() =>
      useCommuteDashboard(
        controller({
          result: {
            ...result,
            // Answered, and genuinely empty.
            segments: [{ id: 'outbound-1', result: { trips: [], problems: [] } }],
          },
        }),
      ),
    );
    act(() => hook.current.setMode('interchange'));
    const note = (id: string) => hook.current.boards.find((board) => board.segment.id === id)?.note;
    expect(note('outbound-1')).toBe('Nothing runs in this window');
    // `inbound-1` never came back at all — the backend dropped a failed hop.
    // Calling that "nothing runs" would report a healthy corridor as dead.
    expect(note('inbound-1')).toBe('Could not be checked just now.');
    unmount();
  });

  it('offers no boards for a commute with no interchange', () => {
    const { result: hook, unmount } = renderHook(() =>
      useCommuteDashboard(controller({ query: { ...query, via: [] } })),
    );
    expect(hook.current.boards).toEqual([]);
    unmount();
  });

  it('says a backend that answers no hops could not be checked', () => {
    // An older server omits `segments` entirely — which is not the same as a
    // corridor where nothing runs, and must not read like one.
    const { result: hook, unmount } = renderHook(() =>
      useCommuteDashboard(
        controller({ result: { outbound: result.outbound, inbound: result.inbound } }),
      ),
    );
    act(() => hook.current.setMode('interchange'));
    expect(hook.current.boards.map((board) => board.note)).toEqual([
      'Could not be checked just now.',
      'Could not be checked just now.',
    ]);
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
    expect(only(hook).emptyFromFilter).toBe(true);
    expect(only(hook).emptyNote).toContain('chosen lines');
    unmount();
  });

  /**
   * TRANSIT.md §13 — the day that does not start at either door. The departures come
   * from the hops the dashboard already asked for, so the middle mode costs no
   * upstream call.
   */
  it('reads both directions from the interchange, as two boards', () => {
    const { result: hook, unmount } = renderHook(() => useCommuteDashboard(controller()));
    expect(hook.current.modes).toEqual(['outbound', 'interchange', 'inbound']);
    act(() => hook.current.setMode('interchange'));
    // The stop you are standing at is the header; each board names where its
    // vehicles are going, which is what the platform signs at Asker do.
    expect(hook.current.routeLabel).toBe('From Asker stasjon');
    expect(hook.current.boards.map((board) => board.segment.label)).toEqual([
      'Asker stasjon → Nationaltheatret',
      'Asker stasjon → Engelsrud Terrasse',
    ]);
    // Departures, not journeys: standing on the platform the question is what
    // leaves and when, and there is no journey list to answer instead.
    expect(hook.current.section).toBeNull();
    const [inwards, home] = hook.current.boards;
    expect(inwards?.rows.map((row) => [row.aimed, row.line])).toEqual([['09:11', 'L1']]);
    // Nothing answered `inbound-1`, and a hop with no answer is not a hop with
    // no departures — the board says so rather than claiming the bus home is
    // gone for the day.
    expect(home?.rows).toEqual([]);
    expect(home?.note).toBe('Could not be checked just now.');
    unmount();
  });

  it('orders the interchange by the clock, as the board’s own direction is', () => {
    const { result: hook, unmount } = renderHook(() =>
      // Past the outbound departure and before the return: what a board opened
      // at 16:30 is opened for is the way home.
      useCommuteDashboard(
        controller({
          query: {
            ...query,
            outboundTime: { minutesOfDay: 8 * 60, arriveBy: false },
            inboundTime: { minutesOfDay: 16 * 60, arriveBy: false },
          },
        }),
      ),
    );
    act(() => hook.current.setMode('interchange'));
    expect(hook.current.boards.map((board) => board.segment.direction)).toEqual([
      'inbound',
      'outbound',
    ]);
    unmount();
  });

  it('offers no interchange mode without one to be at', () => {
    const { result: hook, unmount } = renderHook(() =>
      useCommuteDashboard(controller({ query: { ...query, via: [] } })),
    );
    expect(hook.current.modes).toEqual(['outbound', 'inbound']);
    // …and a mode pinned before the interchange was dropped is not a mode: the
    // board falls back to the clock rather than reading a middle ground that
    // has ceased to exist.
    act(() => hook.current.setMode('interchange'));
    expect(hook.current.mode).toBe('outbound');
    expect(hook.current.section).not.toBeNull();
    unmount();
  });

  /**
   * A board row is not committed to, so nothing new is tracked from the change
   * — but a commitment made there by a bundle old enough to have offered it
   * (§13 before v0.191.0) still names a journey that is still running, and the
   * card must re-read it from the hop it was made from rather than release it
   * mid-ride.
   */
  it('reads a commitment made at the interchange back out of its own hop', () => {
    const { result: hook, unmount } = renderHook(() =>
      useCommuteDashboard(
        controller({
          commit: {
            direction: 'outbound',
            departureMs: hm(9, 11),
            line: 'L1',
            origin: 'interchange',
          },
        }),
      ),
    );
    expect(hook.current.here?.ride.line).toBe('L1');
    expect(hook.current.hereJourney?.scan).toBe('09:11 → 09:24 · 13 min');
    unmount();
  });

  it('expands one journey at a time, by a key its own list owns', () => {
    const { result: hook, unmount } = renderHook(() => useCommuteDashboard(controller()));
    const [first, second] = [only(hook).leadRow!, only(hook).rows[0]!];
    // Qualified by the list it belongs to: an expansion outlives a mode switch,
    // and a journey key is only unique within the answer it came from.
    expect(first.key).toBe(`outbound:${first.journey.key}`);
    act(() => hook.current.toggle(first.key));
    expect(hook.current.expanded).toBe(first.key);
    act(() => hook.current.toggle(second.key));
    expect(hook.current.expanded).toBe(second.key);
    act(() => hook.current.toggle(second.key));
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

/**
 * TRANSIT.md §7 — the board's own commitment.
 *
 * Nothing here infers that anyone boarded: the block exists only for a journey
 * the user explicitly tracked, which is the rule TRANSIT.md §W3 wrote for the widget
 * and this surface inherits.
 */
describe('tracking a journey', () => {
  it('says nothing until a journey is tracked', () => {
    const { result: hook, unmount } = renderHook(() =>
      useCommuteDashboard(controller({ result: trackedResult })),
    );
    expect(hook.current.here).toBeNull();
    expect(only(hook).rows.every((row) => !row.tracked)).toBe(true);
    unmount();
  });

  it('commits to the departure and the first vehicle, not to a row number', () => {
    const commits: unknown[] = [];
    const { result: hook, unmount } = renderHook(() =>
      useCommuteDashboard(
        controller({ result: trackedResult, setCommit: (next) => commits.push(next) }),
      ),
    );
    act(() => only(hook).track(only(hook).leaveNow.next!));
    expect(commits[0]).toMatchObject({
      direction: 'outbound',
      departureMs: hm(8, 36),
      line: '270',
    });
    unmount();
  });

  it('places the traveller in the journey it is tracking', () => {
    const { result: hook, unmount } = renderHook(() =>
      useCommuteDashboard(controller({ result: trackedResult, commit: commitFor(hm(8, 36)) })),
    );
    // Four minutes before it leaves: close enough that the next thing to do is
    // stand at the stop, which is a "you are here" and not a "tracking".
    expect(hook.current.here?.phase).toBe('boarding');
    expect(hook.current.here?.heading).toBe('You are here');
    expect(hook.current.here?.ride.line).toBe('270');
    expect(only(hook).leadRow?.tracked).toBe(true);
    unmount();
  });

  it('prefers the backend’s own re-read of the tracked journey', () => {
    // A board asked "from now" cannot hold a journey that has already left, so
    // once it has, this is the only source that still has it.
    const departed = twoLeg(hm(8, 10));
    const { result: hook, unmount } = renderHook(() =>
      useCommuteDashboard(
        controller({
          result: { ...trackedResult, committed: { trip: departed, replaced: null } },
          commit: commitFor(hm(8, 10)),
        }),
      ),
    );
    expect(hook.current.here?.phase).toBe('riding');
    expect(hook.current.here?.heading).toBe('You are here');
    unmount();
  });

  it('hands out the tracked journey whole, so its legs can be read', () => {
    // The gap this closed: tracking used to show *less* than not tracking —
    // the ribbon and the next connection, but never a platform or a per-leg
    // time, because the journey it is about falls out of a board asked "from
    // now" the moment it departs.
    const departed = twoLeg(hm(8, 10));
    const { result: hook, unmount } = renderHook(() =>
      useCommuteDashboard(
        controller({
          result: { ...trackedResult, committed: { trip: departed, replaced: null } },
          commit: commitFor(hm(8, 10)),
        }),
      ),
    );
    expect(hook.current.hereJourney?.rides).toHaveLength(2);
    expect(hook.current.hereJourney?.rides[0]?.fromQuay).toBeDefined();
    // The same journey the card is placed in, not merely a journey.
    expect(hook.current.hereJourney?.rides[hook.current.here!.rideIndex]?.line).toBe(
      hook.current.here?.ride.line,
    );
    unmount();
  });

  it('offers no journey to draw legs from when nothing is tracked', () => {
    const { result: hook, unmount } = renderHook(() =>
      useCommuteDashboard(controller({ result: trackedResult })),
    );
    expect(hook.current.hereJourney).toBeNull();
    unmount();
  });

  it('offers the next departure of the hop the change lands on', () => {
    const { result: hook, unmount } = renderHook(() =>
      useCommuteDashboard(controller({ result: trackedResult, commit: commitFor(hm(8, 36)) })),
    );
    // The booked 09:11, then the hop board's own next train.
    expect(hook.current.here?.connections[0]).toMatchObject({ booked: true, aimed: '09:11' });
    unmount();
  });

  it('lets a commitment go once the journey it names has finished', () => {
    const cleared: unknown[] = [];
    const { result: hook, unmount } = renderHook(() =>
      useCommuteDashboard(
        controller({
          result: trackedResult,
          commit: commitFor(hm(8, 36)),
          setCommit: (next) => cleared.push(next),
        }),
      ),
    );
    expect(hook.current.here).not.toBeNull();
    // Past the scheduled arrival plus the widget's own slack. Nobody stops
    // tracking a bus they got off.
    act(() => {
      vi.advanceTimersByTime(90 * 60_000);
    });
    expect(cleared).toContain(null);
    unmount();
  });

  it('computes the break for every listed journey, tracked or not', () => {
    const late = twoLeg(hm(8, 48));
    // The bus now gets in after the train it was booked onto has gone.
    late.legs[0] = { ...late.legs[0]!, expectedEndMs: hm(9, 24), realtime: true };
    const { result: hook, unmount } = renderHook(() =>
      useCommuteDashboard(
        controller({
          result: {
            ...trackedResult,
            outbound: { trips: [twoLeg(hm(8, 36)), late], problems: [] },
          },
        }),
      ),
    );
    // Arithmetic on the timetable, not a claim about the traveller — so it is
    // stated with nothing committed at all.
    expect(only(hook).rows[0]?.broken?.index).toBe(1);
    expect(only(hook).leadRow?.broken).toBeNull();
    unmount();
  });
});
