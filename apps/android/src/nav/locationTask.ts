import type { Position } from '@atlas/navigation';
import * as FileSystem from 'expo-file-system/legacy';
import type * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';

import { logNavigationDiagnostic } from './diagnostics';

/**
 * Background location plumbing. `startLocationUpdatesAsync` runs this task in a
 * (possibly headless) JS context tied to an Android foreground service, so
 * navigation keeps getting fixes with the screen off. The task can't touch
 * React state directly, so it forwards the latest fix through a module-level
 * handler the navigation hook installs while a trip is active.
 *
 * `defineTask` must run at module load (not inside a component), so this file is
 * imported for its side effect from the app entry.
 */
export const NAV_LOCATION_TASK = 'atlas-nav-location';
const NAV_LOCATION_INBOX = `${FileSystem.documentDirectory ?? FileSystem.cacheDirectory ?? ''}navigation-location-inbox.json`;

export interface MeasuredLocationFix {
  fix: Position;
  measuredAtMs: number;
}

/**
 * An expo-location fix as the navigation session reads it. Android reports -1
 * for an unknown heading or speed, so a bare pass-through would tell the
 * session the traveller is facing due north while standing still.
 */
export function toPosition(pos: Location.LocationObject): Position {
  const c = pos.coords;
  const fix: Position = { lat: c.latitude, lng: c.longitude };
  if (typeof c.accuracy === 'number' && c.accuracy >= 0) fix.accuracyM = c.accuracy;
  if (typeof c.heading === 'number' && c.heading >= 0) fix.headingDeg = c.heading;
  if (typeof c.speed === 'number' && c.speed >= 0) fix.speedMps = c.speed;
  if (typeof c.altitude === 'number' && Number.isFinite(c.altitude)) fix.altitudeM = c.altitude;
  return fix;
}

let handler: ((sample: MeasuredLocationFix) => void) | null = null;

/** Install (or clear, with null) the sink the background task forwards fixes to. */
export function setLocationHandler(h: ((sample: MeasuredLocationFix) => void) | null): void {
  handler = h;
}

/**
 * Recover the newest TaskManager sample across JS runtimes. Android may launch
 * the task in a headless runtime, where the module-global handler above is a
 * different variable from the foreground application's. Keeping one latest
 * sample on disk makes that delivery observable without growing an unbounded
 * location journal; the coordinator's timestamp gate makes repeated reads
 * harmless.
 */
export async function readPersistedLocationFix(): Promise<MeasuredLocationFix | null> {
  try {
    const raw = await FileSystem.readAsStringAsync(NAV_LOCATION_INBOX);
    const value = JSON.parse(raw) as Partial<MeasuredLocationFix>;
    if (
      typeof value.measuredAtMs !== 'number' ||
      !Number.isFinite(value.measuredAtMs) ||
      !value.fix ||
      typeof value.fix.lat !== 'number' ||
      typeof value.fix.lng !== 'number'
    ) {
      return null;
    }
    return value as MeasuredLocationFix;
  } catch {
    return null;
  }
}

TaskManager.defineTask(NAV_LOCATION_TASK, async ({ data, error }) => {
  if (error) {
    void logNavigationDiagnostic({ event: 'gps-task-error', error: String(error) });
    return;
  }
  const locations = (data as { locations?: Location.LocationObject[] } | null)?.locations ?? [];
  const last = locations[locations.length - 1];
  if (!last) return;
  const sample = { fix: toPosition(last), measuredAtMs: last.timestamp };
  if (handler) handler(sample);
  // This write is the cross-runtime bridge. A headless task cannot assume the
  // React runtime's module-global callback exists; the live coordinator polls
  // this latest-value inbox and deduplicates it against direct foreground and
  // same-runtime task delivery.
  await FileSystem.writeAsStringAsync(NAV_LOCATION_INBOX, JSON.stringify(sample)).catch(
    () => undefined,
  );
  await logNavigationDiagnostic({
    event: 'gps-fix-batch',
    measuredAtMs: last.timestamp,
    batchSize: locations.length,
    // Background delivery may batch samples. Navigation intentionally consumes
    // the newest one, but diagnostics retains every measured sample so a gap
    // in JS delivery cannot be mistaken for a gap in Android's provider.
    samples: locations.map((sample) => ({
      measuredAtMs: sample.timestamp,
      mocked: sample.mocked,
      coords: {
        lat: sample.coords.latitude,
        lng: sample.coords.longitude,
        accuracyM: sample.coords.accuracy,
        speedMps: sample.coords.speed,
        headingDeg: sample.coords.heading,
        altitudeM: sample.coords.altitude,
      },
    })),
    deliveredToNavigation: handler !== null,
    persistedForNavigation: true,
  });
});
