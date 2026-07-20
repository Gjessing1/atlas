import type { LatLng } from '@atlas/core';
import {
  optimizeWaypointOrder,
  RoutingError,
  type RoutePath,
  type RouteQuery,
  type RouteResult,
  type RoutingProfile,
} from '@atlas/routing';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export interface RouteWaypoint {
  /** Stable identity for markers and list rows across reorders. */
  id: number;
  pos: LatLng;
  /**
   * Human label for the stop ("Oslo S"), when it came from a search hit, a
   * saved place, or a reverse geocode. Absent for a bare map click until the
   * platform resolves one; the UI falls back to coordinates.
   */
  name?: string;
}

/**
 * A plan in storable form: the stops and the settings that shaped them, with
 * no routed geometry and no waypoint ids (both are re-derived on restore).
 * Used for the shareable URL hash and for the device-local saved plan.
 */
export interface StoredRoutePlan {
  profile: RoutingProfile;
  waypoints: { pos: LatLng; name?: string }[];
  roundTripKm?: number;
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

  /**
   * Enter route mode, optionally seeding the first stop (e.g. from a dropped
   * pin). Returns that stop's id when it seeded one, so the caller can label
   * it — null when route mode already had stops.
   */
  start: (at?: LatLng, name?: string) => number | null;
  /**
   * Enter route mode with a whole plan (a shared link, or the plan this device
   * had open before a reload), replacing whatever is there. Ignored when the
   * plan has no stops.
   */
  restore: (plan: StoredRoutePlan) => void;
  /**
   * The current plan in storable form, or null when route mode is closed or
   * empty — the caller persists/shares this.
   */
  plan: StoredRoutePlan | null;
  stop: () => void;
  setProfile: (profile: RoutingProfile) => void;
  /**
   * Append a stop — or move the start when planning a round trip. Returns the
   * new stop's id, so a caller can label it once a lookup resolves.
   */
  addWaypoint: (pos: LatLng, name?: string) => number;
  insertWaypoint: (index: number, pos: LatLng, name?: string) => number;
  /** Move a stop; its label is dropped, since it no longer describes the spot. */
  moveWaypointTo: (id: number, pos: LatLng) => void;
  /**
   * Attach a label to an existing stop (e.g. an async reverse geocode). `at` is
   * the position the label was looked up for — a stop that has since moved or
   * gained a name keeps what it has.
   */
  nameWaypoint: (id: number, name: string, at: LatLng) => void;
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

  const nextWaypoint = useCallback((pos: LatLng, name?: string): RouteWaypoint => {
    return name === undefined ? { id: idRef.current++, pos } : { id: idRef.current++, pos, name };
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
            // that tell the alternatives apart in the panel. Walk, hike and
            // cycle routes ask for them however many stops there are: a ferry
            // is only detectable from maneuvers, and an unannounced boat leg
            // is worse on foot than a slightly larger response.
            instructions: waypoints.length === 2 || profile !== 'car',
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
    (at?: LatLng, name?: string) => {
      setActive(true);
      // Only seeds an empty plan; re-opening the panel keeps the existing stops.
      if (!at || waypoints.length > 0) return null;
      const wp = nextWaypoint(at, name);
      setWaypoints([wp]);
      return wp.id;
    },
    [waypoints.length, nextWaypoint],
  );

  const restore = useCallback(
    (plan: StoredRoutePlan) => {
      if (plan.waypoints.length === 0) return;
      const loop = plan.roundTripKm !== undefined;
      setActive(true);
      setProfile(plan.profile);
      setRoundTripState(loop);
      if (loop) setRoundTripKm(plan.roundTripKm!);
      // A loop has one anchor no matter how many stops the caller handed over.
      const stops = loop ? plan.waypoints.slice(0, 1) : plan.waypoints;
      setWaypoints(stops.map((w) => nextWaypoint(w.pos, w.name)));
    },
    [nextWaypoint],
  );

  const plan = useMemo<StoredRoutePlan | null>(() => {
    if (!active || waypoints.length === 0) return null;
    const stops = waypoints.map((w) =>
      w.name === undefined ? { pos: w.pos } : { pos: w.pos, name: w.name },
    );
    return roundTrip ? { profile, waypoints: stops, roundTripKm } : { profile, waypoints: stops };
  }, [active, profile, waypoints, roundTrip, roundTripKm]);

  const stop = useCallback(() => {
    setActive(false);
    setWaypoints([]);
    setRoundTripState(false);
    setPaths(null);
    setError(null);
  }, []);

  // The waypoint is built outside the updater: allocating its id inside would
  // burn two ids per call under StrictMode's double-invoke, and the caller
  // needs the id back to label the stop once a reverse geocode resolves.
  const addWaypoint = useCallback(
    (pos: LatLng, name?: string) => {
      const wp = nextWaypoint(pos, name);
      // A round trip has exactly one anchor: adding again moves it.
      setWaypoints((wps) => (roundTrip ? [wp] : [...wps, wp]));
      return wp.id;
    },
    [roundTrip, nextWaypoint],
  );

  const insertWaypoint = useCallback(
    (index: number, pos: LatLng, name?: string) => {
      const wp = nextWaypoint(pos, name);
      setWaypoints((wps) => [...wps.slice(0, index), wp, ...wps.slice(index)]);
      return wp.id;
    },
    [nextWaypoint],
  );

  const moveWaypointTo = useCallback((id: number, pos: LatLng) => {
    // Dragging a stop somewhere else invalidates whatever it was called.
    setWaypoints((wps) => wps.map((w) => (w.id === id ? { id: w.id, pos } : w)));
  }, []);

  const nameWaypoint = useCallback((id: number, name: string, at: LatLng) => {
    setWaypoints((wps) => {
      const target = wps.find((w) => w.id === id);
      // A lookup is in flight while the user keeps editing: the stop may have
      // been removed or dragged elsewhere, and the label would then describe
      // the wrong spot. Only apply it if the stop is still where it was asked
      // about, and still unnamed.
      if (!target || target.name !== undefined) return wps;
      if (target.pos.lat !== at.lat || target.pos.lng !== at.lng) return wps;
      return wps.map((w) => (w.id === id ? { ...w, name } : w));
    });
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
    restore,
    plan,
    stop,
    setProfile,
    addWaypoint,
    insertWaypoint,
    moveWaypointTo,
    nameWaypoint,
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
