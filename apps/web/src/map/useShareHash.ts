import { encodeMapHash, type LatLng } from '@atlas/core';
import type { StoredRoutePlan } from '@atlas/app-hooks';
import type maplibregl from 'maplibre-gl';
import { useEffect } from 'react';

/**
 * Keeps the URL hash a complete share link: camera, dropped pin, and the route
 * plan the user is looking at. The whole app state that a link can carry lives
 * in one place here, so nothing can write a hash that drops someone else's
 * part of it (the camera used to be written from inside MapView, which knew
 * nothing about plans).
 *
 * Writes with `replaceState` — a share link is a view of the current page, not
 * a history entry per map pan.
 */
export function useShareHash(
  map: maplibregl.Map | null,
  pin: LatLng | null,
  plan: StoredRoutePlan | null,
): void {
  useEffect(() => {
    if (!map) return;
    const write = () => {
      const center = map.getCenter();
      history.replaceState(
        null,
        '',
        encodeMapHash({
          center: { lat: center.lat, lng: center.lng },
          zoom: map.getZoom(),
          pin: pin ?? undefined,
          route: plan
            ? {
                profile: plan.profile,
                points: plan.waypoints.map((w) => w.pos),
                roundTripKm: plan.roundTripKm,
              }
            : undefined,
        }),
      );
    };
    // Write once for pin/plan changes, then on every camera move.
    write();
    map.on('moveend', write);
    return () => {
      map.off('moveend', write);
    };
  }, [map, pin, plan]);
}
