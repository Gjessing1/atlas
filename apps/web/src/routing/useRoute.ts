import { useRoute as useSharedRoute, type RouteFn, type RoutePlanner } from '@atlas/app-hooks';
import { fetchRoute } from '@atlas/routing';

export type { RoutePlanner, RouteWaypoint } from '@atlas/app-hooks';

/** Web routing goes straight to the same-origin backend. */
const route: RouteFn = (query, signal) => fetchRoute(query, { signal });

export function useRoute(): RoutePlanner {
  return useSharedRoute(route);
}
