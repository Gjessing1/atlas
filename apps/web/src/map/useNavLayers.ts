import type { NavController } from '@atlas/app-hooks';
import { lineStringFeature } from '@atlas/core';
import {
  followZoom,
  maneuverArrowsGeoJSON,
  navCameraStyle,
  remainingRouteBounds,
} from '@atlas/navigation';
import maplibregl from 'maplibre-gl';
import { useEffect, useMemo, useRef, useState } from 'react';

const SOURCE_ID = 'atlas-nav';
const CASING = 'atlas-nav-casing';
const LINE = 'atlas-nav-line';
const NAV_LAYERS = [CASING, LINE];

const ARROW_SOURCE = 'atlas-nav-arrows';
const ARROW_CASING = 'atlas-nav-arrows-casing';
const ARROW_LINE = 'atlas-nav-arrows-line';
const ARROW_HEAD = 'atlas-nav-arrows-head';
const ARROW_LAYERS = [ARROW_CASING, ARROW_LINE, ARROW_HEAD];

const PREVIEW_SOURCE = 'atlas-nav-preview';
const PREVIEW_ALT = 'atlas-nav-preview-alt';
const PREVIEW_SEL = 'atlas-nav-preview-sel';
const PREVIEW_LAYERS = [PREVIEW_ALT, PREVIEW_SEL];

/** The overview camera returns to the follow by itself after this long. */
const OVERVIEW_RESUME_MS = 20_000;

export interface NavFollowControls {
  /** True after a manual pan/rotate/zoom; the camera stops following. */
  followPaused: boolean;
  resumeFollow: () => void;
  /** Whole-remaining-route overview instead of the follow camera. */
  overview: boolean;
  toggleOverview: () => void;
}

/**
 * Renders active turn-by-turn navigation on the map — the route line (with the
 * driven stretch dimmed), on-map turn arrows, the snapped location puck, the
 * destination flag — and drives the follow camera: course-up from the route
 * tangent, bottom-anchored via padding, pitched, with speed/turn-aware zoom
 * (Android useNavCamera parity). Panning/rotating by hand pauses the follow;
 * `resumeFollow` (the banner's recenter button) re-engages it. The overview
 * toggle swaps the follow for a fit of the whole remaining route, returning
 * on tap or by itself after a timeout.
 *
 * The orientation (`followMode`) is passed in rather than owned here: it is a
 * persisted user preference (`useNavPrefs`), and this hook only frames the
 * camera the way that preference asks for.
 */
export function useNavLayers(
  map: maplibregl.Map | null,
  nav: NavController,
  followMode: 'course' | 'north',
): NavFollowControls {
  const [followPaused, setFollowPaused] = useState(false);
  const [overview, setOverview] = useState(false);
  const active = nav.phase === 'navigating' || nav.phase === 'rerouting';

  // ---- route line (style-swap resilient, like useRouteLayers) ----
  // Quantized so the per-fix updates only touch the map when visible.
  const routeProgress = Math.min(
    0.999,
    Math.max(0.001, Math.round((nav.state?.routeProgress ?? 0) * 200) / 200),
  );
  const traveledM = Math.round((nav.state?.traveledM ?? 0) / 10) * 10;
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
        // lineMetrics feeds the line-gradient that greys the driven stretch.
        map.addSource(SOURCE_ID, { type: 'geojson', data, lineMetrics: true });
      }
      if (!map.getLayer(CASING)) {
        const line = { 'line-cap': 'round', 'line-join': 'round' } as const;
        // Google-style solid blue with a darker casing (Android parity); the
        // gradient step moves with routeProgress via setPaintProperty below.
        map.addLayer({
          id: CASING,
          type: 'line',
          source: SOURCE_ID,
          layout: line,
          paint: {
            'line-width': 10,
            'line-gradient': ['step', ['line-progress'], '#7d8590', 0.001, '#1557b0'],
          },
        });
        map.addLayer({
          id: LINE,
          type: 'line',
          source: SOURCE_ID,
          layout: line,
          paint: {
            'line-width': 6,
            'line-gradient': ['step', ['line-progress'], '#aab2bd', 0.001, '#4285f4'],
          },
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

  // Advance the driven-stretch dimming with progress (cheap paint update).
  useEffect(() => {
    if (!map || !active) return;
    for (const [id, dim, lit] of [
      [CASING, '#7d8590', '#1557b0'],
      [LINE, '#aab2bd', '#4285f4'],
    ] as const) {
      if (map.getLayer(id)) {
        map.setPaintProperty(id, 'line-gradient', [
          'step',
          ['line-progress'],
          dim,
          routeProgress,
          lit,
        ]);
      }
    }
  }, [map, active, routeProgress]);

  // ---- on-map turn arrows (shared geometry, Android parity) ----
  const arrows = useMemo(
    () => (active && nav.activePath ? maneuverArrowsGeoJSON(nav.activePath) : null),
    [active, nav.activePath],
  );
  useEffect(() => {
    if (!map) return;
    let cancelled = false;
    const sync = () => {
      if (cancelled || !map.isStyleLoaded()) return;
      if (!arrows || arrows.features.length === 0) {
        for (const id of ARROW_LAYERS) if (map.getLayer(id)) map.removeLayer(id);
        if (map.getSource(ARROW_SOURCE)) map.removeSource(ARROW_SOURCE);
        return;
      }
      const source = map.getSource(ARROW_SOURCE) as maplibregl.GeoJSONSource | undefined;
      if (source) source.setData(arrows);
      else map.addSource(ARROW_SOURCE, { type: 'geojson', data: arrows });
      if (!map.getLayer(ARROW_CASING)) {
        const line = { 'line-cap': 'round', 'line-join': 'round' } as const;
        const body: maplibregl.FilterSpecification = ['==', ['get', 'kind'], 'body'];
        map.addLayer({
          id: ARROW_CASING,
          type: 'line',
          source: ARROW_SOURCE,
          filter: body,
          layout: line,
          paint: { 'line-color': '#16324f', 'line-width': 9, 'line-opacity': 0.9 },
        });
        map.addLayer({
          id: ARROW_LINE,
          type: 'line',
          source: ARROW_SOURCE,
          filter: body,
          layout: line,
          paint: { 'line-color': '#ffffff', 'line-width': 5 },
        });
        // Arrowhead: the '›' glyph rotated from east-pointing to the exit
        // bearing (the same trick as the Android scene and plan chevrons).
        map.addLayer({
          id: ARROW_HEAD,
          type: 'symbol',
          source: ARROW_SOURCE,
          filter: ['==', ['get', 'kind'], 'tip'],
          layout: {
            'text-field': '›',
            'text-font': ['Noto Sans Bold'],
            'text-size': 26,
            'text-rotate': ['-', ['get', 'bearingDeg'], 90],
            'text-rotation-alignment': 'map',
            'text-allow-overlap': true,
            'text-ignore-placement': true,
          },
          paint: { 'text-color': '#ffffff', 'text-halo-color': '#16324f', 'text-halo-width': 2 },
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
  }, [map, arrows]);

  // Hide arrows for turns already taken (filter update, not geometry rebuild).
  useEffect(() => {
    if (!map || !arrows) return;
    const passed = ['>', ['get', 'alongM'], traveledM - 10];
    for (const [id, kind] of [
      [ARROW_CASING, 'body'],
      [ARROW_LINE, 'body'],
      [ARROW_HEAD, 'tip'],
    ] as const) {
      if (map.getLayer(id)) {
        map.setFilter(id, ['all', ['==', ['get', 'kind'], kind], passed] as never);
      }
    }
  }, [map, arrows, traveledM]);

  // ---- route-choice preview (Android MapScene parity) ----
  // Muted alternatives under the selected line, with the selected drawn last so
  // it wins overlaps; clicking a grey line switches the choice.
  const previewing = nav.phase === 'preview';
  const previewPaths = nav.previewPaths;
  const previewIndex = nav.previewIndex;
  const previewData = useMemo(() => {
    if (!previewing || !previewPaths) return null;
    return {
      type: 'FeatureCollection' as const,
      features: previewPaths
        .map((path, index) => ({
          type: 'Feature' as const,
          properties: { index, selected: index === previewIndex },
          geometry: {
            type: 'LineString' as const,
            coordinates: path.points.map((p) => [p.lng, p.lat]),
          },
        }))
        .sort((a, b) => Number(a.properties.selected) - Number(b.properties.selected)),
    };
  }, [previewing, previewPaths, previewIndex]);

  const { selectPreview } = nav;
  useEffect(() => {
    if (!map) return;
    let cancelled = false;
    const sync = () => {
      if (cancelled || !map.isStyleLoaded()) return;
      if (!previewData || previewData.features.length === 0) {
        for (const id of PREVIEW_LAYERS) if (map.getLayer(id)) map.removeLayer(id);
        if (map.getSource(PREVIEW_SOURCE)) map.removeSource(PREVIEW_SOURCE);
        return;
      }
      const source = map.getSource(PREVIEW_SOURCE) as maplibregl.GeoJSONSource | undefined;
      if (source) source.setData(previewData);
      else map.addSource(PREVIEW_SOURCE, { type: 'geojson', data: previewData });
      if (!map.getLayer(PREVIEW_ALT)) {
        const line = { 'line-cap': 'round', 'line-join': 'round' } as const;
        map.addLayer({
          id: PREVIEW_ALT,
          type: 'line',
          source: PREVIEW_SOURCE,
          filter: ['!', ['to-boolean', ['get', 'selected']]],
          layout: line,
          paint: { 'line-color': '#8f8f9d', 'line-width': 5, 'line-opacity': 0.8 },
        });
        map.addLayer({
          id: PREVIEW_SEL,
          type: 'line',
          source: PREVIEW_SOURCE,
          filter: ['to-boolean', ['get', 'selected']],
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
      if (map.getStyle()) {
        for (const id of PREVIEW_LAYERS) if (map.getLayer(id)) map.removeLayer(id);
        if (map.getSource(PREVIEW_SOURCE)) map.removeSource(PREVIEW_SOURCE);
      }
    };
  }, [map, previewData]);

  // Tap an alternative to make it the choice (the selected line is already it).
  useEffect(() => {
    if (!map || !previewing) return;
    const pick = (e: maplibregl.MapLayerMouseEvent) => {
      const index = e.features?.[0]?.properties?.['index'];
      if (typeof index === 'number') selectPreview(index);
    };
    const enter = () => {
      map.getCanvas().style.cursor = 'pointer';
    };
    const leave = () => {
      map.getCanvas().style.cursor = '';
    };
    map.on('click', PREVIEW_ALT, pick);
    map.on('mouseenter', PREVIEW_ALT, enter);
    map.on('mouseleave', PREVIEW_ALT, leave);
    return () => {
      map.off('click', PREVIEW_ALT, pick);
      map.off('mouseenter', PREVIEW_ALT, enter);
      map.off('mouseleave', PREVIEW_ALT, leave);
      leave();
    };
  }, [map, previewing, selectPreview]);

  // Entering the preview (or switching choice): fit the whole selected route,
  // clear of the topbar and the choice card at the bottom.
  const selectedPreviewPath = previewing ? (previewPaths?.[previewIndex] ?? null) : null;
  useEffect(() => {
    if (!map || !selectedPreviewPath) return;
    const bounds = new maplibregl.LngLatBounds();
    for (const p of selectedPreviewPath.points) bounds.extend([p.lng, p.lat]);
    if (bounds.isEmpty()) return;
    map.fitBounds(bounds, {
      padding: { top: 80, right: 60, bottom: 260, left: 60 },
      bearing: 0,
      pitch: 0,
      duration: 700,
    });
  }, [map, selectedPreviewPath]);

  // ---- location puck (snapped position) + destination flag ----
  const puckRef = useRef<maplibregl.Marker | null>(null);
  const destRef = useRef<maplibregl.Marker | null>(null);
  const viaMarkersRef = useRef<maplibregl.Marker[]>([]);
  useEffect(() => {
    if (!map) return;
    const snapped = active ? nav.state?.snapped : undefined;
    if (snapped) {
      if (!puckRef.current) {
        const el = document.createElement('div');
        el.className = 'nav-puck-wrap';
        const dot = document.createElement('div');
        dot.className = 'nav-puck';
        el.append(dot);
        puckRef.current = new maplibregl.Marker({ element: el });
      }
      puckRef.current.setLngLat(snapped).addTo(map);
      const el = puckRef.current.getElement();
      // Grey when the GPS signal is lost, so a frozen puck reads as
      // "no signal", not "we're still here".
      el.classList.toggle('nav-puck-lost', nav.state?.fix === 'lost');
    } else {
      puckRef.current?.remove();
      puckRef.current = null;
    }
    // The flag shows through the preview too — "where am I being sent" is the
    // first thing to check before committing to a route.
    const dest = active || previewing ? nav.destination : null;
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
  }, [map, active, previewing, nav.state?.snapped, nav.state?.fix, nav.destination]);
  // Via stops still ahead on a multi-stop trip, as small dots along the line:
  // each disappears once driven past. Deliberately keyed on the passed-count,
  // not the fix, so the markers are rebuilt when a stop is reached rather
  // than at every position update. Few and rarely changing, so rebuilding
  // wholesale is cheaper than diffing.
  const viasPassed = nav.state?.viasPassed ?? 0;
  useEffect(() => {
    if (!map) return;
    const vias = active || previewing ? nav.viaPoints.slice(viasPassed) : [];
    for (const marker of viaMarkersRef.current) marker.remove();
    viaMarkersRef.current = vias.map((via) => {
      const el = document.createElement('div');
      el.className = 'nav-via-marker';
      return new maplibregl.Marker({ element: el }).setLngLat(via).addTo(map);
    });
  }, [map, active, previewing, nav.viaPoints, viasPassed]);
  useEffect(
    () => () => {
      puckRef.current?.remove();
      destRef.current?.remove();
      for (const marker of viaMarkersRef.current) marker.remove();
      viaMarkersRef.current = [];
    },
    [map],
  );

  // ---- camera follow ----
  // A user gesture pauses the follow (and closes the overview); the recenter
  // button resumes it.
  useEffect(() => {
    if (!map || !active) return;
    const pause = (e: { originalEvent?: unknown }) => {
      if (e.originalEvent) {
        setFollowPaused(true);
        setOverview(false);
      }
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
    if (!active) {
      setFollowPaused(false);
      setOverview(false);
    }
  }, [active]);

  // Course-up bearing from the route tangent (stable), not the raw GPS course
  // (wobbles) — held over states where the tangent is unavailable.
  const courseRef = useRef(0);
  useEffect(() => {
    if (nav.state?.courseDeg != null) courseRef.current = nav.state.courseDeg;
  }, [nav.state?.courseDeg]);

  useEffect(() => {
    if (!map || !active || followPaused || overview) return;
    const state = nav.state;
    const snapped = state?.snapped;
    if (!state || !snapped) return;
    // Course-up from the first fix, before the drive has demonstrably begun
    // (Android parity): the route tangent gives a stable bearing standing
    // still, so the driving frame is up the moment guidance starts.
    const courseUp = followMode === 'course';
    // Per-mode framing: driving gets the windscreen treatment (pitched,
    // speed-scaled zoom); walking modes stay flat and closer in, because a
    // pedestrian reads the streets around them, not the road ahead.
    const camStyle = navCameraStyle(nav.profile);
    // Standard driving-nav framing (Android parity): top padding of half the
    // viewport puts the car ~75% of the way down in course-up, so the top
    // three quarters show the road ahead; in north-up (and on foot, where a
    // pitched look-ahead frame is meaningless at 1.4 m/s) "ahead" isn't the
    // point, so keep the traveller centred.
    const bottomAnchored = courseUp && camStyle.pitchDeg > 0;
    const height = map.getContainer().clientHeight || 600;
    const anchorTop = bottomAnchored ? Math.round(height * 0.5) : 0;
    const forwardPx = Math.round(height * (bottomAnchored ? 0.6 : 0.4));
    map.easeTo({
      center: snapped,
      zoom: followZoom(
        nav.speedMps,
        snapped.lat,
        state.upcoming?.distanceToM ?? null,
        forwardPx,
        camStyle,
      ),
      bearing: courseUp ? courseRef.current : 0,
      pitch: courseUp ? camStyle.pitchDeg : 0,
      padding: { top: anchorTop, bottom: 0, left: 0, right: 0 },
      duration: 800,
      // Linear easing keeps back-to-back fixes from stuttering.
      easing: (t) => t,
    });
  }, [map, active, followPaused, overview, followMode, nav.state, nav.speedMps, nav.profile]);

  // Overview: fit the whole remaining route flat and north-up; back to the
  // follow on tap (toggle/recenter), a map gesture, or by itself on timeout.
  // The nav snapshot is read through a ref so the fit happens once per toggle
  // — refitting on every fix would fight the driver.
  const navRef = useRef(nav);
  navRef.current = nav;
  useEffect(() => {
    if (!map || !overview) return;
    const points = navRef.current.activePath?.points;
    const bounds = points
      ? remainingRouteBounds(points, navRef.current.state?.traveledM ?? 0)
      : null;
    if (bounds) {
      map.fitBounds(
        [
          [bounds.sw.lng, bounds.sw.lat],
          [bounds.ne.lng, bounds.ne.lat],
        ],
        { padding: 80, bearing: 0, pitch: 0, duration: 600 },
      );
    }
    const timer = setTimeout(() => setOverview(false), OVERVIEW_RESUME_MS);
    return () => clearTimeout(timer);
  }, [map, overview]);

  // Restore a north-up, unpitched, unpadded camera when the trip ends.
  const wasActive = useRef(false);
  useEffect(() => {
    if (wasActive.current && !active && map) {
      map.easeTo({ bearing: 0, pitch: 0, padding: { top: 0, bottom: 0, left: 0, right: 0 } });
    }
    wasActive.current = active;
  }, [map, active]);

  return {
    followPaused,
    resumeFollow: () => {
      setFollowPaused(false);
      setOverview(false);
    },
    overview,
    toggleOverview: () => {
      setOverview((o) => !o);
      setFollowPaused(false);
    },
  };
}
