import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  parseResumableTrip,
  useNavResume,
  type NavResumeSettings,
  type NavResumeTarget,
} from './useNavResume.js';

const TRIP = 'local.nav.trip';
const OSLO = { lat: 59.9139, lng: 10.7522 };
const BERGEN = { lat: 60.3913, lng: 5.3221 };

function settings(stored: Record<string, string> = {}, status = 'ready'): NavResumeSettings {
  return {
    status,
    getSetting: vi.fn((key: string) => Promise.resolve(stored[key] ?? null)),
    setSetting: vi.fn((key: string, value: string) => {
      stored[key] = value;
    }),
  };
}

function target(overrides: Partial<NavResumeTarget> = {}): NavResumeTarget {
  return {
    phase: 'idle',
    destination: null,
    viaPoints: [],
    viasPassed: 0,
    profile: 'car',
    preferences: null,
    remainingM: null,
    tripProgress: null,
    resume: vi.fn(() => Promise.resolve()),
    ...overrides,
  };
}

/** A trip record as guidance would have written it `ageMs` ago. */
const stored = (ageMs = 0, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    destination: BERGEN,
    vias: [OSLO],
    profile: 'car',
    preferences: { avoidTolls: true },
    remainingM: 12_300,
    progress: { distanceM: 8_500, elapsedMs: 1_800_000, originalEstimateMs: 2_400_000 },
    atMs: Date.now() - ageMs,
    ...extra,
  });

describe('parseResumableTrip', () => {
  const now = Date.now();

  it('reads back what guidance wrote', () => {
    const trip = parseResumableTrip(stored(), now);
    expect(trip?.destination).toEqual(BERGEN);
    expect(trip?.vias).toEqual([OSLO]);
    expect(trip?.preferences).toEqual({ avoidTolls: true });
    expect(trip?.remainingM).toBe(12_300);
    expect(trip?.progress).toEqual({
      distanceM: 8_500,
      elapsedMs: 1_800_000,
      originalEstimateMs: 2_400_000,
    });
  });

  it('drops a trip too old to still be under way', () => {
    expect(parseResumableTrip(stored(4 * 60 * 60 * 1000), now)).toBeNull();
    expect(parseResumableTrip(stored(2 * 60 * 60 * 1000), now)).not.toBeNull();
  });

  it('refuses a record with no usable destination', () => {
    expect(parseResumableTrip(null, now)).toBeNull();
    expect(parseResumableTrip('', now)).toBeNull();
    expect(parseResumableTrip('{ not json', now)).toBeNull();
    expect(parseResumableTrip(JSON.stringify({ atMs: now }), now)).toBeNull();
    expect(
      parseResumableTrip(JSON.stringify({ destination: { lat: 'x', lng: 1 }, atMs: now }), now),
    ).toBeNull();
    expect(
      parseResumableTrip(JSON.stringify({ destination: { lat: NaN, lng: 1 }, atMs: now }), now),
    ).toBeNull();
  });

  it('keeps the trip when only its extras are unusable', () => {
    const trip = parseResumableTrip(
      JSON.stringify({ destination: BERGEN, atMs: now, vias: 'nope', remainingM: 'far' }),
      now,
    );
    expect(trip?.destination).toEqual(BERGEN);
    expect(trip?.vias).toEqual([]);
    expect(trip?.remainingM).toBeNull();
    expect(trip?.profile).toBe('car');
  });

  it('keeps a record dated in the future — the clock moved, the trip is real', () => {
    expect(parseResumableTrip(stored(-60_000), now)).not.toBeNull();
  });
});

describe('useNavResume', () => {
  beforeEach(() => vi.useRealTimers());

  it('offers the interrupted trip once storage is ready', async () => {
    const store = settings({ [TRIP]: stored(60_000) });
    const { result } = renderHook(() => useNavResume(store, target()));

    await waitFor(() => expect(result.current.resumable?.destination).toEqual(BERGEN));
    expect(result.current.resumable?.vias).toEqual([OSLO]);
  });

  it('waits for storage rather than offering nothing', async () => {
    const store = settings({ [TRIP]: stored() }, 'loading');
    const { result } = renderHook(() => useNavResume(store, target()));

    await Promise.resolve();
    expect(store.getSetting).not.toHaveBeenCalled();
    expect(result.current.resumable).toBeNull();
  });

  it('does not offer a trip back to a phone that is already navigating it', async () => {
    const store = settings({ [TRIP]: stored() });
    const nav = target({ phase: 'navigating', destination: BERGEN });
    const { result } = renderHook(() => useNavResume(store, nav));

    await waitFor(() => expect(store.getSetting).toHaveBeenCalled());
    expect(result.current.resumable).toBeNull();
  });

  it('records the live trip, stops still ahead only', async () => {
    const store = settings();
    const nav = target({
      phase: 'navigating',
      destination: BERGEN,
      viaPoints: [OSLO, { lat: 60, lng: 6 }],
      viasPassed: 1,
      remainingM: 12_345,
      tripProgress: { distanceM: 4_000, elapsedMs: 600_000, originalEstimateMs: 900_000 },
      preferences: { avoidTolls: true },
    });
    renderHook(() => useNavResume(store, nav));

    await waitFor(() => expect(store.setSetting).toHaveBeenCalled());
    const [key, value] = vi.mocked(store.setSetting).mock.calls[0]!;
    expect(key).toBe(TRIP);
    const written = JSON.parse(value) as Record<string, unknown>;
    expect(written['destination']).toEqual(BERGEN);
    expect(written['vias']).toEqual([{ lat: 60, lng: 6 }]);
    expect(written['preferences']).toEqual({ avoidTolls: true });
    expect(written['remainingM']).toBe(12_300);
    expect(written['progress']).toEqual({
      distanceM: 4_000,
      elapsedMs: 600_000,
      originalEstimateMs: 900_000,
    });
  });

  it('re-dates the record while the trip runs, without churning on every beat', async () => {
    vi.useFakeTimers();
    const store = settings();
    const nav = target({ phase: 'navigating', destination: BERGEN, remainingM: 5_000 });
    const { rerender } = renderHook(() => useNavResume(store, nav));

    await act(async () => {
      await Promise.resolve();
    });
    expect(store.setSetting).toHaveBeenCalledTimes(1);

    // Same trip, same distance: the beat has nothing new to say.
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    expect(store.setSetting).toHaveBeenCalledTimes(1);

    // Moved along: a new remaining distance re-dates the record.
    nav.remainingM = 3_000;
    rerender();
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    expect(store.setSetting).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('clears the record when the trip ends', async () => {
    const store = settings();
    const nav = target({ phase: 'navigating', destination: BERGEN });
    const { rerender } = renderHook(() => useNavResume(store, nav));
    await waitFor(() => expect(store.setSetting).toHaveBeenCalledTimes(1));

    nav.phase = 'arrived';
    rerender();
    expect(store.setSetting).toHaveBeenLastCalledWith(TRIP, '');
  });

  it('keeps a deliberately paused trip resumable instead of clearing it', async () => {
    const store = settings();
    const nav = target({ phase: 'navigating', destination: BERGEN });
    const { rerender } = renderHook(() => useNavResume(store, nav));
    await waitFor(() => expect(store.setSetting).toHaveBeenCalledTimes(1));

    nav.phase = 'paused';
    rerender();

    expect(store.setSetting).not.toHaveBeenCalledWith(TRIP, '');
  });

  it('keeps the record when the app goes away mid-trip', async () => {
    const store = settings();
    const nav = target({ phase: 'navigating', destination: BERGEN });
    const { unmount } = renderHook(() => useNavResume(store, nav));
    await waitFor(() => expect(store.setSetting).toHaveBeenCalledTimes(1));

    unmount();
    expect(store.setSetting).toHaveBeenCalledTimes(1);
  });

  it('resumes with the stops, mode and preferences the trip had', async () => {
    const store = settings({ [TRIP]: stored() });
    const nav = target();
    const { result } = renderHook(() => useNavResume(store, nav));
    await waitFor(() => expect(result.current.resumable).not.toBeNull());

    act(() => result.current.resume());
    expect(nav.resume).toHaveBeenCalledWith(BERGEN, 'car', { avoidTolls: true }, [OSLO], {
      distanceM: 8_500,
      elapsedMs: 1_800_000,
      originalEstimateMs: 2_400_000,
    });
    expect(result.current.resumable).toBeNull();
  });

  it('drops the record when the offer is declined', async () => {
    const store = settings({ [TRIP]: stored() });
    const { result } = renderHook(() => useNavResume(store, target()));
    await waitFor(() => expect(result.current.resumable).not.toBeNull());

    act(() => result.current.dismiss());
    expect(result.current.resumable).toBeNull();
    expect(store.setSetting).toHaveBeenCalledWith(TRIP, '');
  });

  it('never clears a record it has not read yet', async () => {
    const store = settings({ [TRIP]: stored() }, 'loading');
    const { result } = renderHook(() => useNavResume(store, target()));

    act(() => result.current.dismiss());
    expect(store.setSetting).not.toHaveBeenCalled();
  });
});
