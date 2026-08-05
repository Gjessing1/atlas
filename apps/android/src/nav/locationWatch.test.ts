import type { Position } from '@atlas/navigation';
import type { LocationObject } from 'expo-location';
import { describe, expect, it, vi } from 'vitest';

import {
  LocationWatchCoordinator,
  type LocationUpdateApi,
  type LocationWatchEvent,
} from './locationWatch';

const options = {} as Parameters<LocationUpdateApi['startLocationUpdatesAsync']>[1];
const fix = (_position: Position): void => undefined;

function harness(started = false) {
  let running = started;
  let backgroundHandler: ((sample: { fix: Position; measuredAtMs: number }) => void) | null = null;
  let foregroundHandler: ((location: LocationObject) => void) | null = null;
  const foregroundRemove = vi.fn();
  const api: LocationUpdateApi = {
    hasStartedLocationUpdatesAsync: vi.fn(async () => running),
    startLocationUpdatesAsync: vi.fn(async () => {
      running = true;
    }),
    stopLocationUpdatesAsync: vi.fn(async () => {
      running = false;
    }),
    watchPositionAsync: vi.fn(async (_options, callback) => {
      foregroundHandler = callback;
      return { remove: foregroundRemove };
    }),
  };
  const setHandler = vi.fn((next) => {
    backgroundHandler = next;
  });
  const coordinator = new LocationWatchCoordinator('task', api, setHandler, async () => null);
  return {
    api,
    setHandler,
    coordinator,
    running: () => running,
    emitBackground: (position: Position, measuredAtMs: number) =>
      backgroundHandler?.({ fix: position, measuredAtMs }),
    emitForeground: (position: Position, measuredAtMs: number) =>
      foregroundHandler?.(location(position, measuredAtMs)),
    foregroundRemove,
  };
}

function location(position: Position, timestamp: number): LocationObject {
  return {
    timestamp,
    mocked: false,
    coords: {
      latitude: position.lat,
      longitude: position.lng,
      altitude: position.altitudeM ?? null,
      accuracy: position.accuracyM ?? null,
      altitudeAccuracy: null,
      heading: position.headingDeg ?? null,
      speed: position.speedMps ?? null,
    },
  };
}

describe('LocationWatchCoordinator', () => {
  it('starts and stops one native location service', async () => {
    const h = harness();
    const stop = await h.coordinator.start(fix, options);
    expect(h.api.startLocationUpdatesAsync).toHaveBeenCalledOnce();
    expect(h.api.watchPositionAsync).toHaveBeenCalledOnce();
    expect(h.running()).toBe(true);

    stop();
    await vi.waitFor(() => expect(h.api.stopLocationUpdatesAsync).toHaveBeenCalledOnce());
    expect(h.running()).toBe(false);
    expect(h.foregroundRemove).toHaveBeenCalledOnce();
  });

  it('does not let an old cleanup stop a replacement watch', async () => {
    const h = harness(true);
    const stopOld = await h.coordinator.start(fix, options);

    // This is the Explorer -> guidance handoff: cleanup queues a native stop,
    // while replacement registers before that asynchronous stop gets the turn.
    stopOld();
    const stopNew = await h.coordinator.start(fix, options);

    expect(h.api.stopLocationUpdatesAsync).not.toHaveBeenCalled();
    expect(h.api.startLocationUpdatesAsync).not.toHaveBeenCalled();
    expect(h.running()).toBe(true);

    stopNew();
    await vi.waitFor(() => expect(h.api.stopLocationUpdatesAsync).toHaveBeenCalledOnce());
  });

  it('restarts after a stop that was already in flight', async () => {
    let releaseStop!: () => void;
    const stopping = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    let running = true;
    const api: LocationUpdateApi = {
      hasStartedLocationUpdatesAsync: vi.fn(async () => running),
      startLocationUpdatesAsync: vi.fn(async () => {
        running = true;
      }),
      stopLocationUpdatesAsync: vi.fn(async () => {
        await stopping;
        running = false;
      }),
      watchPositionAsync: vi.fn(async () => ({ remove: vi.fn() })),
    };
    const coordinator = new LocationWatchCoordinator('task', api, vi.fn(), async () => null);
    const stopOld = await coordinator.start(fix, options);
    stopOld();
    await vi.waitFor(() => expect(api.stopLocationUpdatesAsync).toHaveBeenCalledOnce());

    const replacement = coordinator.start(fix, options);
    releaseStop();
    const stopNew = await replacement;
    expect(api.startLocationUpdatesAsync).toHaveBeenCalledOnce();
    expect(running).toBe(true);
    stopNew();
  });

  it('deduplicates the same measured sample across foreground and background', async () => {
    const h = harness();
    const delivered = vi.fn();
    const stop = await h.coordinator.start(delivered, options);
    const point = { lat: 59.9, lng: 10.7, speedMps: 12 };
    h.emitForeground(point, 1_000);
    h.emitBackground(point, 1_000);
    expect(delivered).toHaveBeenCalledTimes(1);
    expect(delivered).toHaveBeenCalledWith(point, 1_000);
    stop();
  });

  it('recovers when either stream resumes with a newer measured sample', async () => {
    const h = harness();
    const delivered = vi.fn();
    const stop = await h.coordinator.start(delivered, options);
    h.emitForeground({ lat: 59.9, lng: 10.7 }, 1_000);
    h.emitBackground({ lat: 59.91, lng: 10.71 }, 2_000);
    h.emitForeground({ lat: 59.92, lng: 10.72 }, 3_000);
    expect(delivered.mock.calls.map((call) => call[1])).toEqual([1_000, 2_000, 3_000]);
    stop();
  });

  it('recovers a background fix persisted by a separate headless JS runtime', async () => {
    const h = harness();
    const delivered = vi.fn();
    let available = true;
    const coordinator = new LocationWatchCoordinator('task', h.api, h.setHandler, async () => {
      if (!available) return null;
      available = false;
      return { fix: { lat: 59.9, lng: 10.7 }, measuredAtMs: 1_000 };
    });
    const stop = await coordinator.start(delivered, options);
    await vi.waitFor(() => expect(delivered).toHaveBeenCalledWith({ lat: 59.9, lng: 10.7 }, 1_000));
    stop();
  });

  it('detects a native watch that starts but emits no fixes and restarts both streams', async () => {
    vi.useFakeTimers();
    try {
      let now = 0;
      const events: LocationWatchEvent[] = [];
      const h = harness();
      const coordinator = new LocationWatchCoordinator(
        'task',
        h.api,
        h.setHandler,
        async () => null,
        (event) => events.push(event),
        { firstFixMs: 5_000, staleFixMs: 5_000, watchdogIntervalMs: 1_000, inboxPollMs: 1_000 },
        () => now,
      );
      const stop = await coordinator.start(fix, options);
      now = 6_000;
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() => expect(h.api.watchPositionAsync).toHaveBeenCalledTimes(2));
      expect(events).toContainEqual(
        expect.objectContaining({ kind: 'stream-stalled', firstFix: true, measuredAgeMs: null }),
      );
      expect(h.api.stopLocationUpdatesAsync).toHaveBeenCalledOnce();
      expect(h.api.startLocationUpdatesAsync).toHaveBeenCalledTimes(2);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps watching for a stream that dies after its first fix', async () => {
    vi.useFakeTimers();
    try {
      let now = 0;
      const events: LocationWatchEvent[] = [];
      const h = harness();
      const coordinator = new LocationWatchCoordinator(
        'task',
        h.api,
        h.setHandler,
        async () => null,
        (event) => events.push(event),
        {
          firstFixMs: 5_000,
          staleFixMs: 5_000,
          watchdogIntervalMs: 1_000,
          inboxPollMs: 1_000,
        },
        () => now,
      );
      const stop = await coordinator.start(fix, options);
      now = 1_000;
      h.emitForeground({ lat: 59.9, lng: 10.7 }, 1_000);
      now = 7_000;
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() => expect(h.api.watchPositionAsync).toHaveBeenCalledTimes(2));
      expect(events).toContainEqual(
        expect.objectContaining({
          kind: 'stream-stalled',
          firstFix: false,
          lastSource: 'foreground',
          measuredAgeMs: 6_000,
        }),
      );
      stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
