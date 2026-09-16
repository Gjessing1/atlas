import { LIGHTNING_OBSERVATIONS_ID, type LightningResponse } from '@atlas/conditions';
import { viewportFeaturesUrl, type LngLatBbox } from '@atlas/core';
import type maplibregl from 'maplibre-gl';
import { useEffect, useRef } from 'react';

import type { ActiveOverlay } from './useOverlayLayers.js';

const SOURCE_ID = 'atlas-lightning';
const HALO_ID = 'atlas-lightning-halo';
const DOT_ID = 'atlas-lightning-dot';
const EMPTY: LightningResponse = { type: 'FeatureCollection', features: [] };
const REFRESH_MS = 60_000;

export const LIGHTNING_IDENTIFY_LAYERS = [DOT_ID, HALO_ID];

const viewport = (map: maplibregl.Map): LngLatBbox => {
  const bounds = map.getBounds();
  return [
    Math.max(-180, bounds.getWest()),
    Math.max(-85, bounds.getSouth()),
    Math.min(180, bounds.getEast()),
    Math.min(85, bounds.getNorth()),
  ];
};

/** Frost strikes over the settled viewport, refreshed as their age colours change. */
export function useLightningLayer(map: maplibregl.Map | null, overlays: ActiveOverlay[]): void {
  const active = overlays.find(
    (overlay) => overlay.meta.id === LIGHTNING_OBSERVATIONS_ID && overlay.meta.vector,
  );
  const present = Boolean(active);
  const opacity = active?.opacity ?? 1;
  const minzoom = active?.meta.minzoom ?? 4;
  const dataRef = useRef<LightningResponse>(EMPTY);
  const metaRef = useRef(active?.meta);
  metaRef.current = active?.meta;

  useEffect(() => {
    if (!map) return;
    let stopped = false;
    let lastKey = '';
    const remove = () => {
      try {
        for (const id of [DOT_ID, HALO_ID]) if (map.getLayer(id)) map.removeLayer(id);
        if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
      } catch {
        // Style not available yet.
      }
    };
    if (!present) {
      remove();
      return;
    }
    const ensure = () => {
      if (stopped) return;
      try {
        if (!map.getSource(SOURCE_ID)) {
          map.addSource(SOURCE_ID, { type: 'geojson', data: dataRef.current });
        }
        if (!map.getLayer(HALO_ID)) {
          map.addLayer({
            id: HALO_ID,
            type: 'circle',
            source: SOURCE_ID,
            minzoom,
            paint: {
              'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 5, 10, 10, 16, 15],
              'circle-color': ['get', 'markerColor'],
              'circle-opacity': 0.2 * opacity,
              'circle-blur': 0.6,
            },
          });
          map.addLayer({
            id: DOT_ID,
            type: 'circle',
            source: SOURCE_ID,
            minzoom,
            paint: {
              'circle-radius': [
                'interpolate',
                ['linear'],
                ['abs', ['get', 'peakCurrentKa']],
                0,
                2.5,
                25,
                4,
                100,
                7,
              ],
              'circle-color': ['get', 'markerColor'],
              'circle-stroke-color': '#3b2445',
              'circle-stroke-width': 1,
              'circle-opacity': opacity,
              'circle-stroke-opacity': opacity,
            },
          });
        } else {
          map.setPaintProperty(HALO_ID, 'circle-opacity', 0.2 * opacity);
          map.setPaintProperty(DOT_ID, 'circle-opacity', opacity);
          map.setPaintProperty(DOT_ID, 'circle-stroke-opacity', opacity);
        }
      } catch {
        // A style swap will retry.
      }
    };
    const refresh = async (force = false) => {
      const meta = metaRef.current;
      if (!meta || map.getZoom() < minzoom) return;
      const bbox = viewport(map);
      const key = bbox.map((value) => value.toFixed(3)).join(',');
      if (!force && key === lastKey) return;
      try {
        const response = await fetch(viewportFeaturesUrl('', meta, bbox));
        if (!response.ok || stopped) return;
        const data = (await response.json()) as LightningResponse;
        dataRef.current = data;
        lastKey = key;
        (map.getSource(SOURCE_ID) as maplibregl.GeoJSONSource | undefined)?.setData(data);
      } catch {
        // Keep the last strikes while offline; the timer or next pan retries.
      }
    };
    const sync = () => {
      ensure();
      void refresh();
    };
    sync();
    const timer = setInterval(() => void refresh(true), REFRESH_MS);
    map.on('style.load', sync);
    map.on('moveend', sync);
    return () => {
      stopped = true;
      clearInterval(timer);
      map.off('style.load', sync);
      map.off('moveend', sync);
    };
  }, [map, present, opacity, minzoom]);
}
