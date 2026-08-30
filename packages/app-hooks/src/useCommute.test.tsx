import type { PlaceRecord } from '@atlas/storage';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  COMMUTE_COMMIT_SETTING_KEY,
  COMMUTE_SETTING_KEY,
  commuteQueryFrom,
  EMPTY_COMMUTE_CONFIG,
  isLegacyCommuteSetting,
  parseCommuteCommit,
  parseCommuteConfig,
  serializeCommuteConfig,
  useCommute,
  type CommuteSettings,
} from './useCommute.js';

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
      const once = parseCommuteConfig(v1)!;
      const written = serializeCommuteConfig(once);
      expect(parseCommuteConfig(written)).toEqual(once);
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
   * §6.4 §7. The board's commitment lives under `local.`, which never syncs:
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
      expect(setSetting).toHaveBeenCalledWith(COMMUTE_COMMIT_SETTING_KEY, JSON.stringify(commit));
      expect(COMMUTE_COMMIT_SETTING_KEY.startsWith('local.')).toBe(true);
    });

    it('ignores a stored value that is not a commitment', () => {
      expect(parseCommuteCommit(null)).toBeNull();
      expect(parseCommuteCommit('')).toBeNull();
      expect(parseCommuteCommit('not json')).toBeNull();
      expect(parseCommuteCommit('{"direction":"outbound","line":"280"}')).toBeNull();
      expect(parseCommuteCommit(JSON.stringify(commit))).toMatchObject(commit);
    });
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
