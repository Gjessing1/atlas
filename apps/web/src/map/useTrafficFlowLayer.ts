import { overlayFeaturesUrl } from '@atlas/core';
import type maplibregl from 'maplibre-gl';
import { useEffect, useRef } from 'react';

import type { ActiveOverlay } from './useOverlayLayers.js';
import { TRAFFIC_DOT_LAYER } from './useTrafficLayer.js';

const LAYER_ID = 'traffic-flow';
const SOURCE_ID = 'atlas-traffic-flow';
const LINE_ID = 'atlas-traffic-flow-line';
/** NPRA republishes every five minutes; the backend caches for one. */
const REFRESH_MS = 2 * 60_000;
export const TRAFFIC_FLOW_IDENTIFY_LAYERS = [LINE_ID];

const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

/**
 * How the measured corridors are running, drawn as coloured lines.
 *
 * Two details carry more weight than they look:
 *
 * - **`line-offset`.** All 202 corridors come as directional pairs over the
 *   same road, and NPRA separates the carriageways by a median of 13 m — under
 *   a pixel below z15. Without an offset the two directions draw on top of each
 *   other and whichever is painted last wins, so a queue inbound would be
 *   hidden by a clear outbound. Offsetting right of the direction of travel
 *   puts each on its own side, which is also where the traffic is.
 * - **The colour is the feature's**, not a scale in this file: `@atlas/traffic`
 *   classifies, so the phone and the browser cannot disagree about what amber
 *   means.
 */
export function useTrafficFlowLayer(map: maplibregl.Map | null, overlays: ActiveOverlay[]): void {
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
      if (map.getLayer(LINE_ID)) map.removeLayer(LINE_ID);
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
      if (!map.getLayer(LINE_ID)) {
        map.addLayer(
          {
            id: LINE_ID,
            type: 'line',
            source: SOURCE_ID,
            minzoom: active.meta.minzoom ?? 0,
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: {
              'line-color': ['get', 'color'],
              // A corridor with no reading is drawn thinner and fainter as well
              // as grey. It has to be visible — its absence would read as "no
              // corridor here" — without competing with the corridors that
              // actually measured something.
              //
              // The `case` sits inside each zoom stop rather than multiplying
              // the whole interpolate: MapLibre rejects a `zoom` expression
              // that is not the direct input of a top-level interpolate/step,
              // and rejects it at addLayer time, so the layer simply never
              // appears.
              'line-width': [
                'interpolate',
                ['linear'],
                ['zoom'],
                6,
                ['case', ['==', ['get', 'level'], 'unmeasured'], 1.4, 2.5],
                11,
                ['case', ['==', ['get', 'level'], 'unmeasured'], 2.2, 4],
                16,
                ['case', ['==', ['get', 'level'], 'unmeasured'], 3.8, 7],
              ],
              'line-offset': ['interpolate', ['linear'], ['zoom'], 6, 1.5, 11, 2.5, 16, 4.5],
              'line-opacity': [
                'case',
                ['==', ['get', 'level'], 'unmeasured'],
                opacity * 0.5,
                opacity,
              ],
            },
          },
          // Under the closure/incident markers when both are on: a point is
          // aimed at, a corridor is glanced at.
          map.getLayer(TRAFFIC_DOT_LAYER) ? TRAFFIC_DOT_LAYER : undefined,
        );
      } else {
        map.setPaintProperty(LINE_ID, 'line-opacity', [
          'case',
          ['==', ['get', 'level'], 'unmeasured'],
          opacity * 0.5,
          opacity,
        ]);
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
        // Keep the last good snapshot while offline; the tap card says when it
        // was measured, so a stale colour is readable as stale.
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
