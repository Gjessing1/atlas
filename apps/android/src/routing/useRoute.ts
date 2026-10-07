import { useRoute as useSharedRoute, type RouteFn, type RoutePlanner } from '@atlas/app-hooks';
import { enrichPlannedResult, httpElevationProfile, type VehicleProfile } from '@atlas/routing';
import { useMemo } from 'react';

import { useServerOrigin } from '../serverOrigin';
import { makeRouteProvider, makeTraceTransport } from './offlineRouting';

export type { RoutePlanner, RouteWaypoint } from '@atlas/app-hooks';

/**
 * Android routing goes through the shared offline-first provider (embedded
 * Valhalla when a downloaded pack covers the query, else the server) — the
 * same provider navigation uses.
 */
export function useRoute(vehicle?: VehicleProfile | null): RoutePlanner {
  const baseUrl = useServerOrigin();
  const elevation = useMemo(() => httpElevationProfile({ baseUrl }), [baseUrl]);
  const route = useMemo<RouteFn>(() => {
    const provider = makeRouteProvider(baseUrl);
    const trace = makeTraceTransport(baseUrl);
    return async (query, signal) => {
      const result = await provider.route(query, signal);
      return query.details ? enrichPlannedResult(result, query, trace, elevation, signal) : result;
    };
  }, [baseUrl, elevation]);
  return useSharedRoute(route, vehicle, elevation);
}
