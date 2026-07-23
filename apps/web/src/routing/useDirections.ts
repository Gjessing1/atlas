import { useDirections as useSharedDirections, type Directions } from '@atlas/app-hooks';

import { getMyLocation } from './geolocate.js';
import type { RoutePlanner } from './useRoute.js';

/**
 * The browser half of "Directions to here". The planner hand-off is shared with
 * Android (`@atlas/app-hooks`); only the fix is platform work (`getMyLocation`,
 * shared with the planner's own "My location" shortcut). A refused or missing
 * permission is not an error here — the planner simply opens asking for a start,
 * which is also what happens on a desktop with no geolocation at all.
 */
export function useDirections(route: RoutePlanner): Directions {
  return useSharedDirections(route, getMyLocation);
}
