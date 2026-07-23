import type { LatLng } from '@atlas/core';

/** A desktop fix can hang on a slow network lookup — cap the wait. */
const FIX_TIMEOUT_MS = 8_000;

/**
 * One current position fix, or null when geolocation is refused, unavailable,
 * or times out. Shared by the "Directions to here" hand-off and the route
 * planner's "My location" shortcut: a refused permission is not an error at
 * either call site — both simply fall back to the user picking a start.
 */
export function getMyLocation(): Promise<LatLng | null> {
  return new Promise((resolve) => {
    if (!navigator.geolocation) {
      resolve(null);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: FIX_TIMEOUT_MS, maximumAge: 120_000 },
    );
  });
}
