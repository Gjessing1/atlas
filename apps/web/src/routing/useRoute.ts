import { useRoute as useSharedRoute, type RouteFn, type RoutePlanner } from '@atlas/app-hooks';
import {
  enrichPlannedResult,
  fetchRoute,
  httpElevationProfile,
  httpTraceTransport,
} from '@atlas/routing';

export type { RoutePlanner, RouteWaypoint } from '@atlas/app-hooks';

/** Web routing and its planner detail go through same-origin backend proxies. */
const trace = httpTraceTransport();
const elevation = httpElevationProfile();
const route: RouteFn = async (query, signal) => {
  const result = await fetchRoute(query, { signal });
  return query.details ? enrichPlannedResult(result, query, trace, elevation, signal) : result;
};

export function useRoute(): RoutePlanner {
  return useSharedRoute(route);
}
