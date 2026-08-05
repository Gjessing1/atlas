import type { Position } from '@atlas/navigation';
import type * as Location from 'expo-location';

import type { MeasuredLocationFix } from './locationTask';

export interface LocationUpdateApi {
  hasStartedLocationUpdatesAsync(taskName: string): Promise<boolean>;
  startLocationUpdatesAsync(taskName: string, options: Location.LocationTaskOptions): Promise<void>;
  stopLocationUpdatesAsync(taskName: string): Promise<void>;
  watchPositionAsync(
    options: Location.LocationOptions,
    callback: Location.LocationCallback,
  ): Promise<Location.LocationSubscription>;
}

export type LocationFixSource = 'foreground' | 'background' | 'background-inbox';

export type LocationWatchEvent =
  | { kind: 'start-requested'; token: number }
  | { kind: 'service-started'; token: number }
  | { kind: 'service-reused'; token: number }
  | { kind: 'service-failed'; token: number; error: string }
  | { kind: 'stop-requested'; token: number }
  | { kind: 'service-stopped'; token: number }
  | { kind: 'stop-skipped-new-watch'; token: number }
  | { kind: 'foreground-started'; token: number }
  | { kind: 'foreground-failed'; token: number; error: string }
  | {
      kind: 'fix-delivered';
      token: number;
      source: LocationFixSource;
      measuredAtMs: number;
      receivedAtMs: number;
      ageMs: number;
    }
  | {
      kind: 'fix-duplicate';
      token: number;
      source: LocationFixSource;
      measuredAtMs: number;
    }
  | {
      kind: 'stream-stalled';
      token: number;
      firstFix: boolean;
      lastSource: LocationFixSource | null;
      measuredAgeMs: number | null;
    }
  | { kind: 'streams-restarted'; token: number };

export interface LocationWatchTiming {
  firstFixMs: number;
  staleFixMs: number;
  watchdogIntervalMs: number;
  inboxPollMs: number;
}

const DEFAULT_TIMING: LocationWatchTiming = {
  firstFixMs: 6_000,
  staleFixMs: 6_000,
  watchdogIntervalMs: 2_000,
  inboxPollMs: 1_000,
};

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
    private readonly setHandler: (handler: ((sample: MeasuredLocationFix) => void) | null) => void,
    private readonly readPersistedFix: () => Promise<MeasuredLocationFix | null>,
    private readonly onEvent?: (event: LocationWatchEvent) => void,
    private readonly timing: LocationWatchTiming = DEFAULT_TIMING,
    private readonly now: () => number = Date.now,
  ) {}

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.transition.catch(() => undefined).then(operation);
    // Keep the queue usable after a failed native call while still returning
    // the rejecting operation to the caller that needs to surface the error.
    this.transition = next.catch(() => undefined);
    return next;
  }

  async start(
    handler: (fix: Position, measuredAtMs: number) => void,
    options: Location.LocationTaskOptions,
  ): Promise<() => void> {
    const token = ++this.sequence;
    this.activeToken = token;
    const startedAtMs = this.now();
    let lastMeasuredAtMs: number | null = null;
    let lastSource: LocationFixSource | null = null;
    const lastDuplicateAt = new Map<LocationFixSource, number>();
    let foreground: Location.LocationSubscription | null = null;
    let restarting = false;
    let watchdogGraceAtMs = startedAtMs;

    const deliver = (sample: MeasuredLocationFix, source: LocationFixSource) => {
      if (this.activeToken !== token) return;
      const measuredAtMs = sample.measuredAtMs;
      if (!Number.isFinite(measuredAtMs)) return;
      if (lastMeasuredAtMs !== null && measuredAtMs <= lastMeasuredAtMs) {
        // The inbox is a latest-value file and is polled repeatedly. Log one
        // rejection per source/sample, not the same stale value every second.
        if (lastDuplicateAt.get(source) !== measuredAtMs) {
          lastDuplicateAt.set(source, measuredAtMs);
          this.onEvent?.({ kind: 'fix-duplicate', token, source, measuredAtMs });
        }
        return;
      }
      lastMeasuredAtMs = measuredAtMs;
      lastSource = source;
      const receivedAtMs = this.now();
      this.onEvent?.({
        kind: 'fix-delivered',
        token,
        source,
        measuredAtMs,
        receivedAtMs,
        ageMs: Math.max(0, receivedAtMs - measuredAtMs),
      });
      handler(sample.fix, measuredAtMs);
    };

    this.setHandler((sample) => deliver(sample, 'background'));
    this.onEvent?.({ kind: 'start-requested', token });

    const foregroundOptions: Location.LocationOptions = {
      accuracy: options.accuracy,
      timeInterval: options.timeInterval,
      distanceInterval: options.distanceInterval,
    };

    const startForeground = async (): Promise<boolean> => {
      try {
        const subscription = await this.api.watchPositionAsync(foregroundOptions, (location) => {
          deliver({ fix: toPosition(location), measuredAtMs: location.timestamp }, 'foreground');
        });
        if (this.activeToken !== token) {
          subscription.remove();
          return false;
        }
        foreground?.remove();
        foreground = subscription;
        this.onEvent?.({ kind: 'foreground-started', token });
        return true;
      } catch (error) {
        this.onEvent?.({ kind: 'foreground-failed', token, error: String(error) });
        return false;
      }
    };

    const ensureBackground = async (forceRestart = false): Promise<boolean> => {
      try {
        await this.enqueue(async () => {
          if (this.activeToken !== token) return;
          const started = await this.api.hasStartedLocationUpdatesAsync(this.taskName);
          if (this.activeToken !== token) return;
          if (started && forceRestart) {
            await this.api.stopLocationUpdatesAsync(this.taskName);
          } else if (started) {
            this.onEvent?.({ kind: 'service-reused', token });
            return;
          }
          if (this.activeToken !== token) return;
          await this.api.startLocationUpdatesAsync(this.taskName, options);
          this.onEvent?.({ kind: 'service-started', token });
        });
        return this.activeToken === token;
      } catch (error) {
        this.onEvent?.({ kind: 'service-failed', token, error: String(error) });
        return false;
      }
    };

    const [backgroundReady, foregroundReady] = await Promise.all([
      ensureBackground(),
      startForeground(),
    ]);
    if (!backgroundReady && !foregroundReady) {
      if (this.activeToken === token) {
        this.activeToken = null;
        this.setHandler(null);
      }
      throw new Error('Could not start either Android location stream');
    }

    const pollInbox = () => {
      void this.readPersistedFix().then((sample) => {
        if (sample) deliver(sample, 'background-inbox');
      });
    };
    pollInbox();
    const inboxTimer = setInterval(pollInbox, this.timing.inboxPollMs);

    const restartStreams = () => {
      if (restarting || this.activeToken !== token) return;
      restarting = true;
      watchdogGraceAtMs = this.now();
      foreground?.remove();
      foreground = null;
      void Promise.all([ensureBackground(true), startForeground()]).finally(() => {
        restarting = false;
        if (this.activeToken === token) this.onEvent?.({ kind: 'streams-restarted', token });
      });
    };
    const watchdogTimer = setInterval(() => {
      const nowMs = this.now();
      const firstFix = lastMeasuredAtMs === null;
      const sinceEvidenceMs = firstFix ? startedAtMs : lastMeasuredAtMs!;
      // After a restart, allow the same first-fix window before deciding that
      // the replacement also failed; otherwise a quick native restart would
      // be torn down again by the very next watchdog tick.
      const stalledForMs = nowMs - Math.max(sinceEvidenceMs, watchdogGraceAtMs);
      const limitMs = firstFix ? this.timing.firstFixMs : this.timing.staleFixMs;
      if (stalledForMs < limitMs) return;
      this.onEvent?.({
        kind: 'stream-stalled',
        token,
        firstFix,
        lastSource,
        measuredAgeMs: firstFix ? null : nowMs - lastMeasuredAtMs!,
      });
      restartStreams();
    }, this.timing.watchdogIntervalMs);

    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      clearInterval(inboxTimer);
      clearInterval(watchdogTimer);
      foreground?.remove();
      foreground = null;
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

/** Keep expo-location conversion at this seam so the coordinator is testable. */
function toPosition(pos: Location.LocationObject): Position {
  const c = pos.coords;
  const fix: Position = { lat: c.latitude, lng: c.longitude };
  if (typeof c.accuracy === 'number' && c.accuracy >= 0) fix.accuracyM = c.accuracy;
  if (typeof c.heading === 'number' && c.heading >= 0) fix.headingDeg = c.heading;
  if (typeof c.speed === 'number' && c.speed >= 0) fix.speedMps = c.speed;
  if (typeof c.altitude === 'number' && Number.isFinite(c.altitude)) fix.altitudeM = c.altitude;
  return fix;
}
