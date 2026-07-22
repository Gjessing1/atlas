// @vitest-environment jsdom
import type { LatLng } from '@atlas/core';
import type { Position } from '@atlas/navigation';
import type { RoutePath, RouteQuery, RouteResult } from '@atlas/routing';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

/** A fix on the line, `index` points along it. */
const onLine = (index: number, extra: Partial<Position> = {}): Position => ({
  ...points[index]!,
  accuracyM: 5,
  ...extra,
});

interface Harness {
  platform: NavPlatform;
  spoken: string[];
  /** Feed a fix to whatever the controller is currently watching. */
  emit: (fix: Position) => void;
  route: ReturnType<typeof vi.fn>;
  currentFix: ReturnType<typeof vi.fn>;
  watchStopped: () => number;
}

function harness(
  routeImpl?: (query: RouteQuery) => Promise<RouteResult>,
  overrides: Partial<NavPlatform> = {},
): Harness {
  const spoken: string[] = [];
  let sink: ((fix: Position) => void) | null = null;
  let stopped = 0;
  const route = vi.fn(
    routeImpl ?? (() => Promise.resolve({ paths: [path(600_000), path(900_000, 0.0001)] })),
  );
  const currentFix = vi.fn(() =>
    Promise.resolve({ fix: onLine(0, { speedMps: 0 }), atMs: Date.now() }),
  );
  const platform: NavPlatform = {
    provider: { route: route as unknown as NavPlatform['provider']['route'] },
    currentFix: currentFix as unknown as NavPlatform['currentFix'],
    watchFixes: (onFix) => {
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
    emit: (fix) => sink?.(fix),
    route,
    currentFix,
    watchStopped: () => stopped,
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

describe('useNavigationController — preview', () => {
  it('offers the choices fastest first and enters the preview phase', async () => {
    const h = harness(() => Promise.resolve({ paths: [path(900_000), path(600_000, 0.0001)] }));
    const { result } = renderHook(() => useNavigationController(h.platform));

    await act(() => result.current.start(destination));

    expect(result.current.phase).toBe('preview');
    expect(result.current.previewPaths?.map((p) => p.timeMs)).toEqual([600_000, 900_000]);
    expect(result.current.previewIndex).toBe(0);
    expect(result.current.destination).toEqual(destination);
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

  it('ends as arrived with a distance/time summary and drops the watch', async () => {
    const h = harness();
    const { result } = await drive(h);

    act(() => h.emit(onLine(20, { speedMps: 0 })));

    await waitFor(() => expect(result.current.phase).toBe('arrived'));
    expect(result.current.tripSummary).not.toBeNull();
    expect(result.current.tripSummary!.distanceM).toBeGreaterThan(0);
    expect(h.watchStopped()).toBe(1);
    expect(result.current.destination).toEqual(destination);
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

/** Three consecutive fixes well off the line — the session's off-route grace. */
function goOffRoute(h: Harness) {
  for (let i = 0; i < 3; i++) {
    act(() => h.emit({ lat: 60.01, lng: 10.005 + i * 0.0001, accuracyM: 5, speedMps: 15 }));
  }
}

describe('useNavigationController — rerouting', () => {
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
