import type { RouteQuery, RouteResult } from './model.js';
import type { ValhallaTransport } from './provider.js';
import { buildValhallaRequest, parseValhallaResponse } from './valhalla.js';

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
 * Transport that runs Valhalla `trace_attributes` requests through the Atlas
 * backend (`/api/route/attributes`). Pair with `enrichRoute`; the Android app
 * pairs the same function with its embedded engine instead.
 */
export function httpTraceTransport(opts: FetchRouteOptions = {}): ValhallaTransport {
  return async (request, signal) => {
    const doFetch = opts.fetchImpl ?? fetch;
    const res = await doFetch(`${opts.baseUrl ?? ''}/api/route/attributes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal: signal ?? opts.signal,
    });
    if (!res.ok) throw new RoutingError(`route attributes failed (HTTP ${res.status})`);
    return (await res.json()) as unknown;
  };
}

/**
 * Request a route from the Atlas backend (which proxies the Valhalla service —
 * the same engine that runs on-device, so online and offline routes agree).
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
    body: JSON.stringify(buildValhallaRequest(query)),
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
    return parseValhallaResponse(json);
  } catch (err) {
    throw new RoutingError(err instanceof Error ? err.message : String(err));
  }
}
