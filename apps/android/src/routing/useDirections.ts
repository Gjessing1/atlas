import type { LatLng } from '@atlas/core';
import * as Location from 'expo-location';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { RoutePlanner } from './useRoute';

/** Indoors, a current-position request can stay pending forever — cap it. */
const FIX_TIMEOUT_MS = 8_000;
/** How stale a cached fix may be when the fresh one never arrives. */
const LAST_KNOWN_MAX_AGE_MS = 120_000;

export interface Directions {
  /**
   * A GPS fix for the route planner's "My location" shortcut, or null when the
   * permission is refused or no fix is available — the panel then just says so
   * rather than silently doing nothing.
   */
  getMyLocation: () => Promise<LatLng | null>;
  /** True while a Directions tap is still waiting for the origin fix. */
  locatingOrigin: boolean;
  /** Open the planner routed to this point. */
  planTo: (dest: LatLng, name?: string) => void;
}

export function useDirections(route: RoutePlanner): Directions {
  const [locatingOrigin, setLocatingOrigin] = useState(false);
  // Each Directions tap gets a sequence number, so a fix that arrives after
  // the user has moved on can tell that it is stale.
  const seqRef = useRef(0);
  const routeRef = useRef(route);
  routeRef.current = route;

  const getMyLocation = useCallback(async (): Promise<LatLng | null> => {
    try {
      const fg = await Location.requestForegroundPermissionsAsync();
      if (!fg.granted) return null;
      // The planner is already visible, so it must also stop saying "Getting
      // location…" and remain editable when no new fix arrives.
      const fresh = await Promise.race([
        Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), FIX_TIMEOUT_MS)),
      ]);
      const pos =
        fresh ?? (await Location.getLastKnownPositionAsync({ maxAge: LAST_KNOWN_MAX_AGE_MS }));
      return pos ? { lat: pos.coords.latitude, lng: pos.coords.longitude } : null;
    } catch {
      return null;
    }
  }, []);

  /**
   * "Directions" on the place card: hand the point to the route planner, which
   * is where every travel-mode decision now happens. The place's *name* goes
   * with it — the old transit hand-off dropped it and the planner opened
   * showing bare coordinates for somewhere the user had just picked by name.
   * Seeding the current position as the start is a convenience, not a
   * requirement: with no fix the panel opens asking for a start.
   */
  const planTo = useCallback(
    (dest: LatLng, name?: string) => {
      const hadPlan = route.waypoints.length > 0;
      const seq = ++seqRef.current;

      // Transition immediately. GPS and routing happen behind the visible panel
      // instead of making the Directions button appear frozen for several
      // seconds. The destination is useful even when location is unavailable.
      route.start();
      route.setRoundTrip(false);
      const destinationId = route.addWaypoint(dest, name);

      if (hadPlan) {
        setLocatingOrigin(false);
        return;
      }
      setLocatingOrigin(true);
      void getMyLocation()
        .then((origin) => {
          if (!origin || seq !== seqRef.current) return;
          const current = routeRef.current;
          const onlyStop = current.waypoints[0];
          // A user edit wins over the late GPS result. Only fill the untouched
          // destination-only plan that this exact Directions tap created.
          if (
            current.active &&
            current.waypoints.length === 1 &&
            onlyStop?.id === destinationId &&
            onlyStop.pos.lat === dest.lat &&
            onlyStop.pos.lng === dest.lng
          ) {
            current.insertWaypoint(0, origin, 'My location');
          }
        })
        .finally(() => {
          if (seq === seqRef.current) setLocatingOrigin(false);
        });
    },
    [route, getMyLocation],
  );

  // Closing the planner while a fix is pending prevents that fix from
  // resurrecting or editing a route the user has dismissed.
  useEffect(() => {
    if (route.active) return;
    seqRef.current++;
    setLocatingOrigin(false);
  }, [route.active]);

  return { getMyLocation, locatingOrigin, planTo };
}
