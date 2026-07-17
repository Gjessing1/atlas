import { useRoute as useSharedRoute, type RouteFn, type RoutePlanner } from '@atlas/app-hooks';
import { useMemo } from 'react';

import { useServerOrigin } from '../serverOrigin';
import { makeRouteProvider } from './offlineRouting';

export type { RoutePlanner, RouteWaypoint } from '@atlas/app-hooks';

/**
 * Android routing goes through the shared offline-first provider (embedded
 * Valhalla when a downloaded pack covers the query, else the server) — the
 * same provider navigation uses.
 */
export function useRoute(): RoutePlanner {
  const baseUrl = useServerOrigin();
  const route = useMemo<RouteFn>(() => {
    const provider = makeRouteProvider(baseUrl);
    return (query, signal) => provider.route(query, signal);
  }, [baseUrl]);
  return useSharedRoute(route);
}
