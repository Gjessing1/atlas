import type { Position } from '@atlas/navigation';
import type * as Location from 'expo-location';

export interface LocationUpdateApi {
  hasStartedLocationUpdatesAsync(taskName: string): Promise<boolean>;
  startLocationUpdatesAsync(taskName: string, options: Location.LocationTaskOptions): Promise<void>;
  stopLocationUpdatesAsync(taskName: string): Promise<void>;
}

export type LocationWatchEvent =
  | { kind: 'start-requested'; token: number }
  | { kind: 'service-started'; token: number }
  | { kind: 'service-reused'; token: number }
  | { kind: 'stop-requested'; token: number }
  | { kind: 'service-stopped'; token: number }
  | { kind: 'stop-skipped-new-watch'; token: number };

/**
 * Owns the one Expo background-location task across consecutive Atlas
 * activities. Expo's start/stop calls are asynchronous, so a plain
 * "stop old; start new" handoff can do this:
 *
 *  1. the new watch sees the old service still running and reuses it;
 *  2. the old stop finishes afterward and kills the service underneath it.
 *
 * Serialising every transition closes both orderings. If a new watch arrives
 * before the queued stop begins, that stop is skipped. If it arrives after the
 * stop begins, its start waits and restarts the service after the stop lands.
 */
export class LocationWatchCoordinator {
  private sequence = 0;
  private activeToken: number | null = null;
  private transition: Promise<void> = Promise.resolve();

  constructor(
    private readonly taskName: string,
    private readonly api: LocationUpdateApi,
    private readonly setHandler: (handler: ((fix: Position) => void) | null) => void,
    private readonly onEvent?: (event: LocationWatchEvent) => void,
  ) {}

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.transition.catch(() => undefined).then(operation);
    // Keep the queue usable after a failed native call while still returning
    // the rejecting operation to the caller that needs to surface the error.
    this.transition = next.catch(() => undefined);
    return next;
  }

  async start(
    handler: (fix: Position) => void,
    options: Location.LocationTaskOptions,
  ): Promise<() => void> {
    const token = ++this.sequence;
    this.activeToken = token;
    this.setHandler(handler);
    this.onEvent?.({ kind: 'start-requested', token });

    try {
      await this.enqueue(async () => {
        if (this.activeToken !== token) return;
        const started = await this.api.hasStartedLocationUpdatesAsync(this.taskName);
        if (this.activeToken !== token) return;
        if (started) {
          this.onEvent?.({ kind: 'service-reused', token });
          return;
        }
        await this.api.startLocationUpdatesAsync(this.taskName, options);
        this.onEvent?.({ kind: 'service-started', token });
      });
    } catch (error) {
      if (this.activeToken === token) {
        this.activeToken = null;
        this.setHandler(null);
      }
      throw error;
    }

    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      if (this.activeToken !== token) return;
      this.activeToken = null;
      this.setHandler(null);
      this.onEvent?.({ kind: 'stop-requested', token });
      void this.enqueue(async () => {
        // A replacement registered while this stop was waiting. It owns the
        // already-running service, so stopping it would recreate the bug this
        // coordinator exists to prevent.
        if (this.activeToken !== null) {
          this.onEvent?.({ kind: 'stop-skipped-new-watch', token });
          return;
        }
        if (await this.api.hasStartedLocationUpdatesAsync(this.taskName)) {
          await this.api.stopLocationUpdatesAsync(this.taskName);
          this.onEvent?.({ kind: 'service-stopped', token });
        }
      });
    };
  }
}
