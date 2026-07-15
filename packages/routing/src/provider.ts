import { fetchRoute, type FetchRouteOptions } from './client.js';
import type { RouteQuery, RouteResult } from './model.js';

/**
 * A source of routes. Decouples callers (route planning, navigation) from where
 * routing runs: the HTTP provider proxies the self-hosted GraphHopper server,
 * while the Android app supplies an offline provider backed by a downloaded
 * graph. Both speak the same RouteQuery/RouteResult vocabulary.
 */
export interface RouteProvider {
  route(query: RouteQuery, signal?: AbortSignal): Promise<RouteResult>;
}

/** RouteProvider backed by the Atlas backend's `/api/route` endpoint. */
export function httpRouteProvider(opts: FetchRouteOptions = {}): RouteProvider {
  return {
    route: (query, signal) => fetchRoute(query, signal ? { ...opts, signal } : opts),
  };
}
