import { act, renderHook } from '@testing-library/react';
import { norwayInstant, type TransitProblem, type TransitTrip } from '@atlas/transit';
import { describe, expect, it, vi } from 'vitest';

import { useTransitBoard } from './useTransitBoard.js';
import type { TransitPlan } from './useTransit.js';

// The Norwegian clock, because that is the clock a transit label prints —
// see the note at the top of @atlas/transit's labels.ts.
const at = (h: number, m: number) => norwayInstant(2026, 6, 21, h * 60 + m);

function tripAt(h: number, m: number): TransitTrip {
  return {
    startMs: at(h, m),
    endMs: at(h, m) + 30 * 60_000,
    durationMs: 30 * 60_000,
    walkDistanceM: 300,
    legs: [],
  };
}

/** A plan with everything stubbed; each test overrides only what it is about. */
function plan(over: Partial<TransitPlan> = {}): TransitPlan {
  return {
    covered: true,
    trips: null,
    loading: false,
    error: null,
    problems: [],
    updatedMs: null,
    timeMs: null,
    setTimeMs: vi.fn(),
    arriveBy: false,
    setArriveBy: vi.fn(),
    modes: [],
    toggleMode: vi.fn(),
    clearModes: vi.fn(),
    refresh: vi.fn(),
    pageEarlier: null,
    pageLater: null,
    offered: true,
    enabled: true,
    setEnabled: vi.fn(),
    selected: null,
    select: vi.fn(),
    trip: null,
    ...over,
  };
}

const board = (over: Partial<TransitPlan> = {}) => {
  const p = plan(over);
  return { p, ...renderHook(() => useTransitBoard(p)) };
};

describe('timing', () => {
  it('reads "now" as the absence of a chosen time', () => {
    expect(board().result.current.timing).toBe('now');
    expect(board({ timeMs: at(8, 0) }).result.current.timing).toBe('depart');
    expect(board({ timeMs: at(8, 0), arriveBy: true }).result.current.timing).toBe('arrive');
  });

  it('drops the chosen time entirely when going back to "now"', () => {
    // "Leave now" must mean whatever now is when the answer arrives, not a
    // timestamp frozen when the chip was tapped.
    const { p, result } = board({ timeMs: at(8, 0), arriveBy: true });
    act(() => result.current.chooseTiming('now'));
    expect(p.setTimeMs).toHaveBeenCalledWith(null);
    expect(p.setArriveBy).toHaveBeenCalledWith(false);
  });

  it('seeds a concrete time when leaving "now" for depart/arrive', () => {
    const { p, result } = board();
    act(() => result.current.chooseTiming('arrive'));
    expect(p.setArriveBy).toHaveBeenCalledWith(true);
    expect(vi.mocked(p.setTimeMs).mock.calls[0]![0]).toBeGreaterThan(0);
  });

  it('keeps the time already chosen when only the direction changes', () => {
    const { p, result } = board({ timeMs: at(8, 0) });
    act(() => result.current.chooseTiming('arrive'));
    expect(p.setArriveBy).toHaveBeenCalledWith(true);
    expect(p.setTimeMs).not.toHaveBeenCalled();
  });

  it('steps from the chosen time, or from now when there is none', () => {
    const chosen = board({ timeMs: at(8, 0) });
    act(() => chosen.result.current.stepTime(30 * 60_000));
    expect(chosen.p.setTimeMs).toHaveBeenCalledWith(at(8, 30));

    const unset = board();
    act(() => unset.result.current.stepTime(-30 * 60_000));
    const stepped = vi.mocked(unset.p.setTimeMs).mock.calls[0]![0]!;
    expect(Date.now() - stepped).toBeGreaterThanOrEqual(30 * 60_000);
  });
});

describe('mode filter', () => {
  it('treats an empty selection as "all modes", which is not a filter', () => {
    const { result } = board();
    expect(result.current.filtered).toBe(false);
    expect(result.current.accepts('bus')).toBe(true);
    expect(result.current.accepts('water')).toBe(true);
  });

  it('accepts only the picked modes once anything is picked', () => {
    const { result } = board({ modes: ['rail'] });
    expect(result.current.filtered).toBe(true);
    expect(result.current.accepts('rail')).toBe(true);
    expect(result.current.accepts('bus')).toBe(false);
  });
});

describe('paging', () => {
  it('prefers the planner’s own cursors', () => {
    const pageEarlier = vi.fn();
    const pageLater = vi.fn();
    const { p, result } = board({ trips: [tripAt(8, 0)], pageEarlier, pageLater });
    act(() => result.current.showEarlier!());
    act(() => result.current.showLater!());
    expect(pageEarlier).toHaveBeenCalled();
    expect(pageLater).toHaveBeenCalled();
    expect(p.setTimeMs).not.toHaveBeenCalled();
  });

  it('falls back to time arithmetic at the ends of the timetable', () => {
    const { p, result } = board({ trips: [tripAt(8, 0), tripAt(8, 20)] });
    act(() => result.current.showEarlier!());
    expect(p.setArriveBy).toHaveBeenCalledWith(true);
    expect(p.setTimeMs).toHaveBeenCalledWith(at(8, 0) - 60_000);

    act(() => result.current.showLater!());
    // With more than one trip shown, "later" walks from the *first* departure:
    // stepping past the last one would skip everything between them.
    expect(p.setTimeMs).toHaveBeenLastCalledWith(at(8, 0) + 60_000);
  });

  it('steps past the only departure shown when there is just one', () => {
    const { p, result } = board({ trips: [tripAt(8, 0)] });
    act(() => result.current.showLater!());
    expect(p.setTimeMs).toHaveBeenCalledWith(at(8, 0) + 60_000);
  });

  it('offers no paging without an answer to page from', () => {
    expect(board().result.current.showEarlier).toBeNull();
    expect(board({ trips: [] }).result.current.showLater).toBeNull();
  });
});

describe('the empty answer', () => {
  it('says nothing at all while there is no answer yet', () => {
    expect(board().result.current.emptyMessage).toBeNull();
    expect(board({ trips: [], loading: true }).result.current.emptyMessage).toBeNull();
    expect(board({ trips: [], error: 'offline' }).result.current.emptyMessage).toBeNull();
    expect(board({ trips: [tripAt(8, 0)] }).result.current.emptyMessage).toBeNull();
  });

  it("blames the traveller's own filter when that is what emptied the board", () => {
    // Reporting this as "nothing runs" would send them hunting for a departure
    // that exists — so the filter is named, and the way out is offered.
    const { result } = board({ trips: [], modes: ['water'] });
    expect(result.current.emptyMessage).toBe('No journeys with the modes you picked.');
    expect(result.current.emptyFromFilter).toBe(true);
  });

  it("prefers the planner's own reason over our guess", () => {
    const problems: TransitProblem[] = [{ code: 'noStopsInRange' }];
    const { result } = board({ trips: [], problems });
    expect(result.current.emptyMessage).toBe(
      'No stops within walking distance of one of the ends. Try a nearby street or town.',
    );
    expect(result.current.emptyFromFilter).toBe(false);
  });

  it('falls back to a wording that suggests what to change', () => {
    const { result } = board({ trips: [] });
    expect(result.current.emptyMessage).toBe(
      'No departures found for this time. Try a different time or a nearer stop.',
    );
  });
});

describe('live notice', () => {
  it('states the online-only caveat before anything has failed', () => {
    // Not an error state: the board says so while it is working, which is the
    // only moment the warning can still change what someone relies on.
    expect(board().result.current.liveNotice).toBe('Live timetable — needs a connection.');
  });

  it('names when the shown answer was fetched, so it can age in plain sight', () => {
    expect(board({ trips: [tripAt(8, 0)], updatedMs: at(8, 41) }).result.current.liveNotice).toBe(
      'Live timetable, checked 08:41 — needs a connection to update.',
    );
  });
});
