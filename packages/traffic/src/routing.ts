import { encodePolyline, type LatLng } from '@atlas/core';
import type { RoadWeatherRoute, RouteProvider, RouteQuery, RouteResult } from '@atlas/routing';

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

export type RoadWeatherTransport = (
  route: readonly LatLng[],
  /** Expected duration of the whole route. */
  durationMs: number,
  signal?: AbortSignal,
  /** Metres already travelled along `route`; stations are timed from there. */
  traveledM?: number,
) => Promise<RoadWeatherRoute>;

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
      let response = await fetchImpl(`${baseUrl}/api/traffic/closures`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shape: encodePolyline(route, 6) }),
        signal: controller.signal,
      });
      // During an OTA rollout a new Android bundle can briefly meet the
      // previous backend. Retry its old JSON-point contract once.
      if (response.status === 400) {
        response = await fetchImpl(`${baseUrl}/api/traffic/closures`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ points: route }),
          signal: controller.signal,
        });
      }
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
      let response = await fetchImpl(`${baseUrl}/api/traffic/travel-times`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shape: encodePolyline(route, 6) }),
        signal: controller.signal,
      });
      if (response.status === 400) {
        response = await fetchImpl(`${baseUrl}/api/traffic/travel-times`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ points: route }),
          signal: controller.signal,
        });
      }
      if (!response.ok) throw new Error(`travel times failed (HTTP ${response.status})`);
      return (await response.json()) as TrafficDelay;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', relay);
    }
  };
}

/** Same-origin route check against measured and forecast NPRA road conditions. */
export function httpRoadWeather(
  baseUrl = '',
  fetchImpl: typeof fetch = fetch,
): RoadWeatherTransport {
  return async (route, durationMs, signal, traveledM = 0) => {
    const controller = new AbortController();
    const relay = () => controller.abort();
    signal?.addEventListener('abort', relay, { once: true });
    const timeout = setTimeout(() => controller.abort(), 8_000);
    try {
      const response = await fetchImpl(`${baseUrl}/api/traffic/road-weather`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          shape: encodePolyline(route, 6),
          durationMs,
          ...(traveledM > 0 ? { traveledM: Math.round(traveledM) } : {}),
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`road weather failed (HTTP ${response.status})`);
      return (await response.json()) as RoadWeatherRoute;
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
  roadWeather?: RoadWeatherTransport,
): RouteProvider {
  const liveData = async (result: RouteResult, signal?: AbortSignal): Promise<RouteResult> => {
    if ((!delays && !roadWeather) || result.paths.length === 0) return result;
    // Each enhancement fails independently. A dead forecast must not discard
    // a valid congestion correction (or vice versa), and neither can make an
    // ordinary route fail.
    const paths = await Promise.all(
      result.paths.map(async (original) => {
        const [delayResult, weatherResult] = await Promise.allSettled([
          delays?.(original.points, signal),
          roadWeather?.(original.points, original.timeMs, signal),
        ]);
        let path = original;
        if (delayResult.status === 'fulfilled' && delayResult.value) {
          path = applyTrafficDelay(path, delayResult.value);
        }
        if (weatherResult.status === 'fulfilled' && weatherResult.value) {
          path = { ...path, roadWeather: weatherResult.value };
        }
        return path;
      }),
    );
    return { paths };
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
          return liveData(result, signal);
        }
        const known = new Set(exclusions.map(key));
        const fresh = matches
          .map((match) => match.position)
          .filter((point) => !known.has(key(point)));
        if (fresh.length === 0) return liveData(result, signal);
        exclusions = [...exclusions, ...fresh].slice(0, 50);
        result = await provider.route({ ...query, excludeLocations: exclusions }, signal);
      }
      return liveData(result, signal);
    },
  };
}
