import type { LatLng } from '@atlas/core';
import type { Position } from '@atlas/navigation';
import type { RoutePath, RouteQuery, RouteResult } from '@atlas/routing';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useNavigationController, type NavPlatform } from './useNavigationController.js';

/** A straight eastward route at lat 60: 21 points, lng 10.000 → 10.020 (~1.1 km). */
const points = Array.from({ length: 21 }, (_, i) => ({ lat: 60, lng: 10 + i * 0.001 }));
const destination: LatLng = points[20]!;

function path(timeMs: number, lngOffset = 0): RoutePath {
  return {
    points: points.map((p) => ({ ...p, lng: p.lng + lngOffset })),
    distanceM: 1113,
    timeMs,
    ascentM: 0,
    descentM: 0,
    instructions: [
      {
        text: 'Head east',
        distanceM: 1113,
        timeMs,
        sign: 0,
        streetName: 'Main',
        interval: [0, 20],
      },
      { text: 'Arrive', distanceM: 0, timeMs: 0, sign: 4, interval: [20, 20] },
    ],
  };
}

/** A visibly distinct choice that leaves and rejoins the main eastward road. */
function branchPath(timeMs: number, latOffset = 0.002): RoutePath {
  const result = path(timeMs);
  return {
    ...result,
    points: result.points.map((point, index) => ({
      ...point,
      lat: point.lat + Math.sin((Math.PI * index) / (result.points.length - 1)) * latOffset,
    })),
  };
}

/** A fix on the line, `index` points along it. */
const onLine = (index: number, extra: Partial<Position> = {}): Position => ({
  ...points[index]!,
  accuracyM: 5,
  ...extra,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

interface Harness {
  platform: NavPlatform;
  spoken: string[];
  /** Feed a fix to whatever the controller is currently watching. */
  emit: (fix: Position, measuredAtMs?: number) => void;
  route: ReturnType<typeof vi.fn>;
  currentFix: ReturnType<typeof vi.fn>;
  watchStopped: () => number;
  watchActivities: Array<'guidance' | 'explorer' | undefined>;
}

function harness(
  routeImpl?: (query: RouteQuery) => Promise<RouteResult>,
  overrides: Partial<NavPlatform> = {},
): Harness {
  const spoken: string[] = [];
  let sink: ((fix: Position, measuredAtMs?: number) => void) | null = null;
  let stopped = 0;
  const watchActivities: Array<'guidance' | 'explorer' | undefined> = [];
  const route = vi.fn(
    routeImpl ?? (() => Promise.resolve({ paths: [path(600_000), path(900_000, 0.0001)] })),
  );
  const currentFix = vi.fn(() =>
    Promise.resolve({ fix: onLine(0, { speedMps: 0 }), atMs: Date.now() }),
  );
  const platform: NavPlatform = {
    provider: { route: route as unknown as NavPlatform['provider']['route'] },
    currentFix: currentFix as unknown as NavPlatform['currentFix'],
    watchFixes: (onFix, activity) => {
      watchActivities.push(activity);
      sink = onFix;
      return Promise.resolve(() => {
        stopped++;
        sink = null;
      });
    },
    speak: (text) => spoken.push(text),
    stopSpeaking: vi.fn(),
    ...overrides,
  };
  return {
    platform,
    spoken,
    emit: (fix, measuredAtMs) => sink?.(fix, measuredAtMs),
    route,
    currentFix,
    watchStopped: () => stopped,
    watchActivities,
  };
}

/** Start a trip and begin guidance — the setup most cases share. */
async function drive(h: Harness) {
  const hook = renderHook(() => useNavigationController(h.platform));
  await act(() => hook.result.current.start(destination));
  expect(hook.result.current.phase).toBe('preview');
  await act(() => hook.result.current.go());
  await waitFor(() => expect(hook.result.current.phase).toBe('navigating'));
  return hook;
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

// Vitest APIs are imported rather than installed as globals in this project,
// so Testing Library cannot register its implicit global afterEach cleanup.
// Navigation hooks own real intervals and must be unmounted explicitly before
// jsdom tears down `window`.
afterEach(() => {
  cleanup();
});

describe('useNavigationController — public command contract', () => {
  it('keeps trip-only commands inert while idle', async () => {
    const h = harness();
    const { result } = renderHook(() => useNavigationController(h.platform));

    await act(async () => {
      result.current.selectPreview(1);
      result.current.setProfile('hike');
      await result.current.go();
      result.current.pause();
      await result.current.continueTrip();
      result.current.arriveNow();
      result.current.rerouteNow();
      result.current.addStop(points[10]!);
      result.current.continuePastIntermediateStop();
      result.current.acceptFasterRoute();
      result.current.dismissFasterRoute();
    });

    expect(result.current.phase).toBe('idle');
    expect(result.current.activity).toBeNull();
    expect(result.current.previewIndex).toBe(0);
    expect(result.current.destination).toBeNull();
    expect(result.current.activePath).toBeNull();
    expect(h.currentFix).not.toHaveBeenCalled();
    expect(h.route).not.toHaveBeenCalled();
    expect(h.watchActivities).toEqual([]);
  });

  it('lets End consistently release preview, Explorer, guidance, arrival and error', async () => {
    const h = harness();
    const hook = renderHook(() => useNavigationController(h.platform));

    await act(() => hook.result.current.start(destination));
    expect(hook.result.current.phase).toBe('preview');
    act(() => hook.result.current.stop());
    expect(hook.result.current.phase).toBe('idle');

    await act(() => hook.result.current.explore('hike'));
    expect(hook.result.current.phase).toBe('exploring');
    act(() => hook.result.current.stop());
    expect(hook.result.current.phase).toBe('idle');

    await act(() => hook.result.current.start(destination));
    await act(() => hook.result.current.go());
    expect(hook.result.current.phase).toBe('navigating');
    act(() => hook.result.current.arriveNow());
    expect(hook.result.current.phase).toBe('arrived');
    act(() => hook.result.current.stop());
    expect(hook.result.current.phase).toBe('idle');

    h.currentFix.mockRejectedValueOnce(new Error('location denied'));
    await act(() => hook.result.current.start(destination));
    expect(hook.result.current.phase).toBe('error');
    act(() => hook.result.current.stop());

    expect(hook.result.current.phase).toBe('idle');
    expect(hook.result.current.activity).toBeNull();
    expect(hook.result.current.destination).toBeNull();
    expect(hook.result.current.position).toBeNull();
    expect(hook.result.current.activePath).toBeNull();
  });
});

describe('useNavigationController — preview', () => {
  it('requests route detail for hike elevation guidance only', async () => {
    const hike = harness();
    const hikeHook = renderHook(() => useNavigationController(hike.platform));
    await act(() => hikeHook.result.current.start(destination, 'hike'));
    expect(hike.route).toHaveBeenCalledWith(expect.objectContaining({ details: true }));
    hikeHook.unmount();

    const drive = harness();
    const driveHook = renderHook(() => useNavigationController(drive.platform));
    await act(() => driveHook.result.current.start(destination, 'car'));
    expect(drive.route).toHaveBeenCalledWith(expect.objectContaining({ details: false }));
  });

  it('offers the choices fastest first and enters the preview phase', async () => {
    const h = harness(() => Promise.resolve({ paths: [path(900_000), path(600_000, 0.0001)] }));
    const { result } = renderHook(() => useNavigationController(h.platform));

    await act(() => result.current.start(destination));

    expect(result.current.phase).toBe('preview');
    expect(result.current.previewPaths?.map((p) => p.timeMs)).toEqual([600_000, 900_000]);
    expect(result.current.previewIndex).toBe(0);
    expect(result.current.destination).toEqual(destination);
  });

  it('follows the selected preview choice and ignores invalid selections', async () => {
    const h = harness(() => Promise.resolve({ paths: [path(900_000), path(600_000, 0.0001)] }));
    const { result } = renderHook(() => useNavigationController(h.platform));
    await act(() => result.current.start(destination));

    act(() => {
      result.current.selectPreview(-1);
      result.current.selectPreview(20);
      result.current.selectPreview(1);
    });
    expect(result.current.previewIndex).toBe(1);

    await act(() => result.current.go());
    await waitFor(() => expect(result.current.phase).toBe('navigating'));
    expect(result.current.activePath?.timeMs).toBe(900_000);
  });

  it('surfaces a fix failure as the error phase, keeping its message', async () => {
    const h = harness();
    h.currentFix.mockRejectedValueOnce(new Error('Could not get a GPS fix — is location on?'));
    const { result } = renderHook(() => useNavigationController(h.platform));

    await act(() => result.current.start(destination));

    expect(result.current.phase).toBe('error');
    expect(result.current.error).toBe('Could not get a GPS fix — is location on?');
    expect(result.current.destination).toBeNull();
  });

  it('ignores a second start while the first is still in flight', async () => {
    const h = harness();
    const { result } = renderHook(() => useNavigationController(h.platform));

    await act(async () => {
      const first = result.current.start(destination);
      const second = result.current.start(destination);
      await Promise.all([first, second]);
    });

    expect(h.currentFix).toHaveBeenCalledTimes(1);
  });

  it('keeps the old choices when a profile switch finds no route', async () => {
    const h = harness();
    const { result } = renderHook(() => useNavigationController(h.platform));
    await act(() => result.current.start(destination));
    const offered = result.current.previewPaths;

    h.route.mockRejectedValueOnce(new Error('no route found'));
    await act(async () => {
      result.current.setProfile('bike');
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.previewError).toBe('no route found'));
    expect(result.current.profile).toBe('car');
    expect(result.current.previewPaths).toBe(offered);
    expect(result.current.previewLoading).toBe(false);
  });

  it('keeps the latest profile when an older switch resolves last', async () => {
    const h = harness();
    const { result } = renderHook(() => useNavigationController(h.platform));
    await act(() => result.current.start(destination));
    const bike = deferred<RouteResult>();
    const hike = deferred<RouteResult>();
    h.route.mockReturnValueOnce(bike.promise).mockReturnValueOnce(hike.promise);

    act(() => {
      result.current.setProfile('bike');
      result.current.setProfile('hike');
    });
    expect(h.route).toHaveBeenCalledTimes(3);

    await act(async () => {
      hike.resolve({ paths: [path(400_000, 0.004)] });
      await hike.promise;
    });
    await waitFor(() => expect(result.current.profile).toBe('hike'));
    expect(result.current.previewPaths?.[0]?.timeMs).toBe(400_000);

    await act(async () => {
      bike.resolve({ paths: [path(200_000, 0.002)] });
      await bike.promise;
    });
    expect(result.current.profile).toBe('hike');
    expect(result.current.previewPaths?.[0]?.timeMs).toBe(400_000);
  });

  it('lets End invalidate a route response that has not landed yet', async () => {
    const route = deferred<RouteResult>();
    const h = harness(() => route.promise);
    const { result } = renderHook(() => useNavigationController(h.platform));
    let starting!: Promise<void>;

    act(() => {
      starting = result.current.start(destination);
    });
    await waitFor(() => expect(h.route).toHaveBeenCalledTimes(1));
    act(() => result.current.stop());
    expect(result.current.phase).toBe('idle');

    await act(async () => {
      route.resolve({ paths: [path(600_000)] });
      await starting;
    });

    expect(result.current.phase).toBe('idle');
    expect(result.current.previewPaths).toBeNull();
    expect(result.current.destination).toBeNull();
  });
});

describe('useNavigationController — guidance', () => {
  it('starts the watch, speaks the departure and shows a state at once', async () => {
    const h = harness();
    const { result } = await drive(h);

    expect(result.current.routeCoords).toHaveLength(21);
    expect(result.current.previewPaths).toBeNull();
    expect(h.spoken.length).toBeGreaterThan(0);
    // Seeded from the origin fix rather than waiting for the watch's first one.
    expect(result.current.state).not.toBeNull();
  });

  it('keeps Google-style alternatives available during a drive and switches on tap', async () => {
    const h = harness(() => Promise.resolve({ paths: [path(600_000), branchPath(900_000)] }));
    const hook = await drive(h);

    expect(hook.result.current.routeAlternatives).toHaveLength(1);
    expect(hook.result.current.routeAlternatives[0]).toMatchObject({ deltaMs: 300_000 });
    act(() => h.emit(onLine(5, { speedMps: 15 })));
    const distanceBefore = hook.result.current.tripProgress?.distanceM ?? 0;

    act(() => hook.result.current.selectRouteAlternative(0));

    expect(hook.result.current.activePath?.timeMs).toBe(900_000);
    expect(hook.result.current.phase).toBe('navigating');
    expect(hook.result.current.routeAlternatives).toEqual([]);
    expect(hook.result.current.tripProgress?.distanceM ?? 0).toBeCloseTo(distanceBefore, -1);
  });

  it('starts only one owned watch when Go is tapped twice', async () => {
    const watchFixes = vi.fn<NavPlatform['watchFixes']>(() => Promise.resolve(() => undefined));
    const h = harness(undefined, { watchFixes });
    const { result } = renderHook(() => useNavigationController(h.platform));
    await act(() => result.current.start(destination));

    await act(async () => {
      const first = result.current.go();
      const second = result.current.go();
      await Promise.all([first, second]);
    });

    expect(result.current.phase).toBe('navigating');
    expect(watchFixes).toHaveBeenCalledTimes(1);
  });

  it('releases a watch that finishes starting after End', async () => {
    const watch = deferred<() => void>();
    const release = vi.fn();
    const watchFixes = vi.fn<NavPlatform['watchFixes']>(() => watch.promise);
    const h = harness(undefined, { watchFixes });
    const { result } = renderHook(() => useNavigationController(h.platform));
    await act(() => result.current.start(destination));
    let going!: Promise<void>;

    act(() => {
      going = result.current.go();
    });
    await waitFor(() => expect(watchFixes).toHaveBeenCalledTimes(1));
    act(() => result.current.stop());
    expect(result.current.phase).toBe('idle');

    await act(async () => {
      watch.resolve(release);
      await going;
    });

    expect(release).toHaveBeenCalledTimes(1);
    expect(result.current.phase).toBe('idle');
    expect(result.current.activePath).toBeNull();
  });

  it('rejects a queued fix from a watch owned by the previous trip', async () => {
    const sinks: Array<(fix: Position, measuredAtMs?: number) => void> = [];
    const releases = [vi.fn(), vi.fn()];
    const watchFixes = vi.fn<NavPlatform['watchFixes']>((onFix) => {
      const index = sinks.push(onFix) - 1;
      return Promise.resolve(releases[index]!);
    });
    const h = harness(undefined, { watchFixes });
    const { result } = await drive(h);
    expect(sinks).toHaveLength(1);

    // A new preview takes ownership immediately, then its own watch becomes
    // the only stream allowed to feed the new NavigationSession.
    await act(() => result.current.start(destination));
    expect(releases[0]).toHaveBeenCalledTimes(1);
    await act(() => result.current.go());
    await waitFor(() => expect(result.current.phase).toBe('navigating'));
    expect(sinks).toHaveLength(2);
    const ownedPosition = result.current.position;
    const ownedState = result.current.state;

    act(() => sinks[0]!(onLine(15, { speedMps: 15 }), Date.now() + 10_000));

    expect(result.current.position).toEqual(ownedPosition);
    expect(result.current.state).toEqual(ownedState);
    expect(result.current.activePath?.timeMs).toBe(600_000);
  });

  it('shows signal loss at the measured origin when a started watch emits no fixes', async () => {
    vi.useFakeTimers();
    const h = harness();
    const origin = onLine(0, { speedMps: 9.51 });
    h.currentFix.mockImplementation(() => Promise.resolve({ fix: origin, atMs: Date.now() }));
    const hook = renderHook(() => useNavigationController(h.platform));
    try {
      await act(() => hook.result.current.start(destination));
      await act(() => hook.result.current.go());
      expect(hook.result.current.phase).toBe('navigating');
      expect(hook.result.current.state?.fix).toBe('live');

      await act(async () => {
        await vi.advanceTimersByTimeAsync(11_000);
      });

      expect(hook.result.current.state?.fix).toBe('lost');
      expect(hook.result.current.state?.raw).toEqual({ lat: origin.lat, lng: origin.lng });
      expect(hook.result.current.state?.snapped).toEqual({ lat: origin.lat, lng: origin.lng });
      expect(hook.result.current.state?.traveledM).toBeCloseTo(0, 0);
      expect(hook.result.current.position).toEqual(origin);
    } finally {
      hook.unmount();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('does not let a delayed background batch rewind a newer measured fix', async () => {
    const h = harness();
    const hook = await drive(h);
    const newer = onLine(5, { speedMps: 10 });
    const delayed = onLine(2, { speedMps: 10 });
    const base = Date.now() + 1_000;

    act(() => h.emit(newer, base + 1_000));
    act(() => h.emit(delayed, base));

    expect(hook.result.current.position).toEqual(newer);
    expect(hook.result.current.state?.raw).toEqual({ lat: newer.lat, lng: newer.lng });
  });

  it('re-reads the position at Start, so a wait in the preview does not misplace the trip', async () => {
    const h = harness();
    await drive(h);

    // Once for the preview, once when guidance actually begins.
    expect(h.currentFix).toHaveBeenCalledTimes(2);
  });

  it('navigates on the previewed path when the Start-time refresh fails', async () => {
    const h = harness();
    const hook = renderHook(() => useNavigationController(h.platform));
    await act(() => hook.result.current.start(destination));
    const previewed = hook.result.current.previewPaths?.[0];

    h.currentFix.mockRejectedValueOnce(new Error('position unavailable'));
    await act(() => hook.result.current.go());

    await waitFor(() => expect(hook.result.current.phase).toBe('navigating'));
    expect(hook.result.current.activePath).toBe(previewed);
  });

  it('says nothing while muted', async () => {
    const h = harness();
    const hook = renderHook(() => useNavigationController(h.platform));
    act(() => hook.result.current.setMuted(true));
    await act(() => hook.result.current.start(destination));
    await act(() => hook.result.current.go());

    await waitFor(() => expect(hook.result.current.phase).toBe('navigating'));
    expect(h.spoken).toEqual([]);
    expect(h.platform.stopSpeaking).toHaveBeenCalled();
  });

  it('toggles mute without changing trip ownership or phase', async () => {
    const h = harness();
    const { result } = await drive(h);

    act(() => result.current.toggleMute());
    expect(result.current.muted).toBe(true);
    expect(result.current.phase).toBe('navigating');
    expect(h.watchStopped()).toBe(0);

    act(() => result.current.toggleMute());
    expect(result.current.muted).toBe(false);
    expect(result.current.phase).toBe('navigating');
    expect(h.watchStopped()).toBe(0);
  });

  it('pauses fixes, guidance and elapsed time, then resumes the same route', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-05T12:00:00Z'));
    const h = harness();
    const hook = renderHook(() => useNavigationController(h.platform));
    try {
      await act(() => hook.result.current.start(destination));
      await act(() => hook.result.current.go());
      expect(hook.result.current.phase).toBe('navigating');
      act(() => h.emit(onLine(5, { speedMps: 8 }), Date.now()));
      const beforePauseM = hook.result.current.tripProgress!.distanceM;

      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      act(() => hook.result.current.pause());

      expect(hook.result.current.phase).toBe('paused');
      expect(h.watchStopped()).toBe(1);
      expect(h.platform.stopSpeaking).toHaveBeenCalled();
      expect(hook.result.current.routeCoords).toHaveLength(21);
      expect(hook.result.current.tripProgress?.elapsedMs).toBe(60_000);

      // The old native watch cannot move the trip after Pause, even if a
      // final sample was already queued at its boundary.
      act(() => h.emit(onLine(10, { speedMps: 8 }), Date.now()));
      expect(hook.result.current.tripProgress?.distanceM).toBeCloseTo(beforePauseM, 0);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5 * 60_000);
      });
      h.currentFix.mockResolvedValueOnce({ fix: onLine(10, { speedMps: 0 }), atMs: Date.now() });
      await act(() => hook.result.current.continueTrip());

      expect(hook.result.current.phase).toBe('navigating');
      expect(h.watchActivities).toEqual(['guidance', 'guidance']);
      // Moving while paused re-anchors the puck, but is not trip distance.
      expect(hook.result.current.state?.traveledM).toBeGreaterThan(beforePauseM);
      expect(hook.result.current.tripProgress?.distanceM).toBeCloseTo(beforePauseM, 0);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2 * 60_000);
      });
      act(() => h.emit(onLine(12, { speedMps: 8 }), Date.now()));
      act(() => hook.result.current.arriveNow());

      expect(hook.result.current.tripSummary).toMatchObject({
        durationMs: 3 * 60_000,
        originalEstimateMs: 600_000,
      });
      expect(hook.result.current.tripSummary!.distanceM).toBeGreaterThan(beforePauseM);
    } finally {
      hook.unmount();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('starts only one replacement watch when Continue is tapped twice', async () => {
    const h = harness();
    const hook = await drive(h);
    act(() => hook.result.current.pause());
    expect(hook.result.current.phase).toBe('paused');

    await act(async () => {
      const first = hook.result.current.continueTrip();
      const second = hook.result.current.continueTrip();
      await Promise.all([first, second]);
    });

    expect(hook.result.current.phase).toBe('navigating');
    expect(h.currentFix).toHaveBeenCalledTimes(3);
    expect(h.watchActivities).toEqual(['guidance', 'guidance']);
  });

  it('ends as arrived with a distance/time summary, keeping the watch until Done', async () => {
    const h = harness();
    const { result } = await drive(h);

    act(() => h.emit(onLine(20, { speedMps: 0 })));

    await waitFor(() => expect(result.current.phase).toBe('arrived'));
    expect(result.current.tripSummary).not.toBeNull();
    expect(result.current.tripSummary!.distanceM).toBeGreaterThan(0);
    expect(result.current.tripSummary!.originalEstimateMs).toBe(600_000);
    expect(result.current.destination).toEqual(destination);
    // The last stretch to the door is walked with the arrival card up, so the
    // fixes keep coming — and keep moving the position — until Done.
    expect(h.watchStopped()).toBe(0);
    const arrivedAt = result.current.state!.snapped;
    // Walking away from the kerb to the door: well off the line, so the puck
    // shows the fix itself rather than staying glued to where the trip ended.
    act(() => h.emit({ lat: 60.0006, lng: 10.02, accuracyM: 5, speedMps: 1 }));
    expect(result.current.state!.snapped).not.toEqual(arrivedAt);
    expect(result.current.phase).toBe('arrived');
    // …and arrival is announced and summarised exactly once, not per fix.
    expect(h.spoken.filter((t) => /arriv/i.test(t))).toHaveLength(1);

    act(() => result.current.stop());
    expect(h.watchStopped()).toBe(1);
  });

  it('ends as arrived on the traveller’s say-so', async () => {
    const h = harness();
    const { result } = await drive(h);

    act(() => result.current.arriveNow());

    expect(result.current.phase).toBe('arrived');
    expect(result.current.tripSummary).not.toBeNull();
  });

  it('drops the watch when the app unmounts mid-trip', async () => {
    const h = harness();
    const hook = await drive(h);

    hook.unmount();

    expect(h.watchStopped()).toBe(1);
  });
});

describe('useNavigationController — Explorer mode', () => {
  it('follows raw fixes without requesting a route or creating guidance state', async () => {
    const h = harness();
    const { result } = renderHook(() => useNavigationController(h.platform));

    await act(() => result.current.explore('hike'));

    expect(result.current.phase).toBe('exploring');
    expect(result.current.activity).toBe('explorer');
    expect(result.current.profile).toBe('hike');
    expect(result.current.position).toEqual(onLine(0, { speedMps: 0 }));
    expect(result.current.state).toBeNull();
    expect(result.current.destination).toBeNull();
    expect(result.current.routeCoords).toEqual([]);
    expect(h.route).not.toHaveBeenCalled();
    expect(h.spoken).toEqual([]);
    expect(h.watchActivities).toEqual(['explorer']);

    const next = onLine(4, { speedMps: 1.4, altitudeM: 312, headingDeg: 85 });
    act(() => h.emit(next));
    expect(result.current.position).toEqual(next);
    expect(result.current.speedMps).toBe(1.4);
    expect(result.current.altitudeM).toBe(312);

    act(() => result.current.stop());
    expect(result.current.phase).toBe('idle');
    expect(result.current.position).toBeNull();
    expect(h.watchStopped()).toBe(1);
  });

  it('keeps Explorer identity on a location-permission error', async () => {
    const h = harness();
    h.currentFix.mockRejectedValueOnce(new Error('Location permission is required'));
    const { result } = renderHook(() => useNavigationController(h.platform));

    await act(() => result.current.explore('bike'));

    expect(result.current.phase).toBe('error');
    expect(result.current.activity).toBe('explorer');
    expect(result.current.error).toBe('Location permission is required');
    expect(h.route).not.toHaveBeenCalled();
  });

  it('releases Explorer before previewing and starts a fresh guidance watch', async () => {
    const h = harness();
    const { result } = renderHook(() => useNavigationController(h.platform));
    await act(() => result.current.explore('car'));

    await act(() => result.current.start(destination));
    expect(result.current.phase).toBe('preview');
    expect(h.watchStopped()).toBe(1);

    await act(() => result.current.go());
    await waitFor(() => expect(result.current.phase).toBe('navigating'));
    expect(h.watchActivities).toEqual(['explorer', 'guidance']);
  });
});

/** Three consecutive fixes well off the line — the session's off-route grace. */
function goOffRoute(h: Harness) {
  for (let i = 0; i < 3; i++) {
    act(() => h.emit({ lat: 60.01, lng: 10.005 + i * 0.0001, accuracyM: 5, speedMps: 15 }));
  }
}

describe('useNavigationController — rerouting', () => {
  it('uses a heading constraint only once the fix is at driving speed', async () => {
    const h = harness();
    const { result } = await drive(h);

    act(() => h.emit(onLine(4, { speedMps: 2.3, headingDeg: 270 })));
    const beforeSlow = h.route.mock.calls.length;
    act(() => result.current.rerouteNow());
    await waitFor(() => expect(h.route.mock.calls.length).toBe(beforeSlow + 1));
    expect((h.route.mock.calls.at(-1)![0] as RouteQuery).headingDeg).toBeUndefined();
    await waitFor(() => expect(result.current.phase).toBe('navigating'));

    act(() => h.emit(onLine(5, { speedMps: 6, headingDeg: 90 })));
    const beforeFast = h.route.mock.calls.length;
    act(() => result.current.rerouteNow());
    await waitFor(() => expect(h.route.mock.calls.length).toBe(beforeFast + 1));
    expect((h.route.mock.calls.at(-1)![0] as RouteQuery).headingDeg).toBe(90);
  });

  it('keeps planner preferences through preview, Start refresh and rerouting', async () => {
    const h = harness();
    const hook = renderHook(() => useNavigationController(h.platform));
    const preferences = { avoidTolls: true, avoidHighways: true };

    await act(() => hook.result.current.start(destination, 'car', preferences));
    await act(() => hook.result.current.go());
    await waitFor(() => expect(hook.result.current.phase).toBe('navigating'));
    h.route.mockResolvedValueOnce({ paths: [path(300_000, 0.002)] });

    goOffRoute(h);

    await waitFor(() => expect(hook.result.current.activePath?.timeMs).toBe(300_000));
    // The successful reroute is immediately followed by a better-route probe.
    expect(h.route.mock.calls).toHaveLength(4);
    for (const [query] of h.route.mock.calls) {
      expect(query).toMatchObject({ profile: 'car', preferences });
    }
  });

  it('replaces the followed path when the traveller leaves the line', async () => {
    const h = harness();
    const { result } = await drive(h);
    const original = result.current.activePath;
    h.route.mockResolvedValueOnce({ paths: [path(300_000, 0.002)] });

    goOffRoute(h);

    await waitFor(() => expect(result.current.activePath).not.toBe(original));
    expect(result.current.phase).toBe('navigating');
    expect(result.current.rerouteFailed).toBe(false);
  });

  it('backs off after a failed reroute instead of retrying on every fix', async () => {
    const h = harness();
    const { result } = await drive(h);
    const callsBefore = h.route.mock.calls.length;
    h.route.mockRejectedValue(new Error('routing unreachable'));

    goOffRoute(h);
    await waitFor(() => expect(result.current.rerouteFailed).toBe(true));
    // Still off route, but inside the backoff window: no second attempt.
    act(() => h.emit({ lat: 60.01, lng: 10.006, accuracyM: 5, speedMps: 15 }));

    expect(h.route.mock.calls.length).toBe(callsBefore + 1);
    expect(result.current.phase).toBe('navigating');
  });

  it('clears a stale reroute failure once back on the line', async () => {
    const h = harness();
    const { result } = await drive(h);
    h.route.mockRejectedValue(new Error('routing unreachable'));
    goOffRoute(h);
    await waitFor(() => expect(result.current.rerouteFailed).toBe(true));

    act(() => h.emit(onLine(5, { speedMps: 15 })));

    expect(result.current.rerouteFailed).toBe(false);
  });

  it('lets a reroute that lands after End touch nothing', async () => {
    const h = harness();
    const { result } = await drive(h);
    let land: (result: RouteResult) => void = () => undefined;
    h.route.mockReturnValueOnce(
      new Promise<RouteResult>((resolve) => {
        land = resolve;
      }),
    );

    goOffRoute(h);
    await waitFor(() => expect(result.current.phase).toBe('rerouting'));
    act(() => result.current.stop());
    expect(result.current.phase).toBe('idle');

    await act(async () => {
      land({ paths: [path(300_000, 0.002)] });
      await Promise.resolve();
    });

    // The old trip's answer must not resurrect the nav UI.
    expect(result.current.phase).toBe('idle');
    expect(result.current.activePath).toBeNull();
    expect(result.current.destination).toBeNull();
  });

  it('never lets an abandoned trip’s reroute become the next trip’s route', async () => {
    // The race the merge exists to close: End during a reroute, then a fresh
    // trip. The abandoned request is still out, and the flags it used to test
    // (in-flight, destination set) are all true again for the *new* trip — so
    // its answer, computed for a destination nobody is driving to any more,
    // used to be installed as the live route.
    const h = harness();
    const { result } = await drive(h);
    let land: (result: RouteResult) => void = () => undefined;
    h.route.mockReturnValueOnce(
      new Promise<RouteResult>((resolve) => {
        land = resolve;
      }),
    );

    goOffRoute(h);
    await waitFor(() => expect(result.current.phase).toBe('rerouting'));
    act(() => result.current.stop());

    // A whole new trip, running normally.
    await act(() => result.current.start({ lat: 60, lng: 10.03 }));
    await act(() => result.current.go());
    await waitFor(() => expect(result.current.phase).toBe('navigating'));
    const live = result.current.activePath;
    // …which is itself off route when the abandoned answer finally lands.
    h.route.mockReturnValueOnce(new Promise<RouteResult>(() => undefined));
    goOffRoute(h);
    await waitFor(() => expect(result.current.phase).toBe('rerouting'));

    const stale = path(300_000, 0.05);
    await act(async () => {
      land({ paths: [stale] });
      await Promise.resolve();
    });

    expect(result.current.activePath).toBe(live);
    expect(result.current.phase).toBe('rerouting');
  });
});

/** The `path()` route with a via stop at index 10 (a multi-stop plan). */
function viaPath(timeMs: number): RoutePath {
  return {
    points,
    distanceM: 1113,
    timeMs,
    ascentM: 0,
    descentM: 0,
    instructions: [
      {
        text: 'Head east',
        distanceM: 556,
        timeMs: timeMs / 2,
        sign: 0,
        streetName: 'Main',
        interval: [0, 10],
      },
      { text: 'Arrive at via point', distanceM: 0, timeMs: 0, sign: 5, interval: [10, 10] },
      {
        text: 'Continue east',
        distanceM: 557,
        timeMs: timeMs / 2,
        sign: 0,
        streetName: 'Main',
        interval: [10, 20],
      },
      { text: 'Arrive', distanceM: 0, timeMs: 0, sign: 4, interval: [20, 20] },
    ],
  };
}

describe('useNavigationController — speed cameras', () => {
  it('fetches cameras for a car route and surfaces the approach state', async () => {
    const nvdbCameras = vi.fn(() =>
      Promise.resolve({ points: [{ atM: 800, name: 'ATK' }], sections: [] }),
    );
    const h = harness(undefined, { nvdbCameras });
    const hook = await drive(h);
    await waitFor(() => expect(nvdbCameras).toHaveBeenCalled());

    act(() => h.emit(onLine(1, { speedMps: 15, headingDeg: 90 })));
    await waitFor(() => expect(hook.result.current.state?.speedCamera).not.toBeNull());
    const camera = hook.result.current.state!.speedCamera!;
    expect(camera.name).toBe('ATK');
    expect(camera.distanceM).toBeGreaterThan(600);
    expect(camera.distanceM).toBeLessThan(800);
  });

  it('never asks for cameras on a walking trip', async () => {
    const nvdbCameras = vi.fn(() => Promise.resolve({ points: [], sections: [] }));
    const h = harness(undefined, { nvdbCameras, trace: () => Promise.resolve({}) });
    const hook = renderHook(() => useNavigationController(h.platform));
    await act(() => hook.result.current.start(destination, 'foot'));
    await act(() => hook.result.current.go());
    await waitFor(() => expect(hook.result.current.phase).toBe('navigating'));
    expect(nvdbCameras).not.toHaveBeenCalled();
  });

  it('keeps navigating when the camera request fails', async () => {
    const nvdbCameras = vi.fn(() => Promise.reject(new Error('offline')));
    const h = harness(undefined, { nvdbCameras });
    const hook = await drive(h);
    act(() => h.emit(onLine(1, { speedMps: 15, headingDeg: 90 })));
    expect(hook.result.current.phase).toBe('navigating');
    expect(hook.result.current.state?.speedCamera ?? null).toBeNull();
  });
});

describe('useNavigationController — via stops', () => {
  it('routes every request through the vias, in order, and exposes them', async () => {
    const vias = [points[7]!, points[13]!];
    const h = harness(() => Promise.resolve({ paths: [viaPath(600_000)] }));
    const hook = renderHook(() => useNavigationController(h.platform));

    await act(() => hook.result.current.start(destination, 'car', undefined, vias));
    expect(hook.result.current.phase).toBe('preview');
    expect(hook.result.current.viaPoints).toEqual(vias);

    await act(() => hook.result.current.go());
    await waitFor(() => expect(hook.result.current.phase).toBe('navigating'));

    // Both the preview query and Start's position refresh carry the stops.
    expect(h.route.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const [query] of h.route.mock.calls) {
      expect(query.points).toHaveLength(4);
      expect(query.points.slice(1)).toEqual([...vias, destination]);
    }
  });

  it('reroutes only through the stops still ahead, dropping passed vias', async () => {
    const h = harness(() => Promise.resolve({ paths: [viaPath(600_000)] }));
    const hook = renderHook(() => useNavigationController(h.platform));
    await act(() => hook.result.current.start(destination, 'car', undefined, [points[10]!]));
    await act(() => hook.result.current.go());
    await waitFor(() => expect(hook.result.current.phase).toBe('navigating'));

    // Drive past the via stop…
    act(() => h.emit(onLine(12, { speedMps: 15 })));
    expect(hook.result.current.state?.viasPassed).toBe(1);

    // …then leave the line beyond it. The recalculated route must go straight
    // to the destination instead of doubling back to the visited stop.
    const callsBefore = h.route.mock.calls.length;
    for (let i = 0; i < 3; i++) {
      act(() => h.emit({ lat: 60.01, lng: 10.015 + i * 0.0001, accuracyM: 5, speedMps: 15 }));
    }
    await waitFor(() => expect(h.route.mock.calls.length).toBe(callsBefore + 1));
    const [rerouteQuery] = h.route.mock.calls.at(-1)!;
    expect(rerouteQuery.points).toHaveLength(2);
    expect(rerouteQuery.points[1]).toEqual(destination);
    await waitFor(() => expect(hook.result.current.viaPoints).toEqual([]));
  });

  it('keeps an unpassed via through a reroute', async () => {
    const via = points[15]!;
    const h = harness(() => Promise.resolve({ paths: [viaPath(600_000)] }));
    const hook = renderHook(() => useNavigationController(h.platform));
    await act(() => hook.result.current.start(destination, 'car', undefined, [via]));
    await act(() => hook.result.current.go());
    await waitFor(() => expect(hook.result.current.phase).toBe('navigating'));

    const callsBefore = h.route.mock.calls.length;
    // Off the line near the start — the via (counted from the followed path's
    // sign-5 maneuver at index 10) is still ahead of the snapped position.
    for (let i = 0; i < 3; i++) {
      act(() => h.emit({ lat: 60.01, lng: 10.005 + i * 0.0001, accuracyM: 5, speedMps: 15 }));
    }
    await waitFor(() => expect(h.route.mock.calls.length).toBe(callsBefore + 1));
    const [rerouteQuery] = h.route.mock.calls.at(-1)!;
    expect(rerouteQuery.points).toHaveLength(3);
    expect(rerouteQuery.points[1]).toEqual(via);
    expect(hook.result.current.viaPoints).toEqual([via]);
  });

  it('lets the traveller mark only the next intermediate stop visited', async () => {
    const vias = [points[7]!, points[13]!];
    const h = harness(() => Promise.resolve({ paths: [viaPath(600_000)] }));
    const hook = renderHook(() => useNavigationController(h.platform));
    await act(() => hook.result.current.start(destination, 'car', undefined, vias));
    await act(() => hook.result.current.go());
    await waitFor(() => expect(hook.result.current.phase).toBe('navigating'));

    expect(hook.result.current.nextIntermediateStop).toEqual(vias[0]);
    const callsBefore = h.route.mock.calls.length;
    act(() => hook.result.current.continuePastIntermediateStop());

    await waitFor(() => expect(h.route.mock.calls.length).toBe(callsBefore + 1));
    const [query] = h.route.mock.calls.at(-1)!;
    expect(query.points).toEqual([expect.objectContaining(points[0]!), vias[1], destination]);
    await waitFor(() => expect(hook.result.current.viaPoints).toEqual([vias[1]]));
    expect(hook.result.current.nextIntermediateStop).toEqual(vias[1]);
  });
});

describe('useNavigationController — add stop mid-trip', () => {
  it('reroutes through the added stop, keeping the destination', async () => {
    const h = harness();
    const { result } = await drive(h);
    const callsBefore = h.route.mock.calls.length;
    h.route.mockResolvedValueOnce({ paths: [viaPath(600_000)] });
    const stop = { lat: 60.0004, lng: 10.005 };

    act(() => result.current.addStop(stop));

    await waitFor(() => expect(h.route.mock.calls.length).toBe(callsBefore + 1));
    const [query] = h.route.mock.calls.at(-1)!;
    expect(query.points).toEqual([expect.anything(), stop, destination]);
    await waitFor(() => expect(result.current.viaPoints).toEqual([stop]));
    expect(result.current.phase).toBe('navigating');
  });

  it('slots the stop among the remaining vias by along-route position', async () => {
    const via = points[13]!;
    const h = harness(() => Promise.resolve({ paths: [viaPath(600_000)] }));
    const hook = renderHook(() => useNavigationController(h.platform));
    await act(() => hook.result.current.start(destination, 'car', undefined, [via]));
    await act(() => hook.result.current.go());
    await waitFor(() => expect(hook.result.current.phase).toBe('navigating'));

    // A stop projecting to ~index 5 comes *before* the via at index 13.
    const callsBefore = h.route.mock.calls.length;
    act(() => hook.result.current.addStop({ lat: 60.0004, lng: 10.005 }));
    await waitFor(() => expect(h.route.mock.calls.length).toBe(callsBefore + 1));
    let [query] = h.route.mock.calls.at(-1)!;
    expect(query.points.slice(1)).toEqual([{ lat: 60.0004, lng: 10.005 }, via, destination]);

    // One projecting to ~index 17 lands between the via and the destination.
    act(() => hook.result.current.addStop({ lat: 60.0004, lng: 10.017 }));
    await waitFor(() => expect(h.route.mock.calls.length).toBe(callsBefore + 2));
    [query] = h.route.mock.calls.at(-1)!;
    expect(query.points.slice(1)).toEqual([
      { lat: 60.0004, lng: 10.005 },
      via,
      { lat: 60.0004, lng: 10.017 },
      destination,
    ]);
  });
});

describe('useNavigationController — faster-route watch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    // Unmount while the timers are still fake so the hook can cancel the exact
    // interval handles it installed. Switching clocks first lets them escape
    // into the next test (or past jsdom teardown).
    cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  /** Start a car trip under fake timers and make it demonstrably driving. */
  async function fakeDrive(h: Harness) {
    const hook = renderHook(() => useNavigationController(h.platform));
    await act(() => hook.result.current.start(destination));
    expect(hook.result.current.phase).toBe('preview');
    await act(() => hook.result.current.go());
    expect(hook.result.current.phase).toBe('navigating');
    act(() => h.emit(onLine(2, { speedMps: 15 })));
    expect(hook.result.current.state?.departed).toBe(true);
    return hook;
  }

  /** Advance the clock with live fixes flowing, one per simulated second. */
  async function driveFor(h: Harness, seconds: number) {
    for (let i = 0; i < seconds; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      act(() => h.emit(onLine(2, { speedMps: 15 })));
    }
  }

  it('offers a genuinely faster route, speaking the saving once', async () => {
    const h = harness();
    const hook = await fakeDrive(h);
    // Current route: 600 s for ~1.1 km → ~540 s (engine) still remaining.
    h.route.mockResolvedValueOnce({ paths: [path(300_000, 0.002)] });

    await driveFor(h, 181);

    const offer = hook.result.current.fasterRoute;
    expect(offer).not.toBeNull();
    expect(offer!.savesMs).toBeGreaterThan(FASTER_TEST_MIN_SAVING);
    expect(h.spoken.filter((t) => t.startsWith('A faster route is available'))).toHaveLength(1);
    // The line on the map is untouched until the driver says so.
    expect(hook.result.current.activePath?.timeMs).toBe(600_000);
  });

  it('offers a materially shorter route even when it saves only seconds', async () => {
    const h = harness();
    const hook = await fakeDrive(h);
    // Roughly 1,000 m and 540 s remain. This candidate saves only ~10 s, but
    // cuts about 20% of the remaining distance without taking longer.
    h.route.mockResolvedValueOnce({
      paths: [{ ...path(530_000, 0.002), distanceM: 800 }],
    });

    await driveFor(h, 181);

    expect(hook.result.current.fasterRoute).toMatchObject({
      reason: 'distance',
      savesMs: expect.any(Number),
      savesM: expect.any(Number),
    });
    expect(hook.result.current.fasterRoute!.savesMs).toBeLessThan(120_000);
    expect(hook.result.current.fasterRoute!.savesM).toBeGreaterThan(150);
    expect(h.spoken.some((text) => text.startsWith('A shorter route is available'))).toBe(true);
  });

  it('does not offer a shorter route when it takes longer', async () => {
    const h = harness();
    const hook = await fakeDrive(h);
    h.route.mockResolvedValueOnce({
      paths: [{ ...path(550_000, 0.002), distanceM: 800 }],
    });

    await driveFor(h, 181);

    expect(hook.result.current.fasterRoute).toBeNull();
    expect(h.spoken.some((text) => text.startsWith('A shorter route is available'))).toBe(false);
  });

  it('probes immediately after a reroute and restarts the cadence there', async () => {
    const h = harness();
    const hook = await fakeDrive(h);
    const calls = h.route.mock.calls.length;
    // First answer replaces the route; the second is the immediate comparison
    // scheduled from that successful replacement.
    h.route
      .mockResolvedValueOnce({ paths: [path(600_000, 0.002)] })
      .mockResolvedValueOnce({ paths: [{ ...path(530_000, 0.003), distanceM: 800 }] });

    await act(async () => {
      hook.result.current.rerouteNow();
      await vi.advanceTimersByTimeAsync(1);
    });

    expect(h.route.mock.calls.length).toBe(calls + 2);
    expect(hook.result.current.fasterRoute?.reason).toBe('distance');

    // The original guidance timer would fire at 180 s; resetting the cadence
    // means no third request arrives just after this immediate probe.
    await driveFor(h, 179);
    expect(h.route.mock.calls.length).toBe(calls + 2);
  });

  it('stays quiet when the freshly fetched route is no better', async () => {
    const h = harness();
    const hook = await fakeDrive(h);
    // Same engine answer as the followed route: nothing to offer.
    await driveFor(h, 181);
    expect(hook.result.current.fasterRoute).toBeNull();
    expect(h.spoken.filter((t) => t.startsWith('A faster route'))).toHaveLength(0);
  });

  it('reroutes proactively when a closure appears on the active road', async () => {
    const trafficClosures = vi.fn(async () => [
      { id: 'closed', position: points[10]!, message: 'Vegen er stengt.' },
    ]);
    const h = harness(undefined, { trafficClosures });
    const hook = await fakeDrive(h);
    const calls = h.route.mock.calls.length;

    await driveFor(h, 181);

    expect(trafficClosures).toHaveBeenCalled();
    // One request avoids the closure; a second immediately judges the newly
    // installed line without re-triggering the same closure.
    expect(h.route.mock.calls.length).toBe(calls + 2);
    expect(trafficClosures).toHaveBeenCalledTimes(1);
    expect(h.spoken).toContain('Road closure ahead. Rerouting.');
    expect(hook.result.current.fasterRoute).toBeNull();
  });

  it('accepting swaps to the offered route without a second route request', async () => {
    const h = harness();
    const hook = await fakeDrive(h);
    h.route.mockResolvedValueOnce({ paths: [path(300_000, 0.002)] });
    await driveFor(h, 181);
    expect(hook.result.current.fasterRoute).not.toBeNull();
    const calls = h.route.mock.calls.length;

    act(() => hook.result.current.acceptFasterRoute());

    expect(h.route.mock.calls.length).toBe(calls);
    expect(hook.result.current.activePath?.timeMs).toBe(300_000);
    expect(hook.result.current.fasterRoute).toBeNull();
    expect(hook.result.current.phase).toBe('navigating');
  });

  it('a dismissal holds until an offer is meaningfully better', async () => {
    const h = harness();
    const hook = await fakeDrive(h);
    h.route.mockResolvedValueOnce({ paths: [path(300_000, 0.002)] });
    await driveFor(h, 181);
    expect(hook.result.current.fasterRoute).not.toBeNull();

    act(() => hook.result.current.dismissFasterRoute());
    expect(hook.result.current.fasterRoute).toBeNull();

    // The same saving again: dismissed means dismissed.
    h.route.mockResolvedValueOnce({ paths: [path(300_000, 0.002)] });
    await driveFor(h, 181);
    expect(hook.result.current.fasterRoute).toBeNull();

    // A clearly better one may interrupt again.
    h.route.mockResolvedValueOnce({ paths: [path(120_000, 0.002)] });
    await driveFor(h, 181);
    expect(hook.result.current.fasterRoute).not.toBeNull();
  });

  it('re-prices the route being driven from the newest measurements', async () => {
    const trafficDelay = vi.fn(async () => ({
      delayMs: 120_000,
      measuredAt: '2026-08-02T16:10:00+02:00',
      segments: [
        {
          corridorId: 'e18',
          name: 'Asker - Sandvika',
          startM: 0,
          endM: 1113,
          delayMs: 120_000,
          status: 'queuing' as const,
        },
      ],
    }));
    const h = harness(undefined, { trafficDelay });
    const hook = await fakeDrive(h);
    const before = hook.result.current.state!;
    expect(before.trafficDelayMs).toBe(0);

    await driveFor(h, 181);

    // A jam that formed after departure now reaches the driver: the followed
    // route is re-priced in place, the trip is not restarted, and the banner
    // can say how much of the new ETA is traffic.
    expect(trafficDelay).toHaveBeenCalled();
    expect(hook.result.current.activePath?.timeMs).toBe(720_000);
    expect(hook.result.current.state!.trafficDelayMs).toBeGreaterThan(90_000);
    expect(hook.result.current.state!.timeRemainingMs).toBeGreaterThan(before.timeRemainingMs);
    expect(hook.result.current.phase).toBe('navigating');
    expect(hook.result.current.fasterRoute).toBeNull();
  });

  it('keeps the schedule it departed with when the traffic feed is unreachable', async () => {
    const trafficDelay = vi.fn(() => Promise.reject(new Error('offline')));
    const h = harness(undefined, { trafficDelay });
    const hook = await fakeDrive(h);

    await driveFor(h, 181);

    expect(trafficDelay).toHaveBeenCalled();
    expect(hook.result.current.activePath?.timeMs).toBe(600_000);
    expect(hook.result.current.state!.trafficDelayMs).toBe(0);
    expect(hook.result.current.phase).toBe('navigating');
  });

  it('refreshes an approaching road-ice warning and speaks it once', async () => {
    const roadWeather = vi.fn(async () => ({
      checkedAt: new Date().toISOString(),
      matchedSites: 1,
      warnings: [
        {
          id: 'ice-1',
          stationName: 'E18 Ice hill',
          roadNumber: 'E18',
          position: points[10]!,
          atM: 557,
          offsetM: 3,
          validAt: new Date().toISOString(),
          source: 'measured' as const,
          risk: 'high' as const,
          surfaceTemperatureC: -0.4,
          condition: 'wet',
        },
      ],
    }));
    const h = harness(undefined, { roadWeather });
    const hook = await fakeDrive(h);

    await driveFor(h, 181);

    expect(roadWeather).toHaveBeenCalled();
    expect(hook.result.current.roadWeatherWarning).toMatchObject({
      stationName: 'E18 Ice hill',
      risk: 'high',
      distanceAheadM: expect.any(Number),
    });
    expect(h.spoken.filter((text) => text.startsWith('Ice risk ahead'))).toHaveLength(1);
  });

  it('never second-guesses a walking trip', async () => {
    const h = harness();
    const hook = renderHook(() => useNavigationController(h.platform));
    await act(() => hook.result.current.start(destination, 'foot'));
    await act(() => hook.result.current.go());
    expect(hook.result.current.phase).toBe('navigating');
    act(() => h.emit(onLine(2, { speedMps: 1.4 })));
    const calls = h.route.mock.calls.length;

    for (let i = 0; i < 181; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      act(() => h.emit(onLine(2, { speedMps: 1.4 })));
    }

    expect(h.route.mock.calls.length).toBe(calls);
    expect(hook.result.current.fasterRoute).toBeNull();
  });
});

/** The controller's minimum-saving bar (see FASTER_MIN_SAVING_MS). */
const FASTER_TEST_MIN_SAVING = 120_000;

describe('useNavigationController — walking modes', () => {
  /** Start a foot trip and begin guidance. */
  async function walk(h: Harness) {
    const hook = renderHook(() => useNavigationController(h.platform));
    await act(() => hook.result.current.start(destination, 'foot'));
    expect(hook.result.current.phase).toBe('preview');
    await act(() => hook.result.current.go());
    await waitFor(() => expect(hook.result.current.phase).toBe('navigating'));
    return hook;
  }

  /** ~110 m north of the line: past foot's 35 m corridor, accurate fixes. */
  const offPath = (i: number): Position => ({
    lat: 60.001,
    lng: 10.005 + i * 0.00005,
    accuracyM: 5,
    speedMps: 1,
  });

  it('offers the reroute on foot instead of performing it, announcing once', async () => {
    const h = harness();
    const { result } = await walk(h);
    const callsBefore = h.route.mock.calls.length;

    for (let i = 0; i < 6; i++) act(() => h.emit(offPath(i)));

    await waitFor(() => expect(result.current.rerouteOffered).toBe(true));
    expect(result.current.phase).toBe('navigating');
    // The defining difference from driving: no automatic route fetch.
    expect(h.route.mock.calls.length).toBe(callsBefore);
    expect(h.spoken.filter((t) => t === 'You are off the route')).toHaveLength(1);

    // Walking back to the line withdraws the offer by itself.
    act(() => h.emit(onLine(5, { speedMps: 1 })));
    expect(result.current.rerouteOffered).toBe(false);
  });

  it('rerouteNow accepts the offer and recalculates from the last fix', async () => {
    const h = harness();
    const { result } = await walk(h);
    for (let i = 0; i < 6; i++) act(() => h.emit(offPath(i)));
    await waitFor(() => expect(result.current.rerouteOffered).toBe(true));
    const original = result.current.activePath;
    h.route.mockResolvedValueOnce({ paths: [path(300_000, 0.002)] });

    act(() => result.current.rerouteNow());

    await waitFor(() => expect(result.current.activePath).not.toBe(original));
    expect(result.current.phase).toBe('navigating');
    expect(result.current.rerouteOffered).toBe(false);
  });

  it('shows the compass facing while walking and yields it to the course at speed', async () => {
    let facingSink: ((deg: number, accuracyDeg: number | null) => void) | null = null;
    const h = harness(undefined, {
      watchFacing: (onFacing) => {
        facingSink = onFacing;
        return () => {
          facingSink = null;
        };
      },
    });
    const { result } = await walk(h);
    await waitFor(() => expect(facingSink).not.toBeNull());

    act(() => facingSink?.(210, 15));
    await waitFor(() => expect(result.current.facingDeg).toBe(210));
    expect(result.current.facingAccuracyDeg).toBe(15);

    // Above the blend-out speed the course owns the heading again.
    act(() => h.emit(onLine(2, { speedMps: 3 })));
    await waitFor(() => expect(result.current.state?.courseDeg).not.toBeNull());
    await waitFor(() => expect(result.current.facingDeg).toBeNull());

    // End tears the compass watch down with the trip.
    act(() => result.current.stop());
    expect(facingSink).toBeNull();
  });

  it('publishes a real compass turn within one 50 ms sensor frame', async () => {
    let facingSink: ((deg: number, accuracyDeg: number | null) => void) | null = null;
    const h = harness(undefined, {
      watchFacing: (onFacing) => {
        facingSink = onFacing;
        return () => {
          facingSink = null;
        };
      },
    });
    const { result } = await walk(h);
    await waitFor(() => expect(facingSink).not.toBeNull());

    let now = 1_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      act(() => facingSink?.(0, 15));
      await waitFor(() => expect(result.current.facingDeg).toBe(0));

      // The old 200 ms UI throttle held this sample even though Android's
      // rotation vector had already measured a clearly visible turn.
      now += 60;
      act(() => facingSink?.(10, 15));
      await waitFor(() => expect(result.current.facingDeg).toBeGreaterThan(2));
    } finally {
      clock.mockRestore();
    }
  });

  it('reports calibration trouble and honours forced compass and GPS sources', async () => {
    let facingSink: ((deg: number, accuracyDeg: number | null) => void) | null = null;
    const h = harness(undefined, {
      watchFacing: (onFacing) => {
        facingSink = onFacing;
        return () => {
          facingSink = null;
        };
      },
    });
    const { result } = await walk(h);
    await waitFor(() => expect(facingSink).not.toBeNull());

    act(() => facingSink?.(170, 90));
    await waitFor(() => expect(result.current.headingCalibrationNeeded).toBe(true));
    expect(result.current.headingArrowVisible).toBe(false);

    act(() => result.current.setHeadingSource('compass'));
    await waitFor(() => expect(facingSink).not.toBeNull());
    act(() => facingSink?.(80, 15));
    await waitFor(() => expect(result.current.facingDeg).toBe(80));
    act(() => h.emit(onLine(2, { speedMps: 3, headingDeg: 95 })));
    expect(result.current.facingDeg).toBe(80);

    act(() => result.current.setHeadingSource('gps'));
    await waitFor(() => expect(facingSink).toBeNull());
    act(() => h.emit(onLine(3, { speedMps: 2, headingDeg: 96 })));
    await waitFor(() => expect(result.current.facingDeg).toBe(96));
    expect(result.current.headingArrowVisible).toBe(true);
  });

  it('prepares a gated compass from the Start gesture', async () => {
    const prepareFacing = vi.fn(() => Promise.resolve());
    const h = harness(undefined, { prepareFacing });
    const hook = renderHook(() => useNavigationController(h.platform));
    await act(() => hook.result.current.start(destination, 'foot'));
    await act(() => hook.result.current.go());
    expect(prepareFacing).toHaveBeenCalledTimes(1);
  });

  it('never subscribes to the compass for a driving trip', async () => {
    const watchFacing = vi.fn();
    const h = harness(undefined, { watchFacing });
    await drive(h);
    expect(watchFacing).not.toHaveBeenCalled();
  });
});

describe('useNavigationController — resume an interrupted trip', () => {
  const via: LatLng = { lat: 60, lng: 10.01 };

  it('routes from the current position and guides at once, with no preview', async () => {
    const h = harness();
    const { result } = renderHook(() => useNavigationController(h.platform));

    await act(() => result.current.resume(destination, 'car', { avoidTolls: true }, [via]));

    await waitFor(() => expect(result.current.phase).toBe('navigating'));
    expect(result.current.previewPaths).toBeNull();
    expect(result.current.destination).toEqual(destination);
    expect(result.current.viaPoints).toEqual([via]);
    expect(result.current.preferences).toEqual({ avoidTolls: true });
    // One request, through the stop still ahead, from the fix taken just now.
    expect(h.currentFix).toHaveBeenCalledTimes(1);
    const query = h.route.mock.calls[0]![0] as RouteQuery;
    expect(query.points).toEqual([expect.objectContaining(points[0]!), via, destination]);
    expect(query.preferences).toEqual({ avoidTolls: true });
    expect(query.alternatives).toBe(true);
  });

  it('owns only one route request and watch when Resume is tapped twice', async () => {
    const h = harness();
    const { result } = renderHook(() => useNavigationController(h.platform));

    await act(async () => {
      const first = result.current.resume(destination, 'car');
      const second = result.current.resume(destination, 'car');
      await Promise.all([first, second]);
    });

    expect(result.current.phase).toBe('navigating');
    expect(h.currentFix).toHaveBeenCalledTimes(1);
    expect(h.route).toHaveBeenCalledTimes(1);
    expect(h.watchActivities).toEqual(['guidance']);
  });

  it('keeps the resumed trip reroutable — the guard does not stay latched', async () => {
    const h = harness();
    const { result } = renderHook(() => useNavigationController(h.platform));
    await act(() => result.current.resume(destination, 'car'));
    await waitFor(() => expect(result.current.phase).toBe('navigating'));

    act(() => result.current.stop());
    await act(() => result.current.start(destination));

    expect(result.current.phase).toBe('preview');
  });

  it('surfaces a failed resume as the error phase rather than a dead trip', async () => {
    const h = harness();
    h.currentFix.mockRejectedValueOnce(new Error('Could not get a GPS fix — is location on?'));
    const { result } = renderHook(() => useNavigationController(h.platform));

    await act(() => result.current.resume(destination, 'car'));

    expect(result.current.phase).toBe('error');
    expect(result.current.error).toBe('Could not get a GPS fix — is location on?');
    expect(result.current.destination).toBeNull();
  });

  it('speaks the departure prompt, exactly as a freshly started trip does', async () => {
    const h = harness();
    const { result } = renderHook(() => useNavigationController(h.platform));

    await act(() => result.current.resume(destination, 'car'));
    await waitFor(() => expect(result.current.phase).toBe('navigating'));

    expect(h.spoken.length).toBeGreaterThan(0);
  });
});

describe('useNavigationController — the diagnostic log', () => {
  /** A platform that keeps a log, and the records it received. */
  function recording(routeImpl?: (query: RouteQuery) => Promise<RouteResult>) {
    const records: Record<string, unknown>[] = [];
    const h = harness(routeImpl, { diagnostics: (record) => records.push(record) });
    const events = (name: string) => records.filter((record) => record.event === name);
    return { h, records, events };
  }

  it('brackets a trip and closes it with a summary when End comes first', async () => {
    const { h, events } = recording();
    const hook = await drive(h);
    act(() => h.emit(onLine(4, { speedMps: 20 })));
    act(() => hook.result.current.stop());

    const [start] = events('trip-start');
    const [end] = events('trip-end');
    expect(start).toMatchObject({ activity: 'guidance', profile: 'car' });
    // The point of the whole exercise: a drive abandoned short of the
    // destination is still a finished, summarised, uploadable trip.
    expect(end).toMatchObject({ outcome: 'ended-early' });
    expect((end?.report as { samples: number }).samples).toBeGreaterThan(0);
    // Every record carries the trip it belongs to.
    expect(new Set(events('navigation-state').map((record) => record.trip))).toEqual(
      new Set([start?.trip]),
    );
  });

  it('records an arrival as arrived, even though End is what ends the trip', async () => {
    const { h, events } = recording();
    const hook = await drive(h);
    act(() => h.emit(onLine(20, { speedMps: 0 })));
    await waitFor(() => expect(hook.result.current.phase).toBe('arrived'));
    act(() => hook.result.current.stop());

    expect(events('trip-arrived')).toHaveLength(1);
    expect(events('trip-end')[0]).toMatchObject({ outcome: 'arrived' });
  });

  it('says why every route was asked for', async () => {
    const { h, events } = recording();
    const hook = await drive(h);
    // Off the line by ~200 m for long enough to trip the grace count.
    for (let i = 0; i < 6; i++) {
      act(() => h.emit({ lat: 60.002, lng: 10.004, accuracyM: 5, speedMps: 20 }));
    }
    await waitFor(() => expect(events('route-request').length).toBeGreaterThan(2));
    act(() => hook.result.current.stop());

    const reasons = events('route-request').map((record) => record.reason);
    expect(reasons).toContain('preview');
    expect(reasons).toContain('depart-refresh');
    expect(reasons).toContain('off-route');
    // Every adopted line is fingerprinted and its geometry stored once behind
    // that digest — here the reroute came back with the same line, so it is
    // one geometry record for two adoptions, and the log says so instead of
    // repeating a kilometre of coordinates.
    const adopted = events('route-adopted');
    expect(adopted[0]).toMatchObject({ reason: 'departure' });
    expect(adopted.length).toBeGreaterThan(1);
    const digests = adopted.map((record) => (record.route as { digest: string }).digest);
    expect(events('route-geometry')).toHaveLength(new Set(digests).size);
  });

  it('records the prompts the driver hears, and the ones muting swallowed', async () => {
    const { h, events } = recording();
    const hook = await drive(h);
    act(() => hook.result.current.setMuted(true));
    act(() => h.emit(onLine(19, { speedMps: 20 })));
    act(() => hook.result.current.stop());

    const prompts = events('voice-prompt');
    expect(prompts.length).toBeGreaterThan(0);
    expect(prompts[0]).toMatchObject({ spoken: true, kind: 'depart' });
    // A muted cue still leaves a trace: "did it fire" and "did the driver hear
    // it" are different questions.
    expect(prompts.some((record) => record.spoken === false)).toBe(true);
  });

  it('carries the matcher decision inputs on every fix', async () => {
    const { h, events } = recording();
    const hook = await drive(h);
    act(() => h.emit(onLine(6, { speedMps: 20 })));
    act(() => hook.result.current.stop());

    const match = events('navigation-state').at(-1)?.match as Record<string, unknown>;
    expect(match).toMatchObject({ accurate: true, offRouteCount: 0 });
    expect(match.corridorM).toBeGreaterThan(0);
    expect(match.grace).toBeGreaterThan(0);
    expect(typeof match.seg).toBe('number');
  });

  it('does nothing at all on a platform that keeps no log', async () => {
    const h = harness();
    const hook = await drive(h);
    act(() => h.emit(onLine(4, { speedMps: 20 })));
    act(() => hook.result.current.stop());
    expect(hook.result.current.phase).toBe('idle');
  });
});
