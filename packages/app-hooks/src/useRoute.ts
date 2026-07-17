import type { LatLng } from '@atlas/core';
import {
  optimizeWaypointOrder,
  RoutingError,
  type RoutePath,
  type RouteQuery,
  type RouteResult,
  type RoutingProfile,
} from '@atlas/routing';
import { useCallback, useEffect, useRef, useState } from 'react';

export interface RouteWaypoint {
  /** Stable identity for markers and list rows across reorders. */
  id: number;
  pos: LatLng;
}

/**
 * Executes a routing query — the platform seam: plain server `fetchRoute` on
 * web, the offline-first provider (embedded Valhalla when a downloaded pack
 * covers the query, else the server) on Android. Must be referentially
 * stable across renders; a new identity aborts and reruns the active query.
 */
export type RouteFn = (query: RouteQuery, signal: AbortSignal) => Promise<RouteResult>;

/** Route-planning state: waypoints in, routed paths out, auto-refreshed. */
export interface RoutePlanner {
  active: boolean;
  profile: RoutingProfile;
  waypoints: RouteWaypoint[];
  roundTrip: boolean;
  roundTripKm: number;
  /** Routed paths (primary first, then alternatives); null while unroutable. */
  paths: RoutePath[] | null;
  selectedPath: number;
  loading: boolean;
  error: string | null;

  start: (at?: LatLng) => void;
  stop: () => void;
  setProfile: (profile: RoutingProfile) => void;
  /** Append a stop — or move the start when planning a round trip. */
  addWaypoint: (pos: LatLng) => void;
  insertWaypoint: (index: number, pos: LatLng) => void;
  moveWaypointTo: (id: number, pos: LatLng) => void;
  removeWaypoint: (id: number) => void;
  reorderWaypoint: (from: number, to: number) => void;
  reverse: () => void;
  clear: () => void;
  /** Reorder intermediate stops for a shorter tour (endpoints stay). */
  optimize: () => void;
  setRoundTrip: (on: boolean) => void;
  setRoundTripKm: (km: number) => void;
  /** Ask for a different loop of the same length. */
  newLoop: () => void;
  selectPath: (index: number) => void;
}

export function useRoute(route: RouteFn): RoutePlanner {
  const [active, setActive] = useState(false);
  const [profile, setProfile] = useState<RoutingProfile>('car');
  const [waypoints, setWaypoints] = useState<RouteWaypoint[]>([]);
  const [roundTrip, setRoundTripState] = useState(false);
  const [roundTripKm, setRoundTripKm] = useState(10);
  const [seed, setSeed] = useState(0);
  const [paths, setPaths] = useState<RoutePath[] | null>(null);
  const [selectedPath, setSelectedPath] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const idRef = useRef(1);
  const abortRef = useRef<AbortController | null>(null);

  const nextWaypoint = useCallback((pos: LatLng): RouteWaypoint => {
    return { id: idRef.current++, pos };
  }, []);

  // Re-route (debounced) whenever anything that affects the route changes.
  useEffect(() => {
    abortRef.current?.abort();
    const enough = roundTrip ? waypoints.length >= 1 : waypoints.length >= 2;
    if (!active || !enough) {
      setPaths(null);
      setError(null);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    const timer = setTimeout(async () => {
      const query: RouteQuery = roundTrip
        ? {
            profile,
            points: [waypoints[0]!.pos],
            roundTrip: { distanceM: roundTripKm * 1000, seed },
          }
        : {
            profile,
            points: waypoints.map((w) => w.pos),
            alternatives: waypoints.length === 2,
            // Street names ride on instructions — needed for "via …" labels
            // that tell the alternatives apart in the panel.
            instructions: waypoints.length === 2,
          };
      try {
        const result = await route(query, controller.signal);
        // A superseded request can resolve after its abort — don't paint it.
        if (controller.signal.aborted) return;
        setPaths(result.paths);
        setSelectedPath(0);
        setError(null);
        setLoading(false);
      } catch (err) {
        if (controller.signal.aborted) return; // superseded or panel closed
        setPaths(null);
        setLoading(false);
        setError(err instanceof RoutingError ? err.message : 'Routing service unavailable');
      }
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [active, profile, waypoints, roundTrip, roundTripKm, seed, route]);

  const start = useCallback(
    (at?: LatLng) => {
      setActive(true);
      if (at) setWaypoints((wps) => (wps.length === 0 ? [nextWaypoint(at)] : wps));
    },
    [nextWaypoint],
  );

  const stop = useCallback(() => {
    setActive(false);
    setWaypoints([]);
    setRoundTripState(false);
    setPaths(null);
    setError(null);
  }, []);

  const addWaypoint = useCallback(
    (pos: LatLng) => {
      setWaypoints((wps) => {
        // A round trip has exactly one anchor: adding again moves it.
        if (roundTrip) return [nextWaypoint(pos)];
        return [...wps, nextWaypoint(pos)];
      });
    },
    [roundTrip, nextWaypoint],
  );

  const insertWaypoint = useCallback(
    (index: number, pos: LatLng) => {
      setWaypoints((wps) => [...wps.slice(0, index), nextWaypoint(pos), ...wps.slice(index)]);
    },
    [nextWaypoint],
  );

  const moveWaypointTo = useCallback((id: number, pos: LatLng) => {
    setWaypoints((wps) => wps.map((w) => (w.id === id ? { ...w, pos } : w)));
  }, []);

  const removeWaypoint = useCallback((id: number) => {
    setWaypoints((wps) => wps.filter((w) => w.id !== id));
  }, []);

  const reorderWaypoint = useCallback((from: number, to: number) => {
    setWaypoints((wps) => {
      if (from === to || from < 0 || from >= wps.length || to < 0 || to >= wps.length) return wps;
      const next = [...wps];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved!);
      return next;
    });
  }, []);

  const reverse = useCallback(() => {
    setWaypoints((wps) => [...wps].reverse());
  }, []);

  const clear = useCallback(() => {
    setWaypoints([]);
  }, []);

  const optimize = useCallback(() => {
    setWaypoints((wps) => {
      const order = optimizeWaypointOrder(wps.map((w) => w.pos));
      return order.map((i) => wps[i]!);
    });
  }, []);

  const setRoundTrip = useCallback((on: boolean) => {
    setRoundTripState(on);
    // Entering loop mode keeps only the starting point.
    if (on) setWaypoints((wps) => wps.slice(0, 1));
  }, []);

  const newLoop = useCallback(() => {
    setSeed((s) => s + 1);
  }, []);

  return {
    active,
    profile,
    waypoints,
    roundTrip,
    roundTripKm,
    paths,
    selectedPath,
    loading,
    error,
    start,
    stop,
    setProfile,
    addWaypoint,
    insertWaypoint,
    moveWaypointTo,
    removeWaypoint,
    reorderWaypoint,
    reverse,
    clear,
    optimize,
    setRoundTrip,
    setRoundTripKm,
    newLoop,
    selectPath: setSelectedPath,
  };
}
