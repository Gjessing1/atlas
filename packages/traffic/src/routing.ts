import type { LatLng } from '@atlas/core';
import type { RouteProvider, RouteQuery, RouteResult } from '@atlas/routing';

import { applyTrafficDelay, type TrafficDelay } from './delay.js';
import type { TrafficClosure } from './model.js';

export type TrafficClosureTransport = (
  route: readonly LatLng[],
  signal?: AbortSignal,
) => Promise<TrafficClosure[]>;

export type TrafficDelayTransport = (
  route: readonly LatLng[],
  signal?: AbortSignal,
) => Promise<TrafficDelay>;

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

/** Same-origin/Atlas-server corridor travel times, matched onto this line. */
export function httpTrafficDelay(
  baseUrl = '',
  fetchImpl: typeof fetch = fetch,
): TrafficDelayTransport {
  return async (route, signal) => {
    const controller = new AbortController();
    const relay = () => controller.abort();
    signal?.addEventListener('abort', relay, { once: true });
    const timeout = setTimeout(() => controller.abort(), 5_000);
    try {
      const response = await fetchImpl(`${baseUrl}/api/traffic/travel-times`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ points: route }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`travel times failed (HTTP ${response.status})`);
      return (await response.json()) as TrafficDelay;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', relay);
    }
  };
}

const key = (point: LatLng): string => `${point.lat.toFixed(6)},${point.lng.toFixed(6)}`;

/**
 * Decorate any Valhalla provider with current road closures, then with the
 * measured travel time of the corridors the finished route runs on.
 *
 * The order matters and is not interchangeable. A closure changes *which roads*
 * the route uses, so it has to be settled before anything is priced; the
 * corridor measurement only changes *how long* the chosen roads take, so it is
 * applied once, to the line that survived. The first route is needed to know
 * which of the national closures touch this journey; only when one does do we
 * ask Valhalla again with its edge excluded. One second pass catches a closure
 * on the detour without turning a bad feed into a loop.
 */
export function trafficAwareRouteProvider(
  provider: RouteProvider,
  closures: TrafficClosureTransport,
  delays?: TrafficDelayTransport,
): RouteProvider {
  const priced = async (result: RouteResult, signal?: AbortSignal): Promise<RouteResult> => {
    if (!delays || result.paths.length === 0) return result;
    try {
      // Every offered path is priced, not just the primary: a preview lists
      // them side by side, so one line carrying its measured congestion while
      // the others show free-flow times would read as the others being
      // quicker. `sortRouteChoices` still ranks them on the engine's own
      // schedule, so what the measurement changes is the number shown, never
      // which route is recommended.
      const measured = await Promise.all(result.paths.map((path) => delays(path.points, signal)));
      return {
        paths: result.paths.map((path, index) =>
          applyTrafficDelay(path, measured[index] ?? { delayMs: 0, segments: [], measuredAt: '' }),
        ),
      };
    } catch {
      // Traffic is enhancement data: an unreachable feed leaves the engine's
      // own estimate standing rather than failing the route.
      return result;
    }
  };

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
          return priced(result, signal);
        }
        const known = new Set(exclusions.map(key));
        const fresh = matches
          .map((match) => match.position)
          .filter((point) => !known.has(key(point)));
        if (fresh.length === 0) return priced(result, signal);
        exclusions = [...exclusions, ...fresh].slice(0, 50);
        result = await provider.route({ ...query, excludeLocations: exclusions }, signal);
      }
      return priced(result, signal);
    },
  };
}
