import { useDirections as useSharedDirections, type Directions } from '@atlas/app-hooks';
import type { LatLng } from '@atlas/core';
import { useCallback } from 'react';

import type { RoutePlanner } from './useRoute.js';

/** A desktop fix can hang on a slow network lookup — cap the wait. */
const FIX_TIMEOUT_MS = 8_000;

/**
 * The browser half of "Directions to here". The planner hand-off is shared with
 * Android (`@atlas/app-hooks`); only the fix is platform work. A refused or
 * missing permission is not an error here — the planner simply opens asking for
 * a start, which is also what happens on a desktop with no geolocation at all.
 */
export function useDirections(route: RoutePlanner): Directions {
  const getMyLocation = useCallback(
    () =>
      new Promise<LatLng | null>((resolve) => {
        if (!navigator.geolocation) {
          resolve(null);
          return;
        }
        navigator.geolocation.getCurrentPosition(
          (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
          () => resolve(null),
          { enableHighAccuracy: true, timeout: FIX_TIMEOUT_MS, maximumAge: 120_000 },
        );
      }),
    [],
  );
  return useSharedDirections(route, getMyLocation);
}
