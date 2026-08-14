import type { PotentialView } from '@atlas/app-hooks';
import { transitVehicleFeaturesUrl } from '@atlas/transit';
import type maplibregl from 'maplibre-gl';
import { useEffect, useRef } from 'react';

import type { ActiveOverlay } from './useOverlayLayers.js';

const LAYER_ID = 'transit-vehicles';
const SOURCE_ID = 'atlas-transit-vehicles';
const DOT_ID = 'atlas-transit-vehicles-dot';
const LABEL_ID = 'atlas-transit-vehicles-label';
const REFRESH_MS = 20_000;
const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

export const TRANSIT_VEHICLE_IDENTIFY_LAYERS = [LABEL_ID, DOT_ID];

/** Live Entur vehicles in the settled viewport, refreshed at the upstream feed cadence. */
export function useTransitVehicleLayer(
  map: maplibregl.Map | null,
  overlays: ActiveOverlay[],
  view: PotentialView | null,
): void {
  const active = overlays.find((overlay) => overlay.meta.id === LAYER_ID && overlay.meta.vector);
  const opacity = active?.opacity ?? 1;
  const minzoom = active?.meta.minzoom ?? 8;
  const visible = Boolean(active && view && view.zoom >= minzoom);
  const bboxKey = view?.bbox.map((value) => value.toFixed(5)).join(',') ?? '';
  const dataRef = useRef<GeoJSON.FeatureCollection>(EMPTY);

  useEffect(() => {
    if (!map) return;
    let stopped = false;
    const remove = () => {
      if (!map.getStyle()) return;
      if (map.getLayer(LABEL_ID)) map.removeLayer(LABEL_ID);
      if (map.getLayer(DOT_ID)) map.removeLayer(DOT_ID);
      if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
    };
    if (!visible || !active || !view) {
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
          minzoom,
          paint: {
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 4, 12, 7, 16, 9],
            'circle-color': ['get', 'markerColor'],
            'circle-stroke-color': '#ffffff',
            'circle-stroke-width': 2,
            'circle-opacity': opacity,
            'circle-stroke-opacity': opacity,
          },
        });
        map.addLayer({
          id: LABEL_ID,
          type: 'symbol',
          source: SOURCE_ID,
          minzoom: Math.max(10, minzoom),
          layout: {
            'text-field': ['get', 'line'],
            'text-font': ['Noto Sans Bold'],
            'text-size': ['interpolate', ['linear'], ['zoom'], 10, 10, 15, 12],
            'text-offset': [0, 1.35],
            'text-anchor': 'top',
            'text-optional': true,
          },
          paint: {
            'text-color': '#172033',
            'text-halo-color': '#ffffff',
            'text-halo-width': 1.5,
            'text-opacity': opacity,
          },
        });
      } else {
        map.setPaintProperty(DOT_ID, 'circle-opacity', opacity);
        map.setPaintProperty(DOT_ID, 'circle-stroke-opacity', opacity);
        map.setPaintProperty(LABEL_ID, 'text-opacity', opacity);
      }
    };
    const refresh = async () => {
      try {
        const response = await fetch(transitVehicleFeaturesUrl('', view.bbox));
        if (!response.ok || stopped) return;
        dataRef.current = (await response.json()) as GeoJSON.FeatureCollection;
        (map.getSource(SOURCE_ID) as maplibregl.GeoJSONSource | undefined)?.setData(
          dataRef.current,
        );
      } catch {
        // A live-only overlay keeps the last good positions through a transient outage.
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
  }, [map, visible, bboxKey, opacity, minzoom]);
}
