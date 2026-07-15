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

export type LocationFix = { lat: number; lng: number; headingDeg?: number; speedMps?: number };

let handler: ((fix: LocationFix) => void) | null = null;

/** Install (or clear, with null) the sink the background task forwards fixes to. */
export function setLocationHandler(h: ((fix: LocationFix) => void) | null): void {
  handler = h;
}

TaskManager.defineTask(NAV_LOCATION_TASK, async ({ data, error }) => {
  if (error || !handler) return;
  const locations = (data as { locations?: Location.LocationObject[] } | null)?.locations ?? [];
  const last = locations[locations.length - 1];
  if (!last) return;
  const c = last.coords;
  handler({
    lat: c.latitude,
    lng: c.longitude,
    headingDeg: c.heading ?? undefined,
    speedMps: c.speed ?? undefined,
  });
});
