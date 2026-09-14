import { overlayFeaturesUrl } from '@atlas/core';
import type maplibregl from 'maplibre-gl';
import { useEffect, useRef } from 'react';

import type { ActiveOverlay } from './useOverlayLayers.js';

const LAYER_ID = 'road-weather';
const SOURCE_ID = 'atlas-road-weather';
const DOT_ID = 'atlas-road-weather-dot';
const SYMBOL_ID = 'atlas-road-weather-symbol';
const REFRESH_MS = 3 * 60_000;
export const ROAD_WEATHER_IDENTIFY_LAYERS = [SYMBOL_ID, DOT_ID];
const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

/** Live NPRA road-temperature stations, coloured by shared ice-risk rules. */
export function useRoadWeatherLayer(map: maplibregl.Map | null, overlays: ActiveOverlay[]): void {
  const active = overlays.find((overlay) => overlay.meta.id === LAYER_ID && overlay.meta.vector);
  const opacity = active?.opacity ?? 1;
  const dataRef = useRef<GeoJSON.FeatureCollection>(EMPTY);
  const metaRef = useRef(active?.meta);
  metaRef.current = active?.meta;

  useEffect(() => {
    if (!map) return;
    let stopped = false;
    const remove = () => {
      if (!map.getStyle()) return;
      if (map.getLayer(SYMBOL_ID)) map.removeLayer(SYMBOL_ID);
      if (map.getLayer(DOT_ID)) map.removeLayer(DOT_ID);
      if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
    };
    if (!active) {
      remove();
      return;
    }
    const ensure = () => {
      if (stopped || !map.getStyle()) return;
      if (!map.getSource(SOURCE_ID)) {
        map.addSource(SOURCE_ID, {
          type: 'geojson',
          data: dataRef.current,
          attribution: active.meta.attribution,
        });
      }
      if (!map.getLayer(DOT_ID)) {
        map.addLayer({
          id: DOT_ID,
          type: 'circle',
          source: SOURCE_ID,
          minzoom: active.meta.minzoom ?? 0,
          paint: {
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 4, 11, 7, 16, 10],
            'circle-color': ['get', 'markerColor'],
            'circle-stroke-color': '#ffffff',
            'circle-stroke-width': 2,
            'circle-opacity': opacity,
            'circle-stroke-opacity': opacity,
          },
        });
        map.addLayer({
          id: SYMBOL_ID,
          type: 'symbol',
          source: SOURCE_ID,
          minzoom: active.meta.minzoom ?? 0,
          layout: {
            'text-field': ['get', 'symbol'],
            'text-font': ['Noto Sans Bold'],
            'text-size': ['interpolate', ['linear'], ['zoom'], 6, 9, 11, 12, 16, 15],
            'text-allow-overlap': true,
            'text-ignore-placement': true,
          },
          paint: { 'text-color': '#ffffff', 'text-opacity': opacity },
        });
      } else {
        map.setPaintProperty(DOT_ID, 'circle-opacity', opacity);
        map.setPaintProperty(DOT_ID, 'circle-stroke-opacity', opacity);
        map.setPaintProperty(SYMBOL_ID, 'text-opacity', opacity);
      }
    };
    const refresh = async () => {
      const meta = metaRef.current;
      if (!meta || stopped) return;
      try {
        const response = await fetch(overlayFeaturesUrl('', meta));
        if (!response.ok || stopped) return;
        dataRef.current = (await response.json()) as GeoJSON.FeatureCollection;
        (map.getSource(SOURCE_ID) as maplibregl.GeoJSONSource | undefined)?.setData(
          dataRef.current,
        );
      } catch {
        // Retain the last timestamped snapshot while temporarily offline.
      }
    };
    const sync = () => {
      ensure();
      void refresh();
    };
    ensure();
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    map.on('style.load', sync);
    return () => {
      stopped = true;
      clearInterval(timer);
      map.off('style.load', sync);
    };
  }, [map, active, opacity]);
}
