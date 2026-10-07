import type { LatLng, RoutePlanState } from '@atlas/core';
import {
  closestPointOnRoute,
  defaultRoutePreferences,
  optimizeWaypointOrder,
  routeMixedPlan,
  ROUTING_PROFILES,
  RoutingError,
  type RoutePath,
  type RouteQuery,
  type RoutePreferences,
  type VehicleProfile,
  type RouteResult,
  type RoundTripDirection,
  type RoutingProfile,
  type RouteElevationTransport,
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
  /**
   * Exact NSR StopPlace selected in transit search. It is metadata beside the
   * coordinate, ignored by road routing and dropped whenever the point moves.
   */
  transitStopId?: string;
  /** Draw the leg from this point to the next directly, without road routing. */
  straightAfter?: boolean;
}

/**
 * A plan in storable form: the stops and the settings that shaped them, with
 * no routed geometry and no waypoint ids (both are re-derived on restore).
 * Used for the shareable URL hash and for the device-local saved plan.
 */
export interface StoredRoutePlan {
  profile: RoutingProfile;
  waypoints: { pos: LatLng; name?: string; transitStopId?: string; straightAfter?: boolean }[];
  /** The sole waypoint was supplied as the destination; the start is still empty. */
  missingStart?: boolean;
  roundTripKm?: number;
  roundTripDirection?: RoundTripDirection;
  /** Custom costing choices for this profile. */
  preferences?: Partial<RoutePreferences>;
}

/**
 * A stored plan in shareable form: the stops as bare coordinates, plus the loop
 * settings that shaped them. Stop *names* are deliberately dropped — they would
 * dominate the URL and the coordinates are the plan.
 *
 * One conversion, because a share link must mean the same thing wherever it was
 * built: web writes it into its address bar on every camera move, Android
 * builds it on demand for the OS share sheet.
 */
export function routePlanState(plan: StoredRoutePlan): RoutePlanState {
  const state: RoutePlanState = {
    profile: plan.profile,
    points: plan.waypoints.map((w) => w.pos),
  };
  const directLegs = plan.waypoints.flatMap((w, i) =>
    w.straightAfter && i < plan.waypoints.length - 1 ? [i] : [],
  );
  if (directLegs.length) state.directLegs = directLegs;
  if (plan.roundTripKm !== undefined) state.roundTripKm = plan.roundTripKm;
  if (plan.roundTripDirection !== undefined) state.roundTripDirection = plan.roundTripDirection;
  return state;
}

/**
 * Executes a routing query — the platform seam: plain server `fetchRoute` on
 * web, the offline-first provider (embedded Valhalla when a downloaded pack
 * covers the query, else the server) on Android. Its identity may change
 * between renders (a provider that closes over changing state, a test harness):
 * the hook reads it through a ref, so what triggers a re-route is the stops and
 * settings, never the function fetching them.
 */
export type RouteFn = (query: RouteQuery, signal: AbortSignal) => Promise<RouteResult>;

/**
 * A travel mode's trip time for the picker: the duration in ms, or `'none'`
 * when that mode cannot route the current plan (no path, or the mode was
 * refused offline). Absent from the map = not computed yet / still routing.
 */
export type ModeTime = number | 'none';

/** Route-planning state: waypoints in, routed paths out, auto-refreshed. */
export interface RoutePlanner {
  active: boolean;
  profile: RoutingProfile;
  preferences: RoutePreferences;
  waypoints: RouteWaypoint[];
  /** A Directions hand-off supplied the destination before an origin was available. */
  missingStart: boolean;
  roundTrip: boolean;
  roundTripKm: number;
  roundTripDirection: RoundTripDirection;
  /** Routed paths (primary first, then alternatives); null while unroutable. */
  paths: RoutePath[] | null;
  selectedPath: number;
  loading: boolean;
  error: string | null;
  /** Routed stops more than 75 m from the drawn path, keyed by waypoint id. */
  offPathM: Record<number, number>;
  /**
   * Trip time per road profile for the mode picker, so each mode can show its
   * duration ("🚗 24 min · 🚲 1 h 10") before one is committed to. Filled by a
   * debounced background pass over the current stops; only meaningful for a
   * point-to-point plan, so empty for a round trip. Transit's time is not here
   * — it comes from the journey board, not a costing.
   */
  modeTimes: Partial<Record<RoutingProfile, ModeTime>>;

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
  setPreference: <K extends keyof RoutePreferences>(key: K, value: RoutePreferences[K]) => void;
  /**
   * Append a stop — or move the start when planning a round trip. Returns the
   * new stop's id, so a caller can label it once a lookup resolves.
   */
  addWaypoint: (pos: LatLng, name?: string, transitStopId?: string) => number;
  /**
   * Append a stop *and* leave loop mode in one update — "Directions to here"
   * from a place card. Doing it as two calls looks equivalent and is not:
   * `addWaypoint` reads the round-trip flag from the render it was created in,
   * so a preceding `setRoundTrip(false)` has not landed yet and the loop's
   * anchor — the traveller's start — is replaced instead of kept.
   */
  addDestination: (pos: LatLng, name?: string, transitStopId?: string) => number;
  insertWaypoint: (index: number, pos: LatLng, name?: string, transitStopId?: string) => number;
  /** Move a stop; its label is dropped, since it no longer describes the spot. */
  moveWaypointTo: (id: number, pos: LatLng) => void;
  /** Preview a map drag without adding an undo entry for every move event. */
  previewWaypointMove: (id: number, pos: LatLng) => void;
  /** Finish a previewed drag as one undoable edit. */
  finishWaypointMove: (id: number, pos: LatLng) => void;
  /**
   * Point an existing stop somewhere else entirely, keeping its place in the
   * order. This is what "tap From and pick another address" means: appending
   * and then deleting would briefly route through both and shuffle the letters
   * on the map, so the swap has to be one operation.
   */
  replaceWaypoint: (id: number, pos: LatLng, name?: string, transitStopId?: string) => void;
  /**
   * Attach a label to an existing stop (e.g. an async reverse geocode). `at` is
   * the position the label was looked up for — a stop that has since moved or
   * gained a name keeps what it has.
   */
  nameWaypoint: (id: number, name: string, at: LatLng) => void;
  renameWaypoint: (id: number, name: string) => void;
  removeWaypoint: (id: number) => void;
  reorderWaypoint: (from: number, to: number) => void;
  setLegStraight: (id: number, straight: boolean) => void;
  makeStart: (id: number) => void;
  makeFinish: (id: number) => void;
  canUndo: boolean;
  canRedo: boolean;
  dragging: boolean;
  undo: () => void;
  redo: () => void;
  reverse: () => void;
  clear: () => void;
  /** Reorder intermediate stops for a shorter tour (endpoints stay). */
  optimize: () => void;
  setRoundTrip: (on: boolean) => void;
  setRoundTripKm: (km: number) => void;
  setRoundTripDirection: (direction: RoundTripDirection) => void;
  /** Ask for a different loop of the same length. */
  newLoop: () => void;
  selectPath: (index: number) => void;
}

export function useRoute(
  route: RouteFn,
  vehicle?: VehicleProfile | null,
  elevations?: RouteElevationTransport,
): RoutePlanner {
  const [active, setActive] = useState(false);
  const [profile, setProfile] = useState<RoutingProfile>('car');
  const [preferencesByProfile, setPreferencesByProfile] = useState<
    Partial<Record<RoutingProfile, Partial<RoutePreferences>>>
  >({});
  const preferences = useMemo<RoutePreferences>(
    () => ({
      ...defaultRoutePreferences(profile),
      ...preferencesByProfile[profile],
      // The vehicle rides in the driving preferences rather than beside them,
      // because that is the object both apps already hand to navigation when a
      // trip starts. Anything else would plan for the van and then drive as a
      // car. Non-driving modes never carry it: a height restriction means
      // nothing to a walker.
      ...(profile === 'car' && vehicle ? { vehicle } : {}),
    }),
    [profile, preferencesByProfile, vehicle],
  );
  const [waypoints, setWaypoints] = useState<RouteWaypoint[]>([]);
  const [missingStart, setMissingStart] = useState(false);
  type EditSnapshot = { waypoints: RouteWaypoint[]; missingStart: boolean };
  const waypointsRef = useRef(waypoints);
  const missingStartRef = useRef(missingStart);
  waypointsRef.current = waypoints;
  missingStartRef.current = missingStart;
  const editHistory = useRef<{ past: EditSnapshot[]; future: EditSnapshot[] }>({
    past: [],
    future: [],
  });
  const dragOrigins = useRef(new Map<number, EditSnapshot>());
  const [dragging, setDragging] = useState(false);
  const [historyVersion, setHistoryVersion] = useState(0);
  const snapshot = useCallback(
    (): EditSnapshot => ({
      waypoints: waypointsRef.current,
      missingStart: missingStartRef.current,
    }),
    [],
  );
  const applySnapshot = useCallback((next: EditSnapshot) => {
    waypointsRef.current = next.waypoints;
    missingStartRef.current = next.missingStart;
    setWaypoints(next.waypoints);
    setMissingStart(next.missingStart);
  }, []);
  const edit = useCallback(
    (next: EditSnapshot) => {
      const before = snapshot();
      if (before.waypoints === next.waypoints && before.missingStart === next.missingStart) return;
      editHistory.current.past.push(before);
      editHistory.current.future = [];
      applySnapshot(next);
      setHistoryVersion((version) => version + 1);
    },
    [snapshot, applySnapshot],
  );
  const resetHistory = useCallback(() => {
    editHistory.current = { past: [], future: [] };
    dragOrigins.current.clear();
    setDragging(false);
    setHistoryVersion((version) => version + 1);
  }, []);
  const undo = useCallback(() => {
    const previous = editHistory.current.past.pop();
    if (!previous) return;
    editHistory.current.future.push(snapshot());
    applySnapshot(previous);
    setHistoryVersion((version) => version + 1);
  }, [snapshot, applySnapshot]);
  const redo = useCallback(() => {
    const next = editHistory.current.future.pop();
    if (!next) return;
    editHistory.current.past.push(snapshot());
    applySnapshot(next);
    setHistoryVersion((version) => version + 1);
  }, [snapshot, applySnapshot]);
  const [roundTrip, setRoundTripState] = useState(false);
  const [roundTripKm, setRoundTripKm] = useState(10);
  const [roundTripDirection, setRoundTripDirection] = useState<RoundTripDirection>('either');
  const [seed, setSeed] = useState(0);
  const [paths, setPaths] = useState<RoutePath[] | null>(null);
  const [selectedPath, setSelectedPath] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offPathM, setOffPathM] = useState<Record<number, number>>({});
  const pendingSnap = useRef<{ id: number; pos: LatLng } | null>(null);
  const [modeTimes, setModeTimes] = useState<Partial<Record<RoutingProfile, ModeTime>>>({});
  const idRef = useRef(1);
  const abortRef = useRef<AbortController | null>(null);
  // The route fn may be a fresh closure every render; keep the latest in a ref
  // so the re-routing effects can call it without listing it as a dependency.
  // Depending on its identity would restart every query on each render — and,
  // with the background mode-times pass, spin into a render/request loop.
  const routeRef = useRef(route);
  routeRef.current = route;
  const elevationsRef = useRef(elevations);
  elevationsRef.current = elevations;

  const nextWaypoint = useCallback(
    (pos: LatLng, name?: string, transitStopId?: string): RouteWaypoint => ({
      id: idRef.current++,
      pos,
      ...(name === undefined ? {} : { name }),
      ...(transitStopId === undefined ? {} : { transitStopId }),
    }),
    [],
  );

  // Re-route (debounced) whenever anything that affects the route changes.
  useEffect(() => {
    abortRef.current?.abort();
    const enough = roundTrip ? waypoints.length >= 1 : waypoints.length >= 2;
    if (!active || !enough) {
      setPaths(null);
      setOffPathM({});
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
            preferences,
            // Every stop, not just the anchor: a loop through the places the
            // traveller planned, sized to the requested distance.
            points: waypoints.map((w) => w.pos),
            details: true,
            roundTrip: {
              distanceM: roundTripKm * 1000,
              seed,
              direction: roundTripDirection,
            },
          }
        : {
            profile,
            preferences,
            points: waypoints.map((w) => w.pos),
            alternatives: waypoints.length === 2,
            details: true,
            // Street names ride on instructions — needed for "via …" labels
            // that tell the alternatives apart in the panel. Walk, hike and
            // cycle routes ask for them however many stops there are: a ferry
            // is only detectable from maneuvers, and an unannounced boat leg
            // is worse on foot than a slightly larger response.
            instructions: waypoints.length === 2 || profile !== 'car',
          };
      try {
        const result = await routeMixedPlan(
          query,
          waypoints.map((waypoint) => waypoint.straightAfter === true),
          routeRef.current,
          elevationsRef.current,
          controller.signal,
        );
        // A superseded request can resolve after its abort — don't paint it.
        if (controller.signal.aborted) return;
        const primary = result.paths[0];
        const moved = pendingSnap.current;
        if (primary && moved) {
          pendingSnap.current = null;
          const current = waypointsRef.current.find((w) => w.id === moved.id);
          const closest = closestPointOnRoute(primary.points, moved.pos);
          const movedIndex = waypoints.findIndex((w) => w.id === moved.id);
          if (
            current &&
            current.pos.lat === moved.pos.lat &&
            current.pos.lng === moved.pos.lng &&
            closest &&
            closest.distanceM > 0.5 &&
            closest.distanceM <= 75 &&
            !current.straightAfter &&
            !waypoints[movedIndex - 1]?.straightAfter
          ) {
            const before = snapshot();
            applySnapshot({
              ...before,
              waypoints: before.waypoints.map((w) =>
                w.id === moved.id ? { ...w, pos: closest.point } : w,
              ),
            });
            return;
          }
        }
        const distances: Record<number, number> = {};
        if (primary) {
          waypoints.forEach((point, index) => {
            if (point.straightAfter || waypoints[index - 1]?.straightAfter) return;
            const closest = closestPointOnRoute(primary.points, point.pos);
            if (closest && closest.distanceM > 75)
              distances[point.id] = Math.round(closest.distanceM);
          });
        }
        setOffPathM(distances);
        setPaths(result.paths);
        setSelectedPath(0);
        setError(null);
        setLoading(false);
      } catch (err) {
        if (controller.signal.aborted) return; // superseded or panel closed
        setPaths(null);
        setOffPathM({});
        setLoading(false);
        setError(err instanceof RoutingError ? err.message : 'Routing service unavailable');
      }
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [
    active,
    profile,
    preferences,
    waypoints,
    roundTrip,
    roundTripKm,
    roundTripDirection,
    seed,
    snapshot,
    applySnapshot,
  ]);

  // Trip time for *every* mode, for the picker's "🚗 24 min · 🚲 1 h 10" row.
  // The main effect above only routes the selected profile; this fills in the
  // rest with one debounced background pass per stop edit — lightweight queries
  // (no alternatives, no instructions) fired in parallel, each chip filling as
  // it resolves. The selected profile uses its current customization, so its
  // chip never advertises the default route's time beside a customized result.
  // Point-to-point only — a round trip's fixed-length loops aren't comparable
  // across modes, and transit is timed by its own board, not a costing.
  useEffect(() => {
    if (!active || roundTrip || waypoints.length < 2 || waypoints.some((w) => w.straightAfter)) {
      setModeTimes({});
      return;
    }
    const points = waypoints.map((w) => w.pos);
    const controller = new AbortController();
    const timer = setTimeout(() => {
      for (const { id } of ROUTING_PROFILES) {
        routeRef
          .current(
            {
              profile: id,
              ...(id === profile ? { preferences } : {}),
              points,
              alternatives: false,
              instructions: false,
            },
            controller.signal,
          )
          .then((result) => {
            if (controller.signal.aborted) return;
            const best = result.paths[0];
            setModeTimes((prev) => ({ ...prev, [id]: best ? best.timeMs : 'none' }));
          })
          .catch(() => {
            // A real "no route for this mode" and a transient failure look the
            // same to the picker: either way this mode has no time to show.
            if (!controller.signal.aborted) setModeTimes((prev) => ({ ...prev, [id]: 'none' }));
          });
      }
    }, 400);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [active, roundTrip, waypoints, profile, preferences]);

  const start = useCallback(
    (at?: LatLng, name?: string) => {
      setActive(true);
      if (waypointsRef.current.length === 0) {
        missingStartRef.current = false;
        setMissingStart(false);
      }
      // Only seeds an empty plan; re-opening the panel keeps the existing stops.
      if (!at || waypointsRef.current.length > 0) return null;
      const wp = nextWaypoint(at, name);
      edit({ waypoints: [wp], missingStart: false });
      return wp.id;
    },
    [nextWaypoint, edit],
  );

  const restore = useCallback(
    (plan: StoredRoutePlan) => {
      if (plan.waypoints.length === 0) return;
      const loop = plan.roundTripKm !== undefined;
      setActive(true);
      setProfile(plan.profile);
      setPreferencesByProfile((current) => {
        const { [plan.profile]: _discarded, ...otherProfiles } = current;
        return plan.preferences
          ? { ...otherProfiles, [plan.profile]: { ...plan.preferences } }
          : otherProfiles;
      });
      setRoundTripState(loop);
      if (loop) {
        setRoundTripKm(plan.roundTripKm!);
        setRoundTripDirection(plan.roundTripDirection ?? 'either');
      }
      applySnapshot({
        waypoints: plan.waypoints.map((w) => ({
          ...nextWaypoint(w.pos, w.name, w.transitStopId),
          ...(w.straightAfter ? { straightAfter: true } : {}),
        })),
        missingStart: plan.missingStart === true && plan.waypoints.length === 1,
      });
      resetHistory();
    },
    [nextWaypoint, applySnapshot, resetHistory],
  );

  const plan = useMemo<StoredRoutePlan | null>(() => {
    if (!active || waypoints.length === 0) return null;
    const stops = waypoints.map((w) => ({
      pos: w.pos,
      ...(w.name === undefined ? {} : { name: w.name }),
      ...(w.transitStopId === undefined ? {} : { transitStopId: w.transitStopId }),
      ...(w.straightAfter ? { straightAfter: true } : {}),
    }));
    const custom = preferencesByProfile[profile];
    const base =
      custom && Object.keys(custom).length > 0
        ? {
            profile,
            waypoints: stops,
            preferences: custom,
            ...(missingStart ? { missingStart } : {}),
          }
        : { profile, waypoints: stops, ...(missingStart ? { missingStart } : {}) };
    return roundTrip ? { ...base, roundTripKm, roundTripDirection } : base;
  }, [
    active,
    profile,
    preferencesByProfile,
    waypoints,
    roundTrip,
    roundTripKm,
    roundTripDirection,
    missingStart,
  ]);

  const setPreference = useCallback(
    <K extends keyof RoutePreferences>(key: K, value: RoutePreferences[K]) => {
      setPreferencesByProfile((current) => ({
        ...current,
        [profile]: { ...current[profile], [key]: value },
      }));
    },
    [profile],
  );

  const stop = useCallback(() => {
    setActive(false);
    applySnapshot({ waypoints: [], missingStart: false });
    resetHistory();
    setRoundTripState(false);
    setRoundTripDirection('either');
    setPaths(null);
    setError(null);
  }, [applySnapshot, resetHistory]);

  // The waypoint is built outside the updater: allocating its id inside would
  // burn two ids per call under StrictMode's double-invoke, and the caller
  // needs the id back to label the stop once a reverse geocode resolves.
  const addWaypoint = useCallback(
    (pos: LatLng, name?: string, transitStopId?: string) => {
      const wp = nextWaypoint(pos, name, transitStopId);
      const before = snapshot();
      edit({
        waypoints: before.missingStart ? [wp, ...before.waypoints] : [...before.waypoints, wp],
        missingStart: false,
      });
      return wp.id;
    },
    [nextWaypoint, snapshot, edit],
  );

  // Both halves of "route me there" in one commit, so neither reads the
  // other's stale state: a loop's anchor becomes the start it always was.
  const addDestination = useCallback(
    (pos: LatLng, name?: string, transitStopId?: string) => {
      const wp = nextWaypoint(pos, name, transitStopId);
      setRoundTripState(false);
      const before = snapshot();
      edit({ waypoints: [...before.waypoints, wp], missingStart: before.waypoints.length === 0 });
      return wp.id;
    },
    [nextWaypoint, snapshot, edit],
  );

  const insertWaypoint = useCallback(
    (index: number, pos: LatLng, name?: string, transitStopId?: string) => {
      const wp = nextWaypoint(pos, name, transitStopId);
      const before = snapshot();
      const prior = before.waypoints[index - 1];
      if (prior?.straightAfter) wp.straightAfter = true;
      edit({
        waypoints: [...before.waypoints.slice(0, index), wp, ...before.waypoints.slice(index)],
        missingStart: index === 0 ? false : before.missingStart,
      });
      return wp.id;
    },
    [nextWaypoint, snapshot, edit],
  );

  const moveWaypointTo = useCallback(
    (id: number, pos: LatLng) => {
      const before = snapshot();
      if (!before.waypoints.some((w) => w.id === id)) return;
      edit({
        ...before,
        waypoints: before.waypoints.map((w) =>
          w.id === id ? { id: w.id, pos, ...(w.straightAfter ? { straightAfter: true } : {}) } : w,
        ),
      });
    },
    [snapshot, edit],
  );

  const previewWaypointMove = useCallback(
    (id: number, pos: LatLng) => {
      const before = snapshot();
      if (!before.waypoints.some((w) => w.id === id)) return;
      if (!dragOrigins.current.has(id)) dragOrigins.current.set(id, before);
      setDragging(true);
      applySnapshot({
        ...before,
        waypoints: before.waypoints.map((w) =>
          w.id === id ? { id: w.id, pos, ...(w.straightAfter ? { straightAfter: true } : {}) } : w,
        ),
      });
    },
    [snapshot, applySnapshot],
  );

  const finishWaypointMove = useCallback(
    (id: number, pos: LatLng) => {
      const before = dragOrigins.current.get(id) ?? snapshot();
      dragOrigins.current.delete(id);
      setDragging(false);
      const current = snapshot();
      const origin = before.waypoints.find((w) => w.id === id);
      if (!origin || (origin.pos.lat === pos.lat && origin.pos.lng === pos.lng)) {
        applySnapshot(before);
        return;
      }
      editHistory.current.past.push(before);
      editHistory.current.future = [];
      pendingSnap.current = { id, pos };
      applySnapshot({
        ...current,
        waypoints: current.waypoints.map((w) =>
          w.id === id ? { id: w.id, pos, ...(w.straightAfter ? { straightAfter: true } : {}) } : w,
        ),
      });
      setHistoryVersion((version) => version + 1);
    },
    [snapshot, applySnapshot],
  );

  const replaceWaypoint = useCallback(
    (id: number, pos: LatLng, name?: string, transitStopId?: string) => {
      const before = snapshot();
      edit({
        ...before,
        waypoints: before.waypoints.map((w) =>
          w.id === id
            ? {
                id: w.id,
                pos,
                ...(w.straightAfter ? { straightAfter: true } : {}),
                ...(name === undefined ? {} : { name }),
                ...(transitStopId === undefined ? {} : { transitStopId }),
              }
            : w,
        ),
      });
    },
    [snapshot, edit],
  );

  const nameWaypoint = useCallback(
    (id: number, name: string, at: LatLng) => {
      const before = snapshot();
      const target = before.waypoints.find((w) => w.id === id);
      // A lookup is in flight while the user keeps editing: the stop may have
      // been removed or dragged elsewhere, and the label would then describe
      // the wrong spot. Only apply it if the stop is still where it was asked
      // about, and still unnamed.
      if (!target || target.name !== undefined) return;
      if (target.pos.lat !== at.lat || target.pos.lng !== at.lng) return;
      applySnapshot({
        ...before,
        waypoints: before.waypoints.map((w) => (w.id === id ? { ...w, name } : w)),
      });
    },
    [snapshot, applySnapshot],
  );

  const renameWaypoint = useCallback(
    (id: number, name: string) => {
      const before = snapshot();
      if (!before.waypoints.some((w) => w.id === id)) return;
      edit({
        ...before,
        waypoints: before.waypoints.map((w) =>
          w.id === id ? { ...w, name: name.trim() || undefined } : w,
        ),
      });
    },
    [snapshot, edit],
  );

  const removeWaypoint = useCallback(
    (id: number) => {
      const before = snapshot();
      if (!before.waypoints.some((w) => w.id === id)) return;
      edit({ ...before, waypoints: before.waypoints.filter((w) => w.id !== id) });
    },
    [snapshot, edit],
  );

  const reorderWaypoint = useCallback(
    (from: number, to: number) => {
      const before = snapshot();
      const wps = before.waypoints;
      if (from === to || from < 0 || from >= wps.length || to < 0 || to >= wps.length) return;
      const next = [...wps];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved!);
      // Reordering changes which pair a leg mode connects; do not silently
      // apply an old straight choice to a new pair of stops.
      edit({ ...before, waypoints: next.map(({ straightAfter: _straightAfter, ...w }) => w) });
    },
    [snapshot, edit],
  );

  const setLegStraight = useCallback(
    (id: number, straight: boolean) => {
      if (roundTrip) return;
      const before = snapshot();
      const index = before.waypoints.findIndex((w) => w.id === id);
      if (index < 0 || index >= before.waypoints.length - 1) return;
      if (Boolean(before.waypoints[index]!.straightAfter) === straight) return;
      edit({
        ...before,
        waypoints: before.waypoints.map((w) =>
          w.id === id ? { ...w, straightAfter: straight || undefined } : w,
        ),
      });
    },
    [snapshot, edit, roundTrip],
  );

  const makeStart = useCallback(
    (id: number) => {
      const index = waypointsRef.current.findIndex((w) => w.id === id);
      if (index > 0) reorderWaypoint(index, 0);
    },
    [reorderWaypoint],
  );
  const makeFinish = useCallback(
    (id: number) => {
      const index = waypointsRef.current.findIndex((w) => w.id === id);
      if (index >= 0 && index < waypointsRef.current.length - 1)
        reorderWaypoint(index, waypointsRef.current.length - 1);
    },
    [reorderWaypoint],
  );

  const reverse = useCallback(() => {
    const before = snapshot();
    const reversed = [...before.waypoints].reverse().map((w, i, all) => ({
      ...w,
      straightAfter:
        i < all.length - 1
          ? before.waypoints[before.waypoints.length - 2 - i]?.straightAfter
          : undefined,
    }));
    edit({ ...before, waypoints: reversed });
  }, [snapshot, edit]);

  const clear = useCallback(() => {
    applySnapshot({ waypoints: [], missingStart: false });
    resetHistory();
  }, [applySnapshot, resetHistory]);

  const optimize = useCallback(() => {
    const before = snapshot();
    const order = optimizeWaypointOrder(before.waypoints.map((w) => w.pos));
    edit({
      ...before,
      waypoints: order.map((i) => {
        const { straightAfter: _straightAfter, ...w } = before.waypoints[i]!;
        return w;
      }),
    });
  }, [snapshot, edit]);

  // Loop mode is a change of *shape*, not a new plan: the stops entered so far
  // are kept and the route simply comes back to the start through them. It used
  // to drop everything but the starting point, so ticking "round trip" on a
  // planned route silently deleted the destination and drew an arbitrary loop
  // of the requested length instead.
  const setRoundTrip = useCallback((on: boolean) => {
    setRoundTripState(on);
    if (on) {
      missingStartRef.current = false;
      setMissingStart(false);
    }
  }, []);

  const newLoop = useCallback(() => {
    setSeed((s) => s + 1);
  }, []);

  const canUndo = useMemo(() => editHistory.current.past.length > 0, [historyVersion]);
  const canRedo = useMemo(() => editHistory.current.future.length > 0, [historyVersion]);

  return {
    active,
    profile,
    preferences,
    waypoints,
    missingStart,
    roundTrip,
    roundTripKm,
    roundTripDirection,
    paths,
    selectedPath,
    loading,
    error,
    offPathM,
    modeTimes,
    start,
    restore,
    plan,
    stop,
    setProfile,
    setPreference,
    addWaypoint,
    addDestination,
    insertWaypoint,
    moveWaypointTo,
    previewWaypointMove,
    finishWaypointMove,
    replaceWaypoint,
    nameWaypoint,
    renameWaypoint,
    removeWaypoint,
    reorderWaypoint,
    setLegStraight,
    makeStart,
    makeFinish,
    canUndo,
    canRedo,
    dragging,
    undo,
    redo,
    reverse,
    clear,
    optimize,
    setRoundTrip,
    setRoundTripKm,
    setRoundTripDirection,
    newLoop,
    selectPath: setSelectedPath,
  };
}
