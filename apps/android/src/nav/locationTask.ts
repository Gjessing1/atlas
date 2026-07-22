import type { Position } from '@atlas/navigation';
import type * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';

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
  return fix;
}

let handler: ((fix: Position) => void) | null = null;

/** Install (or clear, with null) the sink the background task forwards fixes to. */
export function setLocationHandler(h: ((fix: Position) => void) | null): void {
  handler = h;
}

TaskManager.defineTask(NAV_LOCATION_TASK, async ({ data, error }) => {
  if (error || !handler) return;
  const locations = (data as { locations?: Location.LocationObject[] } | null)?.locations ?? [];
  const last = locations[locations.length - 1];
  if (!last) return;
  handler(toPosition(last));
});
