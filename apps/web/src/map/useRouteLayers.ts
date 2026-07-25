import { waypointLabel, type LatLng } from '@atlas/core';
import { viaInsertIndex, type RoutePath } from '@atlas/routing';
import type { Feature, FeatureCollection } from 'geojson';
import maplibregl from 'maplibre-gl';
import { useCallback, useEffect, useRef } from 'react';
import { reverseGeocode } from '../routing/reverseGeocode.js';
import type { RoutePlanner } from '../routing/useRoute.js';

const SOURCE_ID = 'atlas-route';
const ALT_CASING = 'atlas-route-alt-casing';
const ALT_LINE = 'atlas-route-alt-line';
const SEL_CASING = 'atlas-route-sel-casing';
const SEL_LINE = 'atlas-route-sel-line';
const SEL_ARROWS = 'atlas-route-sel-arrows';
const ROUTE_LAYERS = [ALT_CASING, ALT_LINE, SEL_CASING, SEL_LINE, SEL_ARROWS];
const ROUTE_COLOR = '#7048c9';

function routeCollection(paths: RoutePath[], selected: number): FeatureCollection {
  const features: Feature[] = paths.map((path, index) => ({
    type: 'Feature',
    properties: { index, selected: index === selected },
    geometry: {
      type: 'LineString',
      coordinates: path.points.map((p) => [p.lng, p.lat]),
    },
  }));
  // Draw the selected path last within each layer so it wins overlaps.
  features.sort((a, b) => Number(a.properties!['selected']) - Number(b.properties!['selected']));
  return { type: 'FeatureCollection', features };
}

/**
 * Renders the planned route on the map: alternative paths (muted, clickable),
 * the selected path on top, and draggable numbered waypoint markers. Also
 * owns route-mode click handling — click to append a stop, click on the
 * selected line to insert a via point into that section.
 */
export function useRouteLayers(
  map: maplibregl.Map | null,
  route: RoutePlanner,
  /**
   * Hide the routed line while another travel mode owns the map — public
   * transport draws its own journey, and two lines answering "how do I get
   * there" at once is one too many. The waypoint markers stay: they are the
   * plan's endpoints whichever mode is answering.
   */
  hideLine = false,
  /** While `.current` is true (e.g. the measure tool is open), route-mode clicks yield. */
  suppressClicks?: { readonly current: boolean },
): void {
  // Handlers are registered once per map; latest state flows through a ref.
  const routeRef = useRef(route);
  routeRef.current = route;

  // Label a stop the user placed by hand (click or drag) with whatever is
  // there. In-flight lookups are aborted when the hook unmounts.
  const pendingLabels = useRef(new Set<AbortController>());
  const labelStop = useCallback((id: number, at: LatLng) => {
    const controller = new AbortController();
    pendingLabels.current.add(controller);
    void reverseGeocode(at, controller.signal)
      .then((name) => {
        if (name) routeRef.current.nameWaypoint(id, name, at);
      })
      .finally(() => pendingLabels.current.delete(controller));
  }, []);
  useEffect(() => {
    const pending = pendingLabels.current;
    return () => {
      for (const controller of pending) controller.abort();
      pending.clear();
    };
  }, []);

  // ---- route lines (geojson source + 4 layers, style-swap resilient) ----
  useEffect(() => {
    if (!map) return;
    const paths = route.active && !hideLine ? (route.paths ?? []) : [];
    const data = routeCollection(paths, route.selectedPath);
    let cancelled = false;

    const sync = () => {
      if (cancelled || !map.isStyleLoaded()) return; // re-runs on style.load/idle
      if (paths.length === 0) {
        for (const id of ROUTE_LAYERS) if (map.getLayer(id)) map.removeLayer(id);
        if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
        return;
      }
      const source = map.getSource(SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
      if (source) {
        source.setData(data);
      } else {
        map.addSource(SOURCE_ID, { type: 'geojson', data });
      }
      if (!map.getLayer(ALT_CASING)) {
        const line = { 'line-cap': 'round', 'line-join': 'round' } as const;
        const selected: maplibregl.ExpressionSpecification = ['to-boolean', ['get', 'selected']];
        const unselected: maplibregl.ExpressionSpecification = ['!', selected];
        map.addLayer({
          id: ALT_CASING,
          type: 'line',
          source: SOURCE_ID,
          filter: unselected,
          layout: line,
          paint: { 'line-color': '#ffffff', 'line-width': 7, 'line-opacity': 0.7 },
        });
        map.addLayer({
          id: ALT_LINE,
          type: 'line',
          source: SOURCE_ID,
          filter: unselected,
          layout: line,
          paint: { 'line-color': '#8f8f9d', 'line-width': 4, 'line-opacity': 0.8 },
        });
        map.addLayer({
          id: SEL_CASING,
          type: 'line',
          source: SOURCE_ID,
          filter: selected,
          layout: line,
          paint: { 'line-color': '#ffffff', 'line-width': 8, 'line-opacity': 0.85 },
        });
        map.addLayer({
          id: SEL_LINE,
          type: 'line',
          source: SOURCE_ID,
          filter: selected,
          layout: line,
          paint: { 'line-color': ROUTE_COLOR, 'line-width': 4.5 },
        });
        // Travel-direction chevrons along the selected path — the only cue to
        // which way a round trip runs (its Reverse button flips these).
        // keep-upright must stay off or right-to-left segments would flip the
        // glyph "upright" and point it backwards.
        map.addLayer({
          id: SEL_ARROWS,
          type: 'symbol',
          source: SOURCE_ID,
          filter: selected,
          layout: {
            'symbol-placement': 'line',
            'symbol-spacing': 80,
            'text-field': '›',
            'text-font': ['Noto Sans Bold'],
            'text-size': 20,
            'text-offset': [0, -0.12],
            'text-keep-upright': false,
            'text-allow-overlap': true,
            'text-ignore-placement': true,
          },
          paint: { 'text-color': '#ffffff' },
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
  }, [map, route.active, route.paths, route.selectedPath, hideLine]);

  // ---- route-mode clicks: select an alternative / insert via / add stop ----
  useEffect(() => {
    if (!map) return;
    const onClick = (e: maplibregl.MapMouseEvent) => {
      if (suppressClicks?.current) return;
      const r = routeRef.current;
      if (!r.active) return;
      const present = ROUTE_LAYERS.filter((id) => map.getLayer(id));
      const hit = present.length
        ? map.queryRenderedFeatures(e.point, { layers: present })[0]
        : undefined;
      const at = { lat: e.lngLat.lat, lng: e.lngLat.lng };
      if (hit) {
        const index = hit.properties?.['index'] as number | undefined;
        if (index !== undefined && index !== r.selectedPath) {
          r.selectPath(index); // clicked an alternative: make it the route
          return;
        }
        // Clicked the selected line: insert a via point into that section.
        const path = r.paths?.[r.selectedPath];
        if (path && !r.roundTrip && r.waypoints.length >= 2) {
          const insertAt = viaInsertIndex(
            path.points,
            r.waypoints.map((w) => w.pos),
            at,
          );
          labelStop(r.insertWaypoint(insertAt, at), at);
          return;
        }
      }
      labelStop(r.addWaypoint(at), at);
    };
    const setPointer = () => (map.getCanvas().style.cursor = 'pointer');
    const clearPointer = () => (map.getCanvas().style.cursor = '');
    map.on('click', onClick);
    map.on('mouseenter', ALT_LINE, setPointer);
    map.on('mouseleave', ALT_LINE, clearPointer);
    return () => {
      map.off('click', onClick);
      map.off('mouseenter', ALT_LINE, setPointer);
      map.off('mouseleave', ALT_LINE, clearPointer);
    };
  }, [map, labelStop]);

  // ---- waypoint markers (DOM overlays survive style swaps by themselves) ----
  const markersRef = useRef(new Map<number, maplibregl.Marker>());
  useEffect(() => {
    if (!map) return;
    const markers = markersRef.current;
    const wanted = route.active ? route.waypoints : [];
    const wantedIds = new Set(wanted.map((w) => w.id));

    for (const [id, marker] of markers) {
      if (!wantedIds.has(id)) {
        marker.remove();
        markers.delete(id);
      }
    }
    wanted.forEach((waypoint, index) => {
      // The panel's row and this pin must say the same thing, so both read the
      // one label function rather than each spelling the alphabet out.
      const label = waypointLabel(index, route.roundTrip, wanted.length);
      let marker = markers.get(waypoint.id);
      if (!marker) {
        const el = document.createElement('div');
        el.className = 'route-waypoint-marker';
        marker = new maplibregl.Marker({ element: el, draggable: true });
        marker.setLngLat(waypoint.pos).addTo(map);
        const id = waypoint.id;
        marker.on('dragend', () => {
          const lngLat = marker!.getLngLat();
          const at = { lat: lngLat.lat, lng: lngLat.lng };
          // The move drops the old label (it described the old spot); look up
          // what is at the new one.
          routeRef.current.moveWaypointTo(id, at);
          labelStop(id, at);
        });
        markers.set(id, marker);
      } else {
        marker.setLngLat(waypoint.pos);
      }
      marker.getElement().textContent = label;
    });
  }, [map, route.active, route.waypoints, route.roundTrip, labelStop]);

  // Drop all markers when the map goes away or route mode ends entirely.
  useEffect(() => {
    const markers = markersRef.current;
    return () => {
      for (const marker of markers.values()) marker.remove();
      markers.clear();
    };
  }, [map]);
}

export type { LatLng };
