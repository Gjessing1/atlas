import { overlayFeaturesUrl } from '@atlas/core';
import maplibregl from 'maplibre-gl';
import { useEffect, useRef } from 'react';
import type { ActiveOverlay } from './useOverlayLayers.js';

const LAYER_ID = 'statskog-jaktfelt';
const SOURCE_ID = 'atlas-jaktfelt';
const FILL = 'atlas-jaktfelt-fill';
const OUTLINE = 'atlas-jaktfelt-outline';
const LABEL = 'atlas-jaktfelt-label';
const ALL_LAYERS = [FILL, OUTLINE, LABEL];

/** Rust orange — a hunting-land boundary, distinct from route purple and camera amber. */
const FIELD_COLOR = '#c2410c';
const LABEL_COLOR = '#7c2d12';

const EMPTY_FC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

/**
 * The Statskog storviltjaktfelt overlay (catalog id `statskog-jaktfelt`, the
 * Fish & Hunt signature layer): state-forest big-game hunting fields as
 * outlined polygons with a faint fill, the field name at closer zooms, and a
 * click popup naming the field, the species it is opened for and Statskog's
 * remarks. One country-sized GeoJSON fetch (/api/overlay/statskog-jaktfelt/
 * features) — 922 simplified polygons — cached across style swaps.
 *
 * Structurally the speed-camera hook (useSpeedCameraLayer): the vector-overlay
 * pattern, applied to polygons instead of camera geometry.
 */
export function useHuntingFieldsLayer(
  map: maplibregl.Map | null,
  overlays: ActiveOverlay[],
  suppressClicks?: { readonly current: boolean },
): void {
  // Survives effect re-runs and style reloads, so a style swap re-seeds the
  // source from the last payload instead of flashing empty.
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
      // Not gated on isStyleLoaded() — what matters is that the style exists to
      // mutate; the retry events cover the rest (see useSpeedCameraLayer).
      if (cancelled || !map.getStyle()) return;
      if (!map.getSource(SOURCE_ID)) {
        map.addSource(SOURCE_ID, { type: 'geojson', data: dataRef.current ?? EMPTY_FC });
      }
      if (!map.getLayer(FILL)) {
        map.addLayer({
          id: FILL,
          type: 'fill',
          source: SOURCE_ID,
          paint: { 'fill-color': FIELD_COLOR, 'fill-opacity': 0.12 * opacity },
        });
        map.addLayer({
          id: OUTLINE,
          type: 'line',
          source: SOURCE_ID,
          layout: { 'line-join': 'round' },
          paint: {
            'line-color': FIELD_COLOR,
            'line-width': ['interpolate', ['linear'], ['zoom'], 7, 1, 12, 2],
            'line-opacity': 0.9 * opacity,
          },
        });
        map.addLayer({
          id: LABEL,
          type: 'symbol',
          source: SOURCE_ID,
          minzoom: 9,
          layout: {
            'text-field': ['get', 'Feltnavn'],
            'text-font': ['Noto Sans Bold'],
            'text-size': 12,
            'text-max-width': 8,
            'text-optional': true,
            'symbol-placement': 'point',
          },
          paint: {
            'text-color': LABEL_COLOR,
            'text-halo-color': '#ffffff',
            'text-halo-width': 1.4,
            'text-opacity': opacity,
          },
        });
      } else {
        map.setPaintProperty(FILL, 'fill-opacity', 0.12 * opacity);
        map.setPaintProperty(OUTLINE, 'line-opacity', 0.9 * opacity);
        map.setPaintProperty(LABEL, 'text-opacity', opacity);
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
      if (!map.getLayer(FILL)) return;
      const hit = map.queryRenderedFeatures(e.point, { layers: [FILL] })[0];
      if (!hit) return;
      const props = hit.properties ?? {};
      const str = (v: unknown): string | null =>
        typeof v === 'string' && v.trim() ? v.trim() : null;
      const name = str(props['Feltnavn']);
      const species = str(props['Art']);
      const remarks = str(props['Merknad']);

      const el = document.createElement('div');
      el.className = 'identify-popup';
      const heading = document.createElement('strong');
      heading.textContent = name ?? 'Hunting field';
      el.appendChild(heading);
      const addRow = (label: string, value: string) => {
        const row = document.createElement('div');
        row.className = 'identify-row';
        row.textContent = `${label}: ${value}`;
        el.appendChild(row);
      };
      if (species) addRow('Species', species);
      if (remarks) addRow('Remarks', remarks);

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
