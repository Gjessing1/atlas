import { lineStringFeature } from '@atlas/core';
import { zoomForSpeed } from '@atlas/navigation';
import maplibregl from 'maplibre-gl';
import { useEffect, useRef, useState } from 'react';
import type { WebNavController } from '../nav/useWebNavigation.js';

const SOURCE_ID = 'atlas-nav';
const CASING = 'atlas-nav-casing';
const LINE = 'atlas-nav-line';
const NAV_LAYERS = [CASING, LINE];

export interface NavFollowControls {
  /** True after a manual pan/rotate/zoom; the camera stops following. */
  followPaused: boolean;
  resumeFollow: () => void;
  followMode: 'course' | 'north';
  toggleFollowMode: () => void;
}

/**
 * Renders active turn-by-turn navigation on the map — the route line, the
 * snapped location puck, the destination flag — and drives the course-up
 * camera follow. Panning/rotating by hand pauses the follow; `resumeFollow`
 * (the banner's recenter button) re-engages it.
 */
export function useNavLayers(map: maplibregl.Map | null, nav: WebNavController): NavFollowControls {
  const [followPaused, setFollowPaused] = useState(false);
  const [followMode, setFollowMode] = useState<'course' | 'north'>('course');
  const active = nav.phase === 'navigating' || nav.phase === 'rerouting';

  // ---- route line (style-swap resilient, like useRouteLayers) ----
  useEffect(() => {
    if (!map) return;
    const coords = active ? nav.routeCoords : [];
    let cancelled = false;

    const sync = () => {
      if (cancelled || !map.isStyleLoaded()) return; // re-runs on style.load/idle
      if (coords.length < 2) {
        for (const id of NAV_LAYERS) if (map.getLayer(id)) map.removeLayer(id);
        if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
        return;
      }
      const data = lineStringFeature(coords);
      const source = map.getSource(SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
      if (source) {
        source.setData(data);
      } else {
        map.addSource(SOURCE_ID, { type: 'geojson', data });
      }
      if (!map.getLayer(CASING)) {
        const line = { 'line-cap': 'round', 'line-join': 'round' } as const;
        map.addLayer({
          id: CASING,
          type: 'line',
          source: SOURCE_ID,
          layout: line,
          paint: { 'line-color': '#ffffff', 'line-width': 9, 'line-opacity': 0.8 },
        });
        map.addLayer({
          id: LINE,
          type: 'line',
          source: SOURCE_ID,
          layout: line,
          paint: { 'line-color': '#2b6cff', 'line-width': 6, 'line-opacity': 0.9 },
        });
      }
    };

    sync();
    map.on('style.load', sync);
    map.on('idle', sync);
    return () => {
      cancelled = true;
      map.off('style.load', sync);
      map.off('idle', sync);
    };
  }, [map, active, nav.routeCoords]);

  // ---- location puck (snapped position) + destination flag ----
  const puckRef = useRef<maplibregl.Marker | null>(null);
  const destRef = useRef<maplibregl.Marker | null>(null);
  useEffect(() => {
    if (!map) return;
    const snapped = active ? nav.state?.snapped : undefined;
    if (snapped) {
      if (!puckRef.current) {
        const el = document.createElement('div');
        el.className = 'nav-puck';
        puckRef.current = new maplibregl.Marker({ element: el });
      }
      puckRef.current.setLngLat(snapped).addTo(map);
      // Grey when the GPS signal is lost, so a frozen puck reads as
      // "no signal", not "we're still here".
      puckRef.current.getElement().classList.toggle('nav-puck-lost', nav.state?.fix === 'lost');
    } else {
      puckRef.current?.remove();
      puckRef.current = null;
    }
    const dest = active ? nav.destination : null;
    if (dest) {
      if (!destRef.current) {
        const el = document.createElement('div');
        el.className = 'nav-dest-marker';
        el.textContent = '🏁';
        destRef.current = new maplibregl.Marker({ element: el, anchor: 'bottom' });
      }
      destRef.current.setLngLat(dest).addTo(map);
    } else {
      destRef.current?.remove();
      destRef.current = null;
    }
  }, [map, active, nav.state?.snapped, nav.state?.fix, nav.destination]);
  useEffect(
    () => () => {
      puckRef.current?.remove();
      destRef.current?.remove();
    },
    [map],
  );

  // ---- camera follow: course-up (or north-up), speed-scaled zoom ----
  // A user gesture pauses the follow; the recenter button resumes it.
  useEffect(() => {
    if (!map || !active) return;
    const pause = (e: { originalEvent?: unknown }) => {
      if (e.originalEvent) setFollowPaused(true);
    };
    map.on('dragstart', pause);
    map.on('rotatestart', pause);
    map.on('zoomstart', pause);
    return () => {
      map.off('dragstart', pause);
      map.off('rotatestart', pause);
      map.off('zoomstart', pause);
    };
  }, [map, active]);

  // Follow state resets with each trip.
  useEffect(() => {
    if (!active) setFollowPaused(false);
  }, [active]);

  // Last known course — held when a fix has no heading (stationary), so the
  // course-up camera doesn't snap north between fixes.
  const headingRef = useRef(0);
  useEffect(() => {
    if (nav.headingDeg !== null) headingRef.current = nav.headingDeg;
  }, [nav.headingDeg]);
  useEffect(() => {
    if (!map || !active || followPaused) return;
    const snapped = nav.state?.snapped;
    if (!snapped) return;
    map.easeTo({
      center: snapped,
      zoom: zoomForSpeed(nav.speedMps, snapped.lat),
      bearing: followMode === 'course' ? headingRef.current : 0,
      duration: 800,
      // Linear easing keeps back-to-back fixes from stuttering.
      easing: (t) => t,
    });
  }, [map, active, followPaused, followMode, nav.state?.snapped, nav.speedMps]);

  // Restore a north-up, unpitched camera when the trip ends.
  const wasActive = useRef(false);
  useEffect(() => {
    if (wasActive.current && !active && map) map.easeTo({ bearing: 0, pitch: 0 });
    wasActive.current = active;
  }, [map, active]);

  return {
    followPaused,
    resumeFollow: () => setFollowPaused(false),
    followMode,
    toggleFollowMode: () => setFollowMode((m) => (m === 'course' ? 'north' : 'course')),
  };
}
