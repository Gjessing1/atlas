import { useRoute as useSharedRoute, type RouteFn, type RoutePlanner } from '@atlas/app-hooks';
import {
  enrichPlannedResult,
  httpElevationProfile,
  httpRouteProvider,
  httpTraceTransport,
} from '@atlas/routing';
import { httpTrafficClosures, trafficAwareRouteProvider } from '@atlas/traffic';

export type { RoutePlanner, RouteWaypoint } from '@atlas/app-hooks';

/** Web routing and its planner detail go through same-origin backend proxies. */
const trace = httpTraceTransport();
const elevation = httpElevationProfile();
const provider = trafficAwareRouteProvider(httpRouteProvider(), httpTrafficClosures());
const route: RouteFn = async (query, signal) => {
  const result = await provider.route(query, signal);
  return query.details ? enrichPlannedResult(result, query, trace, elevation, signal) : result;
};

export function useRoute(): RoutePlanner {
  return useSharedRoute(route);
}
