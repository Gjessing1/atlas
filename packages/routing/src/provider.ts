import { fetchRoute, type FetchRouteOptions } from './client.js';
import type { RouteQuery, RouteResult } from './model.js';
import { buildValhallaRequest, parseValhallaResponse } from './valhalla.js';

/**
 * A source of routes. Decouples callers (route planning, navigation) from where
 * routing runs: the HTTP provider proxies the self-hosted Valhalla service,
 * while the Android app supplies an offline provider backed by downloaded
 * Valhalla tiles — the same engine either way, so the two can't disagree.
 * Both speak the same RouteQuery/RouteResult vocabulary.
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

/**
 * Carries a Valhalla request to an engine and returns its raw JSON response.
 * The transport is deliberately abstract: on Android it calls the embedded
 * native Valhalla core (no network), while a server could POST to a Valhalla
 * HTTP service — either way the wire shape is Valhalla's.
 */
export type ValhallaTransport = (
  request: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<unknown>;

/**
 * RouteProvider backed by Valhalla — the offline, on-device engine. Builds the
 * Valhalla request, hands it to the transport (native bridge), and maps the
 * response back into the shared RoutePath/RouteResult model.
 */
export function valhallaRouteProvider(transport: ValhallaTransport): RouteProvider {
  return {
    route: async (query, signal) =>
      parseValhallaResponse(await transport(buildValhallaRequest(query), signal)),
  };
}
