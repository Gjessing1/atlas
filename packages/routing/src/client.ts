import { buildRouteRequest, parseRouteResponse } from './graphhopper.js';
import type { RouteQuery, RouteResult } from './model.js';

/** A routing failure with a user-presentable message (e.g. "point 1 out of bounds"). */
export class RoutingError extends Error {}

export interface FetchRouteOptions {
  /** Origin of the Atlas backend; defaults to same-origin (browser). */
  baseUrl?: string;
  signal?: AbortSignal;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

/**
 * Request a route from the Atlas backend (which proxies GraphHopper).
 * Throws RoutingError for routing problems (unreachable points, service down)
 * and passes through AbortError so callers can ignore superseded requests.
 */
export async function fetchRoute(
  query: RouteQuery,
  opts: FetchRouteOptions = {},
): Promise<RouteResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(`${opts.baseUrl ?? ''}/api/route`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildRouteRequest(query)),
    signal: opts.signal,
  });
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const message =
      json !== null && typeof json === 'object' && 'message' in json
        ? String((json as { message: unknown }).message)
        : `routing failed (HTTP ${res.status})`;
    throw new RoutingError(message);
  }
  try {
    return parseRouteResponse(json);
  } catch (err) {
    throw new RoutingError(err instanceof Error ? err.message : String(err));
  }
}
