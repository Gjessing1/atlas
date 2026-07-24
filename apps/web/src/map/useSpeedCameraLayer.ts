import { overlayFeaturesUrl } from '@atlas/core';
import maplibregl from 'maplibre-gl';
import { useEffect, useRef } from 'react';
import type { ActiveOverlay } from './useOverlayLayers.js';

const LAYER_ID = 'speed-cameras';
const SOURCE_ID = 'atlas-cameras';
const SECTION_CASING = 'atlas-cameras-section-casing';
const SECTION_LINE = 'atlas-cameras-section';
const SECTION_LABEL = 'atlas-cameras-section-label';
const POINT_DOT = 'atlas-cameras-point';
const POINT_LABEL = 'atlas-cameras-point-label';
const ALL_LAYERS = [SECTION_CASING, SECTION_LINE, SECTION_LABEL, POINT_DOT, POINT_LABEL];

/** Enforcement amber — distinct from the route purple and the transit colours. */
const CAMERA_COLOR = '#d97706';
const LABEL_COLOR = '#8a4b04';

const EMPTY_FC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

/**
 * The ATK speed-camera overlay (catalog id `speed-cameras`, the drive
 * profile's signature layer): point cameras as amber dots, average-speed
 * sections as amber lines, names at higher zooms, and a click popup naming
 * what was hit. The data is one country-sized GeoJSON fetch
 * (/api/overlay/speed-cameras/features) — a few hundred features — cached
 * across style swaps like the overlay labels are.
 */
export function useSpeedCameraLayer(
  map: maplibregl.Map | null,
  overlays: ActiveOverlay[],
  suppressClicks?: { readonly current: boolean },
): void {
  // Survives effect re-runs and style reloads, so a style swap re-seeds the
  // source from the last payload instead of flashing empty (same reasoning as
  // useOverlayLabels' dataRef).
  const dataRef = useRef<GeoJSON.FeatureCollection | null>(null);
  const fetchingRef = useRef(false);

  const active = overlays.find((o) => o.meta.id === LAYER_ID && o.meta.vector);
  const rev = active?.meta.rev ?? 0;
  const opacity = active?.opacity ?? 1;
  const metaRef = useRef(active?.meta);
  metaRef.current = active?.meta;

  useEffect(() => {
    if (!map) return;
    let cancelled = false;

    const removeAll = () => {
      if (!map.getStyle()) return;
      for (const id of ALL_LAYERS) if (map.getLayer(id)) map.removeLayer(id);
      if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
    };

    if (!active) {
      removeAll();
      return;
    }

    const ensure = () => {
      // Not gated on isStyleLoaded() — see useTransitLayers: what matters is
      // that the style exists to mutate; the retry events cover the rest.
      if (cancelled || !map.getStyle()) return;
      if (!map.getSource(SOURCE_ID)) {
        map.addSource(SOURCE_ID, { type: 'geojson', data: dataRef.current ?? EMPTY_FC });
      }
      const section: maplibregl.ExpressionSpecification = ['==', ['get', 'kind'], 'section'];
      const point: maplibregl.ExpressionSpecification = ['==', ['get', 'kind'], 'point'];
      if (!map.getLayer(SECTION_CASING)) {
        const layout = { 'line-cap': 'round', 'line-join': 'round' } as const;
        map.addLayer({
          id: SECTION_CASING,
          type: 'line',
          source: SOURCE_ID,
          filter: section,
          layout,
          paint: { 'line-color': '#ffffff', 'line-width': 7, 'line-opacity': 0.85 * opacity },
        });
        map.addLayer({
          id: SECTION_LINE,
          type: 'line',
          source: SOURCE_ID,
          filter: section,
          layout,
          paint: { 'line-color': CAMERA_COLOR, 'line-width': 4, 'line-opacity': opacity },
        });
        map.addLayer({
          id: SECTION_LABEL,
          type: 'symbol',
          source: SOURCE_ID,
          filter: section,
          minzoom: 9,
          layout: {
            'symbol-placement': 'line',
            'text-field': ['coalesce', ['get', 'name'], 'Average speed control'],
            'text-font': ['Noto Sans Bold'],
            'text-size': 12,
            'text-offset': [0, 1],
          },
          paint: {
            'text-color': LABEL_COLOR,
            'text-halo-color': '#ffffff',
            'text-halo-width': 1.4,
            'text-opacity': opacity,
          },
        });
        map.addLayer({
          id: POINT_DOT,
          type: 'circle',
          source: SOURCE_ID,
          filter: point,
          paint: {
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, 3.5, 10, 6, 14, 8],
            'circle-color': CAMERA_COLOR,
            'circle-stroke-width': 2,
            'circle-stroke-color': '#ffffff',
            'circle-opacity': opacity,
            'circle-stroke-opacity': opacity,
          },
        });
        map.addLayer({
          id: POINT_LABEL,
          type: 'symbol',
          source: SOURCE_ID,
          filter: point,
          minzoom: 11,
          layout: {
            'text-field': ['get', 'name'],
            'text-font': ['Noto Sans Regular'],
            'text-size': 11.5,
            'text-offset': [0, 1.1],
            'text-anchor': 'top',
            'text-optional': true,
          },
          paint: {
            'text-color': LABEL_COLOR,
            'text-halo-color': '#ffffff',
            'text-halo-width': 1.4,
            'text-opacity': opacity,
          },
        });
      } else {
        map.setPaintProperty(SECTION_CASING, 'line-opacity', 0.85 * opacity);
        map.setPaintProperty(SECTION_LINE, 'line-opacity', opacity);
        map.setPaintProperty(SECTION_LABEL, 'text-opacity', opacity);
        map.setPaintProperty(POINT_DOT, 'circle-opacity', opacity);
        map.setPaintProperty(POINT_DOT, 'circle-stroke-opacity', opacity);
        map.setPaintProperty(POINT_LABEL, 'text-opacity', opacity);
      }
    };

    const refresh = () => {
      const meta = metaRef.current;
      if (dataRef.current || fetchingRef.current || !meta) return;
      fetchingRef.current = true;
      void (async () => {
        try {
          const res = await fetch(overlayFeaturesUrl('', meta));
          if (!res.ok) return;
          const body = (await res.json()) as GeoJSON.FeatureCollection;
          // Deliberately not dropped when the effect re-ran meanwhile — the
          // payload is rev-static, and the next ensure() seeds from dataRef.
          dataRef.current = body;
          const source = map.getSource(SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
          if (source) source.setData(body);
        } catch {
          // Transient fetch failure: the next sync pass retries.
        } finally {
          fetchingRef.current = false;
        }
      })();
    };

    const sync = () => {
      ensure();
      refresh();
    };
    sync();
    map.on('style.load', sync);
    map.on('styledata', sync);
    map.on('idle', sync);
    // No removal here: an opacity or rev change re-runs the effect and must
    // not flash the layer off. Turning the overlay off removes it via the
    // `!active` branch above (useTransitLayers' pattern), and the map itself
    // unmounts with MapView.
    return () => {
      cancelled = true;
      map.off('style.load', sync);
      map.off('styledata', sync);
      map.off('idle', sync);
    };
    // `overlays` stays out of the deps on purpose (fresh array every render);
    // presence, rev and opacity are what actually matter.
  }, [map, Boolean(active), rev, opacity]);

  useEffect(() => {
    if (!map) return;
    const onClick = (e: maplibregl.MapMouseEvent) => {
      if (suppressClicks?.current) return;
      if (!map.getLayer(POINT_DOT)) return;
      const hits = map.queryRenderedFeatures(e.point, {
        layers: [POINT_DOT, SECTION_LINE, SECTION_CASING],
      });
      const hit = hits[0];
      if (!hit) return;
      const isPoint = hit.properties?.['kind'] === 'point';
      const name = typeof hit.properties?.['name'] === 'string' ? hit.properties['name'] : null;
      const el = document.createElement('div');
      el.className = 'identify-popup';
      const heading = document.createElement('strong');
      heading.textContent = isPoint ? 'Speed camera' : 'Average speed control';
      el.appendChild(heading);
      if (name) {
        const row = document.createElement('div');
        row.className = 'identify-row';
        row.textContent = name;
        el.appendChild(row);
      }
      new maplibregl.Popup({ offset: 8, maxWidth: '260px' })
        .setLngLat(e.lngLat)
        .setDOMContent(el)
        .addTo(map);
    };
    map.on('click', onClick);
    return () => {
      map.off('click', onClick);
    };
  }, [map, suppressClicks]);
}
