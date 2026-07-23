import { useDirections as useSharedDirections, type Directions } from '@atlas/app-hooks';
import type { LatLng } from '@atlas/core';
import * as Location from 'expo-location';
import { useCallback } from 'react';

import type { RoutePlanner } from './useRoute';

/** Indoors, a current-position request can stay pending forever — cap it. */
const FIX_TIMEOUT_MS = 8_000;
/** How stale a cached fix may be when the fresh one never arrives. */
const LAST_KNOWN_MAX_AGE_MS = 120_000;

export interface AndroidDirections extends Directions {
  /**
   * A GPS fix for the route planner's "My location" shortcut, or null when the
   * permission is refused or no fix is available — the panel then just says so
   * rather than silently doing nothing.
   */
  getMyLocation: () => Promise<LatLng | null>;
}

/**
 * The device half of "Directions to here": the planner hand-off itself is
 * shared with the web (`@atlas/app-hooks`), only the fix comes from here.
 */
export function useDirections(route: RoutePlanner): AndroidDirections {
  const getMyLocation = useCallback(async (): Promise<LatLng | null> => {
    try {
      const fg = await Location.requestForegroundPermissionsAsync();
      if (!fg.granted) return null;
      // The planner is already visible, so it must also stop saying "Getting
      // location…" and remain editable when no new fix arrives.
      const fresh = await Promise.race([
        Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), FIX_TIMEOUT_MS)),
      ]);
      const pos =
        fresh ?? (await Location.getLastKnownPositionAsync({ maxAge: LAST_KNOWN_MAX_AGE_MS }));
      return pos ? { lat: pos.coords.latitude, lng: pos.coords.longitude } : null;
    } catch {
      return null;
    }
  }, []);

  const directions = useSharedDirections(route, getMyLocation);
  return { ...directions, getMyLocation };
}
