import type { PlaceRecord } from '@atlas/storage';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { TransitTrip } from '@atlas/transit';

import {
  COMMUTE_COMMIT_SETTING_KEY,
  COMMUTE_SETTING_KEY,
  COMMUTE_TRACKED_SETTING,
  commuteQueryFrom,
  EMPTY_COMMUTE_CONFIG,
  EMPTY_COMMUTE_LIBRARY,
  isLegacyCommuteSetting,
  plannedCommuteFromWaypoints,
  parseCommuteCommit,
  parseCommuteConfig,
  parseCommuteLibrary,
  serializeCommuteConfig,
  serializeCommuteLibrary,
  routePlanFromCommute,
  useCommute,
  type CommuteSettings,
} from './useCommute.js';
import { useCommuteDashboard } from './useCommuteDashboard.js';

function saved(id: string, name: string): PlaceRecord {
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
const LINE_280 = { id: 'RUT:Line:280', publicCode: '280', mode: 'bus' as const };

describe('commute settings', () => {
  it('starts empty — nobody else’s bus lines, nobody else’s favorites', () => {
    // The old build shipped `allowedBusLines: ['280','71']` and
    // `excludedRailStops: ['Hvalstad']` inside a shared package, and grepped the
    // user's favorites for "engelsrud". A first run now has nothing saved.
    expect(parseCommuteConfig(null)).toBeNull();
    expect(EMPTY_COMMUTE_CONFIG.select).toEqual([]);
    expect(EMPTY_COMMUTE_CONFIG.modes).toEqual([]);
    expect(EMPTY_COMMUTE_CONFIG.from).toBeNull();
  });

  it('round-trips the saved shape', () => {
    const config = {
      ...EMPTY_COMMUTE_CONFIG,
      from: ENGELSRUD,
      to: NATIONALTHEATRET,
      select: [LINE_280],
      modes: ['bus' as const, 'rail' as const],
      outboundTime: { minutesOfDay: 430, arriveBy: false },
      days: [1, 2, 3, 4, 5] as const,
    };
    expect(
      parseCommuteConfig(serializeCommuteConfig({ ...config, days: [...config.days] })),
    ).toEqual({ ...config, days: [...config.days] });
  });

  it('rejects a malformed setting rather than guessing', () => {
    expect(parseCommuteConfig('{')).toBeNull();
    // An end with neither coordinates nor a favorite cannot be resolved.
    expect(parseCommuteConfig('{"version":2,"from":{"name":"X"}}')?.from).toBeNull();
    // A line with no id could never be filtered on.
    expect(parseCommuteConfig('{"version":2,"select":[{"publicCode":"280"}]}')?.select).toEqual([]);
  });

  it('clamps a nonsense time and weekday list', () => {
    const config = parseCommuteConfig(
      '{"version":2,"outboundTime":{"minutesOfDay":9999},"days":[0,3,3,9]}',
    );
    expect(config?.outboundTime.minutesOfDay).toBeNull();
    expect(config?.days).toEqual([3]);
  });

  describe('migrating the pre-rework setting', () => {
    const v1 = JSON.stringify({
      fromId: 'e',
      viaId: 'a',
      toId: 'n',
      allowedBusLines: ['280', '71'],
      excludedRailStops: ['Hvalstad'],
    });

    it('keeps the corridor and drops rules that cannot be honoured', () => {
      const migrated = parseCommuteConfig(v1)!;
      expect(migrated.from).toEqual({ name: '', placeId: 'e' });
      expect(migrated.via).toEqual({ name: '', placeId: 'a' });
      expect(migrated.to).toEqual({ name: '', placeId: 'n' });
      // A public code cannot become a line id without asking Entur which of the
      // three lines answering to "280" was meant, so the line rules go and the
      // board opens on its picker.
      expect(migrated.select).toEqual([]);
      expect(migrated.exclude).toEqual([]);
    });

    it('is idempotent: the migrated value is not migrated again', () => {
      const once = parseCommuteLibrary(v1)!;
      const written = serializeCommuteLibrary(once);
      expect(parseCommuteLibrary(written)).toEqual(once);
      expect(isLegacyCommuteSetting(v1)).toBe(true);
      expect(isLegacyCommuteSetting(written)).toBe(false);
    });

    it('does not carry the old fields forward', () => {
      const written = JSON.parse(serializeCommuteConfig(parseCommuteConfig(v1)!)) as Record<
        string,
        unknown
      >;
      expect(written).not.toHaveProperty('allowedBusLines');
      expect(written).not.toHaveProperty('excludedRailStops');
      expect(written).not.toHaveProperty('fromId');
    });
  });

  it('round-trips several named commutes and keeps board and widget choices separate', () => {
    const library = {
      commutes: [
        { id: 'work', name: 'Work', config: EMPTY_COMMUTE_CONFIG },
        { id: 'cabin', name: 'Cabin', config: { ...EMPTY_COMMUTE_CONFIG, from: ENGELSRUD } },
      ],
      activeId: 'cabin',
      widgetId: 'work',
    };
    expect(parseCommuteLibrary(serializeCommuteLibrary(library))).toEqual(library);
  });
});

describe('commuteQueryFrom', () => {
  const places = [saved('e', 'Engelsrud favorite')];

  it('needs both ends, but no longer needs a typed bus line', () => {
    expect(commuteQueryFrom(EMPTY_COMMUTE_CONFIG, [])).toBeNull();
    const query = commuteQueryFrom(
      { ...EMPTY_COMMUTE_CONFIG, from: ENGELSRUD, to: NATIONALTHEATRET },
      [],
    );
    // An unfiltered commute is a valid question — and its answer is what makes
    // the line picker a shortlist of real services.
    expect(query).toMatchObject({ filter: { select: [], exclude: [], modes: [] } });
  });

  it('passes the stop id through, so the commute starts at the platform', () => {
    const query = commuteQueryFrom(
      { ...EMPTY_COMMUTE_CONFIG, from: ENGELSRUD, to: NATIONALTHEATRET },
      [],
    );
    expect(query?.from.stopId).toBe('NSR:StopPlace:3369');
    expect(query?.to.stopId).toBe('NSR:StopPlace:58404');
  });

  it('follows a favorite’s current name and position', () => {
    const query = commuteQueryFrom(
      {
        ...EMPTY_COMMUTE_CONFIG,
        from: { name: 'stale name', placeId: 'e' },
        to: NATIONALTHEATRET,
      },
      places,
    );
    expect(query?.from).toMatchObject({ name: 'Engelsrud favorite', lat: 59.9, lng: 10.7 });
  });

  it('treats a favorite that no longer exists as an unset end', () => {
    expect(
      commuteQueryFrom(
        { ...EMPTY_COMMUTE_CONFIG, from: { name: 'gone', placeId: 'x' }, to: NATIONALTHEATRET },
        places,
      ),
    ).toBeNull();
  });

  it('drops an interchange that is one of the ends', () => {
    const query = commuteQueryFrom(
      { ...EMPTY_COMMUTE_CONFIG, from: ENGELSRUD, via: ENGELSRUD, to: NATIONALTHEATRET },
      [],
    );
    expect(query?.via).toEqual([]);
  });

  it('refuses a commute from a stop to itself', () => {
    expect(
      commuteQueryFrom({ ...EMPTY_COMMUTE_CONFIG, from: ENGELSRUD, to: ENGELSRUD }, []),
    ).toBeNull();
  });
});

describe('planner and commute hand-offs', () => {
  it('keeps exact stops and one interchange when saving a planned trip', () => {
    const planned = plannedCommuteFromWaypoints([
      {
        id: 1,
        pos: ENGELSRUD.position,
        name: ENGELSRUD.name,
        transitStopId: ENGELSRUD.stopId,
      },
      { id: 2, pos: { lat: 59.834, lng: 10.435 }, name: 'Asker stasjon' },
      {
        id: 3,
        pos: NATIONALTHEATRET.position,
        name: NATIONALTHEATRET.name,
        transitStopId: NATIONALTHEATRET.stopId,
      },
    ]);

    expect(planned).toMatchObject({
      name: 'Engelsrud → Nationaltheatret',
      config: {
        from: { name: 'Engelsrud', stopId: ENGELSRUD.stopId },
        via: { name: 'Asker stasjon' },
        to: { name: 'Nationaltheatret', stopId: NATIONALTHEATRET.stopId },
      },
    });
    expect(routePlanFromCommute(commuteQueryFrom(planned!.config, [])!)).toEqual({
      profile: 'foot',
      waypoints: [
        {
          pos: ENGELSRUD.position,
          name: ENGELSRUD.name,
          transitStopId: ENGELSRUD.stopId,
        },
        { pos: { lat: 59.834, lng: 10.435 }, name: 'Asker stasjon' },
        {
          pos: NATIONALTHEATRET.position,
          name: NATIONALTHEATRET.name,
          transitStopId: NATIONALTHEATRET.stopId,
        },
      ],
    });
  });

  it('refuses to lose a planner corridor with more than one intermediate stop', () => {
    expect(
      plannedCommuteFromWaypoints([
        { id: 1, pos: ENGELSRUD.position },
        { id: 2, pos: { lat: 59.82, lng: 10.4 } },
        { id: 3, pos: { lat: 59.85, lng: 10.5 } },
        { id: 4, pos: NATIONALTHEATRET.position },
      ]),
    ).toBeNull();
  });
});

describe('useCommute', () => {
  const settings = (
    getSetting: CommuteSettings['getSetting'],
    setSetting = vi.fn(),
  ): CommuteSettings => ({ status: 'ready', getSetting, setSetting });

  /**
   * The contract Android's home-screen widget bridge depends on: until the
   * saved commute has been read there is no question to ask, and `ready` is how
   * a caller tells "no commute configured" from "not read yet". Handing the
   * widget a null query during that window would clear the question it already
   * had, so a launch that never got as far as storage would leave it blank.
   */
  it('has no query and is not ready until the saved setting resolves', async () => {
    let release: (value: string | null) => void = () => {};
    const pending = new Promise<string | null>((resolve) => {
      release = resolve;
    });
    const fetchCommute = vi.fn();
    const { result } = renderHook(() =>
      useCommute(
        settings(() => pending),
        [],
        fetchCommute,
        false,
      ),
    );

    expect(result.current.ready).toBe(false);
    expect(result.current.query).toBeNull();

    release(
      serializeCommuteConfig({
        ...EMPTY_COMMUTE_CONFIG,
        from: ENGELSRUD,
        to: NATIONALTHEATRET,
        select: [LINE_280],
      }),
    );

    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.query).toMatchObject({
      from: { name: 'Engelsrud', stopId: 'NSR:StopPlace:3369' },
      to: { name: 'Nationaltheatret' },
      filter: { select: [LINE_280] },
    });
    // Closed board: the query exists for the widget, but nothing is fetched.
    expect(fetchCommute).not.toHaveBeenCalled();
  });

  it('writes nothing on a first run — an empty commute is not worth a synced row', async () => {
    const setSetting = vi.fn();
    const { result } = renderHook(() =>
      useCommute(
        settings(() => Promise.resolve(null), setSetting),
        [],
        vi.fn(),
        false,
      ),
    );
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(setSetting).not.toHaveBeenCalled();
  });

  it('finishes the migration by writing the new shape back exactly once', async () => {
    const setSetting = vi.fn();
    const v1 = JSON.stringify({ fromId: 'e', toId: 'n', allowedBusLines: ['280'] });
    const { result } = renderHook(() =>
      useCommute(
        settings(() => Promise.resolve(v1), setSetting),
        [],
        vi.fn(),
        false,
      ),
    );
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(setSetting).toHaveBeenCalledTimes(1);
    expect(setSetting.mock.calls[0]![0]).toBe(COMMUTE_SETTING_KEY);
    expect(isLegacyCommuteSetting(String(setSetting.mock.calls[0]![1]))).toBe(false);
  });

  it('reports which nothing an empty direction was', async () => {
    const fetchCommute = vi.fn().mockResolvedValue({
      outbound: { trips: [], problems: [] },
      inbound: { trips: [], problems: [] },
      emptyReason: { outbound: 'filtered', inbound: 'upstream' },
    });
    const { result } = renderHook(() =>
      useCommute(
        settings(() =>
          Promise.resolve(
            serializeCommuteConfig({
              ...EMPTY_COMMUTE_CONFIG,
              from: ENGELSRUD,
              to: NATIONALTHEATRET,
            }),
          ),
        ),
        [],
        fetchCommute,
        true,
      ),
    );
    await waitFor(() => expect(result.current.result).not.toBeNull());
    expect(result.current.emptyReason('outbound')).toBe('filtered');
    expect(result.current.emptyReason('inbound')).toBe('upstream');
  });

  /**
   * TRANSIT.md §7. The board's commitment lives under `local.`, which never syncs:
   * "the journey I am on right now" is the least portable fact this app holds,
   * and syncing it would put a laptop's board on a bus it is not on.
   */
  describe('the tracked journey', () => {
    const commit = { direction: 'outbound' as const, departureMs: 1_756_276_200_000, line: '280' };

    it('reads a saved commitment and hands it to the board', async () => {
      const fetchCommute = vi.fn().mockResolvedValue({
        outbound: { trips: [], problems: [] },
        inbound: { trips: [], problems: [] },
      });
      const getSetting = vi.fn((key: string) =>
        Promise.resolve(
          key === COMMUTE_COMMIT_SETTING_KEY
            ? JSON.stringify(commit)
            : serializeCommuteConfig({
                ...EMPTY_COMMUTE_CONFIG,
                from: ENGELSRUD,
                to: NATIONALTHEATRET,
              }),
        ),
      );
      const { result } = renderHook(() =>
        useCommute({ status: 'ready', getSetting, setSetting: vi.fn() }, [], fetchCommute, true),
      );
      await waitFor(() => expect(result.current.commit).toMatchObject(commit));
      // The upstream question carries it, which is what lets the answer contain
      // a journey that has already left.
      await waitFor(() => expect(fetchCommute).toHaveBeenCalled());
      expect(fetchCommute.mock.calls.at(-1)?.[2]).toMatchObject(commit);
    });

    /**
     * The contract Android's widget bridge leans on for the *commitment*, the
     * way the test above states it for the query: `ready` means the saved state
     * has been read, all of it. Two independent reads would let the app push
     * "nothing is tracked" onto every home-screen widget during the window
     * before the commitment arrived — and cost a second upstream call when it
     * did, because the board re-asks by name for the journey it is tracking.
     */
    it('is not ready until the commitment has been read too', async () => {
      let release: (value: string | null) => void = () => {};
      const pending = new Promise<string | null>((resolve) => {
        release = resolve;
      });
      const fetchCommute = vi.fn().mockResolvedValue({
        outbound: { trips: [], problems: [] },
        inbound: { trips: [], problems: [] },
      });
      const { result } = renderHook(() =>
        useCommute(
          settings((key) =>
            key === COMMUTE_COMMIT_SETTING_KEY
              ? pending
              : Promise.resolve(
                  serializeCommuteConfig({
                    ...EMPTY_COMMUTE_CONFIG,
                    from: ENGELSRUD,
                    to: NATIONALTHEATRET,
                  }),
                ),
          ),
          [],
          fetchCommute,
          true,
        ),
      );
      // The config is in hand; the commitment is not, so neither is `ready`.
      await Promise.resolve();
      expect(result.current.ready).toBe(false);
      expect(fetchCommute).not.toHaveBeenCalled();
      await act(async () => {
        release(JSON.stringify(commit));
      });
      await waitFor(() => expect(result.current.ready).toBe(true));
      // Already there at the instant `ready` is: never a moment of "ready, and
      // tracking nothing" for the widget push to act on.
      expect(result.current.commit).toMatchObject(commit);
      await waitFor(() => expect(fetchCommute).toHaveBeenCalledTimes(1));
      expect(fetchCommute.mock.calls[0]?.[2]).toMatchObject(commit);
    });

    it('writes the commitment where it cannot sync', async () => {
      const setSetting = vi.fn();
      const fetchCommute = vi.fn().mockResolvedValue({
        outbound: { trips: [], problems: [] },
        inbound: { trips: [], problems: [] },
      });
      const { result } = renderHook(() =>
        useCommute(
          settings(
            () =>
              Promise.resolve(
                serializeCommuteConfig({
                  ...EMPTY_COMMUTE_CONFIG,
                  from: ENGELSRUD,
                  to: NATIONALTHEATRET,
                }),
              ),
            setSetting,
          ),
          [],
          fetchCommute,
          true,
        ),
      );
      await waitFor(() => expect(result.current.ready).toBe(true));
      act(() => result.current.setCommit(commit));
      expect(setSetting).toHaveBeenCalledWith(
        COMMUTE_COMMIT_SETTING_KEY,
        JSON.stringify({ commuteId: 'commute', commit }),
      );
      expect(COMMUTE_COMMIT_SETTING_KEY.startsWith('local.')).toBe(true);
    });

    /**
     * Stale-while-revalidate for the one journey that matters: the card is
     * drawn from the kept copy the moment the saved state is read, before a
     * request has returned — or while one never does, on a train's Wi-Fi.
     */
    it('keeps the tracked journey and draws it before any answer arrives', async () => {
      const ridden: TransitTrip = {
        startMs: commit.departureMs,
        endMs: commit.departureMs + 30 * 60_000,
        durationMs: 30 * 60_000,
        walkDistanceM: 0,
        legs: [],
      };
      const config = serializeCommuteConfig({
        ...EMPTY_COMMUTE_CONFIG,
        from: ENGELSRUD,
        to: NATIONALTHEATRET,
      });
      const setSetting = vi.fn();
      const first = renderHook(() =>
        useCommute(
          settings(
            (key) =>
              Promise.resolve(
                key === COMMUTE_COMMIT_SETTING_KEY
                  ? JSON.stringify(commit)
                  : key === COMMUTE_SETTING_KEY
                    ? config
                    : null,
              ),
            setSetting,
          ),
          [],
          vi.fn().mockResolvedValue({
            outbound: { trips: [], problems: [] },
            inbound: { trips: [], problems: [] },
            committed: { trip: ridden, replaced: null },
          }),
          true,
        ),
      );
      await waitFor(() => expect(first.result.current.tracked?.trip).toEqual(ridden));
      const written = setSetting.mock.calls.find(([key]) => key === COMMUTE_TRACKED_SETTING.key);
      expect(COMMUTE_TRACKED_SETTING.key.startsWith('local.')).toBe(true);
      first.unmount();

      // A cold start whose request never comes back.
      const second = renderHook(() =>
        useCommute(
          settings((key) =>
            Promise.resolve(
              key === COMMUTE_COMMIT_SETTING_KEY
                ? JSON.stringify(commit)
                : key === COMMUTE_SETTING_KEY
                  ? config
                  : String(written?.[1]),
            ),
          ),
          [],
          () => new Promise(() => {}),
          true,
        ),
      );
      await waitFor(() => expect(second.result.current.ready).toBe(true));
      expect(second.result.current.result).toBeNull();
      expect(second.result.current.tracked?.trip).toEqual(ridden);
      second.unmount();
    });

    /**
     * The board releases a commitment it cannot find a journey for. A journey
     * that arrived one render after the Track tap was therefore a commitment
     * released the instant it was made — the tracked card never appeared.
     */
    it('hands over the tracked journey in the same render as the commitment', async () => {
      // In the future of the real clock: the board releases a commitment whose
      // journey has finished, and this one must be judged as live.
      const departs = Math.ceil((Date.now() + 30 * 60_000) / 60_000) * 60_000;
      const bus: TransitTrip = {
        startMs: departs,
        endMs: departs + 20 * 60_000,
        durationMs: 20 * 60_000,
        walkDistanceM: 0,
        legs: [
          {
            mode: 'bus',
            distanceM: 5_000,
            durationMs: 20 * 60_000,
            aimedStartMs: departs,
            expectedStartMs: departs,
            aimedEndMs: departs + 20 * 60_000,
            expectedEndMs: departs + 20 * 60_000,
            realtime: false,
            from: { name: 'Engelsrud', position: { lat: 59.8, lng: 10.3 } },
            to: { name: 'Nationaltheatret', position: { lat: 59.9, lng: 10.7 } },
            line: { id: 'RUT:Line:280', publicCode: '280' },
            intermediateStops: [],
            points: [],
            situations: [],
          },
        ],
      };
      const { result } = renderHook(() => {
        const commute = useCommute(
          settings((key) =>
            Promise.resolve(
              key === COMMUTE_SETTING_KEY
                ? serializeCommuteConfig({
                    ...EMPTY_COMMUTE_CONFIG,
                    from: ENGELSRUD,
                    to: NATIONALTHEATRET,
                  })
                : null,
            ),
          ),
          [],
          vi.fn().mockResolvedValue({
            outbound: { trips: [bus], problems: [] },
            inbound: { trips: [], problems: [] },
          }),
          true,
        );
        return { commute, dashboard: useCommuteDashboard(commute) };
      });
      await waitFor(() => expect(result.current.commute.result).not.toBeNull());
      act(() =>
        result.current.commute.setCommit({
          direction: 'outbound',
          departureMs: departs,
          line: '280',
        }),
      );
      expect(result.current.commute.commit).not.toBeNull();
      expect(result.current.commute.tracked?.trip).toBe(bus);
      expect(result.current.dashboard.here).not.toBeNull();
    });

    it('lets the kept journey go with the commitment', async () => {
      const setSetting = vi.fn();
      const { result } = renderHook(() =>
        useCommute(
          settings(
            (key) =>
              Promise.resolve(
                key === COMMUTE_COMMIT_SETTING_KEY
                  ? JSON.stringify(commit)
                  : key === COMMUTE_SETTING_KEY
                    ? serializeCommuteConfig({
                        ...EMPTY_COMMUTE_CONFIG,
                        from: ENGELSRUD,
                        to: NATIONALTHEATRET,
                      })
                    : JSON.stringify({
                        commuteId: 'commute',
                        commitKey: `outbound:${commit.departureMs}:280`,
                        trip: { startMs: 1, endMs: 2, durationMs: 1, walkDistanceM: 0, legs: [] },
                        updatedMs: 1,
                      }),
              ),
            setSetting,
          ),
          [],
          () => new Promise(() => {}),
          false,
        ),
      );
      await waitFor(() => expect(result.current.tracked).not.toBeNull());
      act(() => result.current.setCommit(null));
      expect(result.current.tracked).toBeNull();
      expect(setSetting).toHaveBeenCalledWith(COMMUTE_TRACKED_SETTING.key, '');
    });

    it('ignores a stored value that is not a commitment', () => {
      expect(parseCommuteCommit(null)).toBeNull();
      expect(parseCommuteCommit('')).toBeNull();
      expect(parseCommuteCommit('not json')).toBeNull();
      expect(parseCommuteCommit('{"direction":"outbound","line":"280"}')).toBeNull();
      expect(parseCommuteCommit(JSON.stringify(commit))).toMatchObject(commit);
    });
  });

  /**
   * A failed refresh or a closed board used to empty the board, so the next
   * glance began from nothing. The last answer stays, and its age is what the
   * board states.
   */
  it('keeps the last answer through a failed refresh and a closed board', async () => {
    const answer = {
      outbound: { trips: [], problems: [] },
      inbound: { trips: [], problems: [] },
    };
    const fetchCommute = vi
      .fn()
      .mockResolvedValueOnce(answer)
      .mockRejectedValueOnce(new Error('offline'));
    const { result, rerender } = renderHook(
      ({ open }) =>
        useCommute(
          settings(() =>
            Promise.resolve(
              serializeCommuteConfig({
                ...EMPTY_COMMUTE_CONFIG,
                from: ENGELSRUD,
                to: NATIONALTHEATRET,
              }),
            ),
          ),
          [],
          fetchCommute,
          open,
        ),
      { initialProps: { open: true } },
    );
    await waitFor(() => expect(result.current.result).toBe(answer));
    const checked = result.current.updatedMs;
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.result).toBe(answer);
    expect(result.current.updatedMs).toBe(checked);
    rerender({ open: false });
    expect(result.current.result).toBe(answer);
  });

  it('warms a saved commute before opening and reuses its recent answer', async () => {
    const answer = {
      outbound: { trips: [], problems: [] },
      inbound: { trips: [], problems: [] },
    };
    const fetchCommute = vi.fn().mockResolvedValue(answer);
    const { result, rerender } = renderHook(
      ({ open }) =>
        useCommute(
          settings(() =>
            Promise.resolve(
              serializeCommuteConfig({
                ...EMPTY_COMMUTE_CONFIG,
                from: ENGELSRUD,
                to: NATIONALTHEATRET,
              }),
            ),
          ),
          [],
          fetchCommute,
          open,
        ),
      { initialProps: { open: false } },
    );
    await waitFor(() => expect(result.current.result).toBe(answer));
    expect(fetchCommute).toHaveBeenCalledTimes(1);
    rerender({ open: true });
    expect(result.current.result).toBe(answer);
    expect(fetchCommute).toHaveBeenCalledTimes(1);
  });

  it('switches named commutes without repointing the widget', async () => {
    const setSetting = vi.fn();
    const work = {
      ...EMPTY_COMMUTE_CONFIG,
      from: ENGELSRUD,
      to: NATIONALTHEATRET,
    };
    const cabin = {
      ...EMPTY_COMMUTE_CONFIG,
      from: { ...ENGELSRUD, name: 'Cabin bus' },
      to: { ...NATIONALTHEATRET, name: 'Trailhead' },
    };
    const stored = serializeCommuteLibrary({
      commutes: [
        { id: 'work', name: 'Work', config: work },
        { id: 'cabin', name: 'Cabin', config: cabin },
      ],
      activeId: 'work',
      widgetId: 'work',
    });
    const { result } = renderHook(() =>
      useCommute(
        settings(() => Promise.resolve(stored), setSetting),
        [],
        vi.fn(),
        false,
      ),
    );
    await waitFor(() => expect(result.current.ready).toBe(true));
    act(() => result.current.selectCommute('cabin'));
    expect(result.current.activeId).toBe('cabin');
    expect(result.current.query?.from.name).toBe('Cabin bus');
    expect(result.current.widgetCommuteId).toBe('work');
    expect(result.current.widgetQuery?.from.name).toBe('Engelsrud');
  });

  it('adds, renames, assigns and safely deletes a commute', async () => {
    const { result } = renderHook(() =>
      useCommute(
        settings(() => Promise.resolve(null)),
        [],
        vi.fn(),
        false,
      ),
    );
    await waitFor(() => expect(result.current.ready).toBe(true));
    act(() => result.current.addCommute());
    const addedId = result.current.activeId;
    expect(addedId).not.toBe('commute');
    expect(result.current.commutes).toHaveLength(2);
    act(() => result.current.renameCommute(addedId, '  Cabin  '));
    expect(result.current.commutes.find((item) => item.id === addedId)?.name).toBe('Cabin');
    act(() => result.current.setWidgetCommute(addedId));
    expect(result.current.widgetCommuteId).toBe(addedId);
    act(() => result.current.deleteCommute(addedId));
    expect(result.current.commutes).toHaveLength(1);
    expect(result.current.activeId).toBe('commute');
    expect(result.current.widgetCommuteId).toBe('commute');
  });

  it('fills the first-run placeholder from a plan, then adds later plans by name', async () => {
    const { result } = renderHook(() =>
      useCommute(
        settings(() => Promise.resolve(null)),
        [],
        vi.fn(),
        false,
      ),
    );
    await waitFor(() => expect(result.current.ready).toBe(true));
    const work = {
      ...EMPTY_COMMUTE_CONFIG,
      from: ENGELSRUD,
      to: NATIONALTHEATRET,
    };
    act(() => result.current.saveCommute(work, 'Work'));
    expect(result.current.commutes).toHaveLength(1);
    expect(result.current.commutes[0]).toMatchObject({ name: 'Work', config: work });

    act(() =>
      result.current.saveCommute({ ...work, from: { ...ENGELSRUD, name: 'Cabin' } }, 'Work'),
    );
    expect(result.current.commutes).toHaveLength(2);
    expect(result.current.commutes[1]?.name).toBe('Work (2)');
    expect(result.current.activeId).toBe(result.current.commutes[1]?.id);
  });

  it('marks saved-place use and stale copies across the library', async () => {
    const stored = serializeCommuteLibrary({
      ...EMPTY_COMMUTE_LIBRARY,
      commutes: [
        {
          id: 'commute',
          name: 'Work',
          config: {
            ...EMPTY_COMMUTE_CONFIG,
            from: { name: 'Current', position: { lat: 59.9, lng: 10.7 }, placeId: 'e' },
            to: { name: 'Deleted', position: { lat: 60, lng: 11 }, placeId: 'gone' },
          },
        },
      ],
    });
    const { result } = renderHook(() =>
      useCommute(
        settings(() => Promise.resolve(stored)),
        [saved('e', 'Current')],
        vi.fn(),
        false,
      ),
    );
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.placeCommutes.get('e')).toEqual(['Work']);
    expect(result.current.staleEnds).toEqual([
      { commuteId: 'commute', commuteName: 'Work', end: 'to', placeId: 'gone' },
    ]);
    // The stale coordinate remains usable until the user reconnects it.
    expect(result.current.query?.to.name).toBe('Deleted');
  });

  it('falls back to blaming the timetable when an older backend says nothing', async () => {
    const fetchCommute = vi.fn().mockResolvedValue({
      outbound: { trips: [], problems: [] },
      inbound: { trips: [], problems: [] },
    });
    const { result } = renderHook(() =>
      useCommute(
        settings(() =>
          Promise.resolve(
            serializeCommuteConfig({
              ...EMPTY_COMMUTE_CONFIG,
              from: ENGELSRUD,
              to: NATIONALTHEATRET,
            }),
          ),
        ),
        [],
        fetchCommute,
        true,
      ),
    );
    await waitFor(() => expect(result.current.result).not.toBeNull());
    expect(result.current.emptyReason('outbound')).toBe('upstream');
  });
});
