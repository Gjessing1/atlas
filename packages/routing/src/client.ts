import type { LatLng } from '@atlas/core';

import type { RouteCameras } from './cameras.js';
import type { RouteQuery, RouteResult } from './model.js';
import type { SpeedLimitOverride } from './nvdb.js';
import type { ValhallaTransport } from './provider.js';
import { buildValhallaRequest, parseValhallaResponse } from './valhalla.js';

/**
 * Ask the Atlas backend which distance ranges of a route NVDB overrides the
 * speed limit on. Pair with {@link applyNvdbSpeedLimits}. Returns `[]` — not an
 * error — when the backend ships no NVDB dataset or the route leaves Norway, so
 * enrichment simply keeps the tile limits. The Android app produces the same
 * overrides locally from its pack instead of calling this.
 */
export type NvdbLimitTransport = (
  points: LatLng[],
  signal?: AbortSignal,
) => Promise<SpeedLimitOverride[]>;

/** {@link NvdbLimitTransport} backed by the backend's `/api/route/nvdb-limits`. */
export function httpNvdbLimits(opts: FetchRouteOptions = {}): NvdbLimitTransport {
  return async (points, signal) => {
    const doFetch = opts.fetchImpl ?? fetch;
    const res = await doFetch(`${opts.baseUrl ?? ''}/api/route/nvdb-limits`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ points }),
      signal: signal ?? opts.signal,
    });
    if (!res.ok) throw new RoutingError(`nvdb limits failed (HTTP ${res.status})`);
    const json = (await res.json()) as { overrides?: SpeedLimitOverride[] };
    return json.overrides ?? [];
  };
}

/**
 * Ask the Atlas backend which ATK speed cameras (points and average-speed
 * sections) the route passes. Pair with `NavigationSession.setCameras`. Same
 * contract as {@link NvdbLimitTransport}: an empty result — no dataset on the
 * server, or a route outside Norway — is a normal answer, never an error.
 */
export type NvdbCameraTransport = (points: LatLng[], signal?: AbortSignal) => Promise<RouteCameras>;

/** {@link NvdbCameraTransport} backed by the backend's `/api/route/nvdb-cameras`. */
export function httpNvdbCameras(opts: FetchRouteOptions = {}): NvdbCameraTransport {
  return async (points, signal) => {
    const doFetch = opts.fetchImpl ?? fetch;
    const res = await doFetch(`${opts.baseUrl ?? ''}/api/route/nvdb-cameras`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ points }),
      signal: signal ?? opts.signal,
    });
    if (!res.ok) throw new RoutingError(`nvdb cameras failed (HTTP ${res.status})`);
    const json = (await res.json()) as { cameras?: RouteCameras };
    return json.cameras ?? { points: [], sections: [] };
  };
}

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
