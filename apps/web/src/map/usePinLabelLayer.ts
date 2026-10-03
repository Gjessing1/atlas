import {
  PIN_LABEL_LAYOUT,
  PIN_LABEL_MINZOOM,
  PIN_LABEL_PAINT,
  type PinLabelFeature,
} from '@atlas/core';
import type maplibregl from 'maplibre-gl';
import { useEffect, useRef } from 'react';

const SOURCE_ID = 'atlas-pin-labels';
const LAYER_ID = 'atlas-pin-labels';

/**
 * Names under the pins of labelled folders and tags (`usePinLabels`).
 *
 * The pins are DOM markers, but their names are a symbol layer on purpose:
 * that is what puts them through MapLibre's collision pass, so a dense folder
 * thins its labels out zooming out instead of stacking them. Added last, above
 * the basemap's own labels, so a name the user asked for wins over a street
 * name in the same spot.
 */
export function usePinLabelLayer(
  map: maplibregl.Map | null,
  data: { type: 'FeatureCollection'; features: PinLabelFeature[] },
): void {
  const dataRef = useRef(data);
  dataRef.current = data;

  useEffect(() => {
    if (!map) return;
    let cancelled = false;

    if (data.features.length === 0) {
      if (!map.getStyle()) return;
      if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID);
      if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
      return;
    }

    const ensure = () => {
      // The style existing, not `isStyleLoaded()` — see useSavedStandLayer.
      if (cancelled || !map.getStyle()) return;
      const source = map.getSource(SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
      const geojson = dataRef.current as unknown as GeoJSON.FeatureCollection;
      if (!source) map.addSource(SOURCE_ID, { type: 'geojson', data: geojson });
      else source.setData(geojson);
      if (!map.getLayer(LAYER_ID)) {
        map.addLayer({
          id: LAYER_ID,
          type: 'symbol',
          source: SOURCE_ID,
          minzoom: PIN_LABEL_MINZOOM,
          layout: PIN_LABEL_LAYOUT,
          paint: PIN_LABEL_PAINT,
        });
      }
    };

    ensure();
    map.on('style.load', ensure);
    map.on('styledata', ensure);
    return () => {
      cancelled = true;
      map.off('style.load', ensure);
      map.off('styledata', ensure);
    };
  }, [map, data]);
}
