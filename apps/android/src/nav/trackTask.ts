import type * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';

import type { RecordFix } from '@atlas/gpx';

/**
 * Background location plumbing for track recording — the sibling of
 * {@link NAV_LOCATION_TASK}, kept separate so a trip can be recorded
 * independently of turn-by-turn navigation (either, both, or neither may run).
 * Like navigation, it runs under an Android foreground service so fixes keep
 * arriving with the screen off; the (possibly headless) task can't touch React
 * state, so it forwards each fix through a module-level handler the recording
 * hook installs while recording is active.
 *
 * `defineTask` must run at module load, so this file is imported for its side
 * effect from the app entry.
 */
export const TRACK_LOCATION_TASK = 'atlas-track-record';

let handler: ((fix: RecordFix) => void) | null = null;

/** Install (or clear, with null) the sink the background task forwards fixes to. */
export function setTrackHandler(h: ((fix: RecordFix) => void) | null): void {
  handler = h;
}

TaskManager.defineTask(TRACK_LOCATION_TASK, async ({ data, error }) => {
  if (error || !handler) return;
  const locations = (data as { locations?: Location.LocationObject[] } | null)?.locations ?? [];
  for (const loc of locations) {
    const c = loc.coords;
    const fix: RecordFix = { lat: c.latitude, lng: c.longitude, time: loc.timestamp };
    if (c.altitude !== null && c.altitude !== undefined) fix.ele = c.altitude;
    if (c.accuracy !== null && c.accuracy !== undefined) fix.accuracyM = c.accuracy;
    handler(fix);
  }
});
