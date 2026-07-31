import type { LatLng } from '@atlas/core';
import type { RouteProvider, RouteQuery, RouteResult } from '@atlas/routing';

import type { TrafficClosure } from './model.js';

export type TrafficClosureTransport = (
  route: readonly LatLng[],
  signal?: AbortSignal,
) => Promise<TrafficClosure[]>;

/** Same-origin/Atlas-server closure matcher. Empty means no live closure on this line. */
export function httpTrafficClosures(
  baseUrl = '',
  fetchImpl: typeof fetch = fetch,
): TrafficClosureTransport {
  return async (route, signal) => {
    const controller = new AbortController();
    const relay = () => controller.abort();
    signal?.addEventListener('abort', relay, { once: true });
    const timeout = setTimeout(() => controller.abort(), 5_000);
    try {
      const response = await fetchImpl(`${baseUrl}/api/traffic/closures`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ points: route }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`traffic closures failed (HTTP ${response.status})`);
      const body = (await response.json()) as { closures?: TrafficClosure[] };
      return body.closures ?? [];
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', relay);
    }
  };
}

const key = (point: LatLng): string => `${point.lat.toFixed(6)},${point.lng.toFixed(6)}`;

/**
 * Decorate any Valhalla provider with current road closures. The first route is
 * needed to know which of the national closures touch this journey; only when
 * one does do we ask Valhalla again with its edge excluded. One second pass
 * catches a closure on the detour without turning a bad feed into a loop.
 */
export function trafficAwareRouteProvider(
  provider: RouteProvider,
  closures: TrafficClosureTransport,
): RouteProvider {
  return {
    async route(query: RouteQuery, signal?: AbortSignal): Promise<RouteResult> {
      if (query.profile !== 'car') return provider.route(query, signal);
      let exclusions = [...(query.excludeLocations ?? [])];
      let result = await provider.route({ ...query, excludeLocations: exclusions }, signal);
      for (let pass = 0; pass < 2; pass++) {
        const path = result.paths[0];
        if (!path) return result;
        let matches: TrafficClosure[];
        try {
          matches = await closures(path.points, signal);
        } catch {
          // Traffic is live enhancement data. A stale/unreachable feed must not
          // make ordinary online or downloaded-pack routing unavailable.
          return result;
        }
        const known = new Set(exclusions.map(key));
        const fresh = matches
          .map((match) => match.position)
          .filter((point) => !known.has(key(point)));
        if (fresh.length === 0) return result;
        exclusions = [...exclusions, ...fresh].slice(0, 50);
        result = await provider.route({ ...query, excludeLocations: exclusions }, signal);
      }
      return result;
    },
  };
}
