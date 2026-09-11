import type { PlaceRecord } from '@atlas/storage';
import type { TransitCommuteResult, TransitLeg, TransitStopLines } from '@atlas/transit';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { EMPTY_COMMUTE_CONFIG, type CommuteConfig, type CommuteController } from './useCommute.js';
import { useCommuteEditor } from './useCommuteEditor.js';

const ENGELSRUD = {
  name: 'Engelsrud',
  position: { lat: 59.8198, lng: 10.3659 },
  stopId: 'NSR:StopPlace:3369',
};
const NATIONALTHEATRET = {
  name: 'Nationaltheatret',
  position: { lat: 59.9147, lng: 10.7333 },
  stopId: 'NSR:StopPlace:58404',
};

const BUS_280 = {
  id: 'RUT:Line:280',
  publicCode: '280',
  mode: 'bus' as const,
  name: 'Asker - Dikemark - Heggedal',
};
const BUS_71 = { id: 'BRA:Line:4_6071', publicCode: '71', mode: 'bus' as const };
const RAIL_L1 = { id: 'VYG:Line:L1', publicCode: 'L1', mode: 'rail' as const };

const stopLines: TransitStopLines = {
  stop: { id: 'NSR:StopPlace:3369', name: 'Engelsrud', position: { lat: 59.8, lng: 10.3 } },
  lines: [BUS_280, BUS_71, RAIL_L1],
};

function place(id: string, name: string): PlaceRecord {
  return {
    id,
    name,
    lat: 59.9,
    lng: 10.7,
    address: '',
    collectionId: null,
    notes: '',
    tags: [],
    icon: 'star',
    color: '#000000',
    visible: true,
    sortIndex: 0,
    createdAt: 1,
    updatedAt: 1,
  };
}

/** A controller whose config the test drives, as the real hook would. */
function harness({
  config = EMPTY_COMMUTE_CONFIG,
  result = null,
  places = [],
  fetchStopLines = vi.fn().mockResolvedValue(stopLines),
  geocode = vi.fn().mockResolvedValue({ results: [], offline: false }),
}: {
  config?: CommuteConfig;
  result?: TransitCommuteResult | null;
  places?: PlaceRecord[];
  fetchStopLines?: (stopId: string, signal: AbortSignal) => Promise<TransitStopLines>;
  geocode?: ReturnType<typeof vi.fn>;
} = {}) {
  const saved: CommuteConfig[] = [];
  const commute: CommuteController = {
    ready: true,
    config,
    setConfig: (next) => saved.push(next),
    query: config.from && config.to ? ({} as never) : null,
    result,
    loading: false,
    error: null,
    updatedMs: null,
    refresh: vi.fn(),
    emptyReason: () => 'none',
  };
  const view = renderHook(() =>
    useCommuteEditor({
      commute,
      places,
      geocode,
      fetchStopLines,
    }),
  );
  return { view, saved, fetchStopLines, geocode };
}

describe('endpoints', () => {
  it('is missing an end until both are chosen', () => {
    const { view } = harness();
    expect(view.result.current.missing).toBe('Choose where the commute starts.');
    const withFrom = harness({ config: { ...EMPTY_COMMUTE_CONFIG, from: ENGELSRUD } });
    expect(withFrom.view.result.current.missing).toBe('Choose where it ends.');
    const both = harness({
      config: { ...EMPTY_COMMUTE_CONFIG, from: ENGELSRUD, to: NATIONALTHEATRET },
    });
    expect(both.view.result.current.missing).toBeNull();
  });

  it('keeps the NSR id off a searched stop — the whole point of the rework', () => {
    const { view, saved } = harness();
    act(() =>
      view.result.current.pickHit('from', {
        name: 'Engelsrud',
        label: 'Asker',
        position: { lat: 59.82, lng: 10.37 },
        saved: false,
        transitStopId: 'NSR:StopPlace:3369',
      }),
    );
    expect(saved[0]!.from).toEqual({
      name: 'Engelsrud',
      position: { lat: 59.82, lng: 10.37 },
      stopId: 'NSR:StopPlace:3369',
    });
  });

  it('still takes a favorite as a shortcut, remembering which one', () => {
    const { view, saved } = harness({ places: [place('e', 'Home')] });
    act(() => view.result.current.pickPlace('from', place('e', 'Home')));
    expect(saved[0]!.from).toMatchObject({ placeId: 'e', name: 'Home' });
    // No stop id: a favorite is a coordinate, and the picker says so.
    expect(saved[0]!.from?.stopId).toBeUndefined();
  });

  it('labels an unset end by what it wants, and Via as optional', () => {
    const { view } = harness();
    expect(view.result.current.endLabel('from')).toBe('Choose a From stop…');
    expect(view.result.current.endLabel('via')).toBe('No interchange');
  });

  it('reports whether an end can offer a line list', () => {
    const { view } = harness({
      config: {
        ...EMPTY_COMMUTE_CONFIG,
        from: ENGELSRUD,
        to: { name: 'Work', position: { lat: 59.9, lng: 10.7 } },
      },
    });
    expect(view.result.current.isStop('from')).toBe(true);
    expect(view.result.current.isStop('to')).toBe(false);
  });
});

describe('line picker', () => {
  it('asks each chosen stop for its lines, grouped by mode', async () => {
    const { view, fetchStopLines } = harness({
      config: { ...EMPTY_COMMUTE_CONFIG, from: ENGELSRUD, to: NATIONALTHEATRET },
    });
    await waitFor(() => expect(view.result.current.lineGroups.length).toBeGreaterThan(0));
    expect(fetchStopLines).toHaveBeenCalledTimes(2);
    const groups = view.result.current.lineGroups;
    expect(groups.map((group) => group.label)).toEqual(['Bus', 'Train']);
    // 71 before 280: a timetable reads codes as numbers.
    expect(groups[0]!.lines.map((line) => line.publicCode)).toEqual(['71', '280']);
  });

  it('asks nothing when no end named a stop', () => {
    const { view, fetchStopLines } = harness({
      config: {
        ...EMPTY_COMMUTE_CONFIG,
        from: { name: 'Home', position: { lat: 59.8, lng: 10.3 } },
      },
    });
    expect(fetchStopLines).not.toHaveBeenCalled();
    expect(view.result.current.lineGroups).toEqual([]);
  });

  it('ticks a line to require it, and never both requires and avoids one', () => {
    const { view, saved } = harness({
      config: { ...EMPTY_COMMUTE_CONFIG, exclude: [BUS_280] },
    });
    act(() => view.result.current.toggleSelect(BUS_280));
    expect(saved[0]!.select).toEqual([BUS_280]);
    expect(saved[0]!.exclude).toEqual([]);
  });

  it('untick clears it again', () => {
    const { view, saved } = harness({ config: { ...EMPTY_COMMUTE_CONFIG, select: [BUS_280] } });
    act(() => view.result.current.toggleSelect(BUS_280));
    expect(saved[0]!.select).toEqual([]);
  });

  it('states "not the local train" as a line exclusion', () => {
    // The old build substring-matched a stop name — "Hvalstad" also excluding
    // "Hvalstad stasjon" — and `banned.quays` is NOT IMPLEMENTED upstream, so
    // the intent could never move server-side. Exactly two rail lines call at
    // Hvalstad, so "skip Hvalstad" is "not L1 or L2".
    const { view, saved } = harness();
    act(() => view.result.current.toggleExclude(RAIL_L1));
    expect(saved[0]!.exclude).toEqual([RAIL_L1]);
  });

  it('offers the one-tap way out of a board its own filter emptied', () => {
    const { view, saved } = harness({
      config: { ...EMPTY_COMMUTE_CONFIG, select: [BUS_280], exclude: [RAIL_L1] },
    });
    act(() => view.result.current.clearLines());
    expect(saved[0]).toMatchObject({ select: [], exclude: [] });
  });

  it('shortlists the lines a real journey used, and puts them first', async () => {
    const journeyLeg = {
      mode: 'bus' as const,
      distanceM: 1,
      durationMs: 1,
      aimedStartMs: 1,
      expectedStartMs: 1,
      aimedEndMs: 2,
      expectedEndMs: 2,
      realtime: false,
      from: { name: 'Engelsrud', position: { lat: 59.8, lng: 10.3 } },
      to: { name: 'Asker', position: { lat: 59.8, lng: 10.4 } },
      line: { id: BUS_280.id, publicCode: '280', headsign: 'Asker' },
      intermediateStops: [],
      points: [],
      situations: [],
    };
    const { view } = harness({
      config: { ...EMPTY_COMMUTE_CONFIG, from: ENGELSRUD, to: NATIONALTHEATRET },
      result: {
        outbound: {
          trips: [{ startMs: 1, endMs: 2, durationMs: 1, walkDistanceM: 0, legs: [journeyLeg] }],
          problems: [],
        },
        inbound: { trips: [], problems: [] },
      },
    });
    // The journey's own lines land before the stops answer, so wait for both:
    // the shortlist is an ordering on the full list, not a separate one.
    await waitFor(() => expect(view.result.current.lineGroups[0]?.lines).toHaveLength(2));
    const buses = view.result.current.lineGroups[0]!.lines;
    expect(buses[0]).toMatchObject({ publicCode: '280', seen: true, towards: 'Asker' });
    expect(buses[1]).toMatchObject({ publicCode: '71', seen: false });
  });
});

describe('modes', () => {
  it('reads every chip as on when nothing is chosen — no secret mode ban', () => {
    const { view } = harness();
    expect(view.result.current.modes.every((mode) => mode.on)).toBe(true);
    expect(view.result.current.modes.map((mode) => mode.label)).toContain('Metro');
  });

  it('unticking one mode saves the rest explicitly', () => {
    const { view, saved } = harness();
    act(() => view.result.current.toggleMode('air'));
    expect(saved[0]!.modes).not.toContain('air');
    expect(saved[0]!.modes).toContain('bus');
  });

  it('collapses a full selection back to "all of them"', () => {
    const { view, saved } = harness({
      config: { ...EMPTY_COMMUTE_CONFIG, modes: ['bus', 'tram', 'metro', 'rail', 'water', 'air'] },
    });
    act(() => view.result.current.toggleMode('cableway'));
    expect(saved[0]!.modes).toEqual([]);
  });
});

describe('when', () => {
  it('says what the saved time means', () => {
    const { view } = harness({
      config: {
        ...EMPTY_COMMUTE_CONFIG,
        outboundTime: { minutesOfDay: 430, arriveBy: false },
        inboundTime: { minutesOfDay: 990, arriveBy: true },
      },
    });
    expect(view.result.current.timeLabel('outbound')).toBe('Leave at 07:10');
    expect(view.result.current.timeLabel('inbound')).toBe('Arrive by 16:30');
  });

  it('falls back to "leave now" with no time saved', () => {
    expect(harness().view.result.current.timeLabel('outbound')).toBe('Leave now');
  });

  it('sets a time and an arrive-by per direction', () => {
    const { view, saved } = harness();
    act(() => view.result.current.setTime('inbound', 990));
    expect(saved[0]!.inboundTime).toEqual({ minutesOfDay: 990, arriveBy: false });
    expect(saved[0]!.outboundTime.minutesOfDay).toBeNull();
  });

  it('treats no day list as every day, and unticking one as the rest', () => {
    const { view, saved } = harness();
    expect(view.result.current.days.every((day) => day.on)).toBe(true);
    act(() => view.result.current.toggleDay(7));
    expect(saved[0]!.days).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

/**
 * TRANSIT.md §13's offer. Everything the middle ground and the per-leg boards do
 * hangs off a saved `via`, and a commute is saved door to door — so the corridor
 * that changes at Asker every single time had no way to say so.
 */
describe('the suggested interchange', () => {
  const leg = (from: string, to: string, mode: TransitLeg['mode'] = 'bus'): TransitLeg => ({
    mode,
    distanceM: 4_000,
    durationMs: 600_000,
    aimedStartMs: 1,
    expectedStartMs: 1,
    aimedEndMs: 600_001,
    expectedEndMs: 600_001,
    realtime: false,
    from: { name: from, position: { lat: 59.83, lng: 10.43 } },
    to: { name: to, position: { lat: 59.833, lng: 10.434 } },
    intermediateStops: [],
    points: [],
    situations: [],
  });

  const changing = (): TransitCommuteResult => ({
    outbound: {
      trips: [
        {
          startMs: 1,
          endMs: 2,
          durationMs: 1,
          walkDistanceM: 0,
          legs: [
            leg('Engelsrud', 'Asker stasjon'),
            leg('Asker stasjon', 'Nationaltheatret', 'rail'),
          ],
        },
      ],
      problems: [],
    },
    inbound: { trips: [], problems: [] },
  });

  const ASKER_HIT = {
    name: 'Asker stasjon',
    label: 'Bus · Train · Asker',
    position: { lat: 59.833128, lng: 10.434169 },
    transitStopId: 'NSR:StopPlace:59616',
  };

  // Ends without NSR ids: the suggestion never asks a stop for its lines, and a
  // line fetch resolving mid-test is a state update nothing here is waiting for.
  const configured = {
    ...EMPTY_COMMUTE_CONFIG,
    from: { name: ENGELSRUD.name, position: ENGELSRUD.position },
    to: { name: NATIONALTHEATRET.name, position: NATIONALTHEATRET.position },
  };

  it('offers the stop the journeys all change at', () => {
    const { view } = harness({ config: configured, result: changing() });
    expect(view.result.current.suggestedVia?.name).toBe('Asker stasjon');
  });

  it('offers nothing once an interchange is saved', () => {
    const { view } = harness({
      config: { ...configured, via: { name: 'Asker stasjon' } },
      result: changing(),
    });
    expect(view.result.current.suggestedVia).toBeNull();
  });

  it('saves it as a stop, not as a coordinate', async () => {
    const geocode = vi.fn().mockResolvedValue({ results: [ASKER_HIT], offline: false });
    const { view, saved } = harness({ config: configured, result: changing(), geocode });
    act(() => view.result.current.addSuggestedVia());
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]!.via).toEqual({
      name: 'Asker stasjon',
      position: { lat: 59.833128, lng: 10.434169 },
      stopId: 'NSR:StopPlace:59616',
    });
    expect(geocode).toHaveBeenCalledWith(expect.objectContaining({ text: 'Asker stasjon' }));
  });

  /**
   * A national geocoder will happily return a same-named stop in another county,
   * and a via 200 km away is worse than none: the board would answer nothing at
   * all and blame the timetable for it.
   */
  it('refuses a same-named stop that is nowhere near the change', async () => {
    const geocode = vi.fn().mockResolvedValue({
      results: [{ ...ASKER_HIT, position: { lat: 63.43, lng: 10.39 } }],
      offline: false,
    });
    const { view, saved } = harness({ config: configured, result: changing(), geocode });
    act(() => view.result.current.addSuggestedVia());
    await waitFor(() => expect(view.result.current.suggestedViaError).toBeTruthy());
    expect(saved).toHaveLength(0);
  });

  /**
   * A coordinate would answer the journey question and silently break the other
   * two — the line picker can only ask a stop for its lines — so an unresolvable
   * name is said out loud rather than saved as a point.
   */
  it('saves nothing when the search finds no stop at all', async () => {
    const { view, saved } = harness({ config: configured, result: changing() });
    act(() => view.result.current.addSuggestedVia());
    await waitFor(() => expect(view.result.current.suggestedViaError).toContain('Asker stasjon'));
    expect(saved).toHaveLength(0);
    expect(view.result.current.addingVia).toBe(false);
  });
});
