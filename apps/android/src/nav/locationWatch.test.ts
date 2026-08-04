import type { Position } from '@atlas/navigation';
import { describe, expect, it, vi } from 'vitest';

import { LocationWatchCoordinator, type LocationUpdateApi } from './locationWatch';

const options = {} as Parameters<LocationUpdateApi['startLocationUpdatesAsync']>[1];
const fix = (_position: Position): void => undefined;

function harness(started = false) {
  let running = started;
  const api: LocationUpdateApi = {
    hasStartedLocationUpdatesAsync: vi.fn(async () => running),
    startLocationUpdatesAsync: vi.fn(async () => {
      running = true;
    }),
    stopLocationUpdatesAsync: vi.fn(async () => {
      running = false;
    }),
  };
  const setHandler = vi.fn();
  const coordinator = new LocationWatchCoordinator('task', api, setHandler);
  return { api, setHandler, coordinator, running: () => running };
}

describe('LocationWatchCoordinator', () => {
  it('starts and stops one native location service', async () => {
    const h = harness();
    const stop = await h.coordinator.start(fix, options);
    expect(h.api.startLocationUpdatesAsync).toHaveBeenCalledOnce();
    expect(h.running()).toBe(true);

    stop();
    await vi.waitFor(() => expect(h.api.stopLocationUpdatesAsync).toHaveBeenCalledOnce());
    expect(h.running()).toBe(false);
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
    };
    const coordinator = new LocationWatchCoordinator('task', api, vi.fn());
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
});
