import type { LatLng } from '@atlas/core';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { RoutePlanner } from './useRoute.js';

/** Platform seam: one current fix, or null when refused/unavailable. */
export type GetLocationFn = () => Promise<LatLng | null>;

export interface Directions {
  /** True while a Directions tap is still waiting for the origin fix. */
  locatingOrigin: boolean;
  /** Open the planner routed to this point. */
  planTo: (dest: LatLng, name?: string) => void;
}

/**
 * "Directions to here" from a place card, shared by both apps: hand the point
 * to the route planner, which is where every travel-mode decision happens —
 * including public transport, which a card cannot offer because it has no
 * journey board. Having the card pick a mode meant two mode pickers with
 * different visual languages, and which one you got depended on how the place
 * was opened.
 *
 * The place's *name* goes with it — the old transit hand-off dropped it and the
 * planner opened showing bare coordinates for somewhere the user had just
 * picked by name. Seeding the current position as the start is a convenience,
 * not a requirement: with no fix the panel opens asking for a start.
 *
 * A round trip in progress becomes a point-to-point plan from its anchor: that
 * anchor is where the traveller already said they are, so it is the start, not
 * something to overwrite.
 */
export function useDirections(route: RoutePlanner, getMyLocation: GetLocationFn): Directions {
  const [locatingOrigin, setLocatingOrigin] = useState(false);
  // Each Directions tap gets a sequence number, so a fix that arrives after
  // the user has moved on can tell that it is stale.
  const seqRef = useRef(0);
  const routeRef = useRef(route);
  routeRef.current = route;
  const locateRef = useRef(getMyLocation);
  locateRef.current = getMyLocation;

  const planTo = useCallback(
    (dest: LatLng, name?: string) => {
      const hadPlan = route.waypoints.length > 0;
      const seq = ++seqRef.current;

      // Transition immediately. Geolocation and routing happen behind the
      // visible panel instead of making the Directions button appear frozen for
      // several seconds. The destination is useful even without a fix.
      route.start();
      const destinationId = route.addDestination(dest, name);

      if (hadPlan) {
        setLocatingOrigin(false);
        return;
      }
      setLocatingOrigin(true);
      void locateRef
        .current()
        .then((origin) => {
          if (!origin || seq !== seqRef.current) return;
          const current = routeRef.current;
          const onlyStop = current.waypoints[0];
          // A user edit wins over the late fix. Only fill the untouched
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
    [route],
  );

  // Closing the planner while a fix is pending prevents that fix from
  // resurrecting or editing a route the user has dismissed.
  useEffect(() => {
    if (route.active) return;
    seqRef.current++;
    setLocatingOrigin(false);
  }, [route.active]);

  return { locatingOrigin, planTo };
}
