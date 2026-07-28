import {
  ICE_OBSERVATIONS_ID,
  iceObservationsUrl,
  type IceObservationsResponse,
  type LngLatBbox,
} from '@atlas/core';
import type maplibregl from 'maplibre-gl';
import { useEffect, useRef } from 'react';
import type { ActiveOverlay } from './useOverlayLayers.js';

const SOURCE_ID = 'atlas-ice-observations';
const DOT = 'atlas-ice-observations-dot';
const SYMBOL = 'atlas-ice-observations-symbol';
const ALL_LAYERS = [DOT, SYMBOL];

/** Hit-test layers shared with the single map identify pass. */
export const ICE_OBSERVATION_IDENTIFY_LAYERS = [SYMBOL, DOT];

const EMPTY: IceObservationsResponse = { type: 'FeatureCollection', features: [] };

const viewport = (map: maplibregl.Map): LngLatBbox => {
  const bounds = map.getBounds();
  const w = Math.max(-180, bounds.getWest());
  const s = Math.max(-85, bounds.getSouth());
  const e = Math.min(180, bounds.getEast());
  const n = Math.min(85, bounds.getNorth());
  return [w, s, e, n];
};

/**
 * Rolling Regobs ice markers for the settled viewport. Report kind is the
 * centre symbol; marker colour follows Iskart's observation-age bands. The
 * exact submitted timestamp and report details are handled by the shared
 * `iceObservationIdentify` builder on tap.
 */
export function useIceObservationsLayer(
  map: maplibregl.Map | null,
  overlays: ActiveOverlay[],
): void {
  const dataRef = useRef<IceObservationsResponse>(EMPTY);
  const loadedKeyRef = useRef<string | null>(null);
  const fetchingKeyRef = useRef<string | null>(null);
  const revisionRef = useRef(0);

  const active = overlays.find((o) => o.meta.id === ICE_OBSERVATIONS_ID && o.meta.vector);
  const rev = active?.meta.rev ?? 0;
  const opacity = active?.opacity ?? 1;
  const metaRef = useRef(active?.meta);
  metaRef.current = active?.meta;

  useEffect(() => {
    if (!map) return;
    let cancelled = false;

    if (revisionRef.current !== rev) {
      revisionRef.current = rev;
      dataRef.current = EMPTY;
      loadedKeyRef.current = null;
    }

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
      if (cancelled || !map.getStyle()) return;
      if (!map.getSource(SOURCE_ID)) {
        map.addSource(SOURCE_ID, { type: 'geojson', data: dataRef.current });
      }
      if (!map.getLayer(DOT)) {
        const minzoom = metaRef.current?.minzoom ?? 7;
        map.addLayer({
          id: DOT,
          type: 'circle',
          source: SOURCE_ID,
          minzoom,
          paint: {
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 7, 7, 12, 10, 16, 12],
            'circle-color': ['get', 'markerColor'],
            'circle-stroke-width': 2,
            'circle-stroke-color': '#ffffff',
            'circle-opacity': opacity,
            'circle-stroke-opacity': opacity,
          },
        });
        map.addLayer({
          id: SYMBOL,
          type: 'symbol',
          source: SOURCE_ID,
          minzoom,
          layout: {
            'text-field': ['get', 'symbol'],
            'text-font': ['Noto Sans Bold'],
            'text-size': ['interpolate', ['linear'], ['zoom'], 7, 10, 12, 13, 16, 15],
            'text-allow-overlap': true,
            'text-ignore-placement': true,
          },
          paint: {
            'text-color': '#ffffff',
            'text-halo-color': 'rgba(0,0,0,0.18)',
            'text-halo-width': 0.7,
            'text-opacity': opacity,
          },
        });
      } else {
        map.setPaintProperty(DOT, 'circle-opacity', opacity);
        map.setPaintProperty(DOT, 'circle-stroke-opacity', opacity);
        map.setPaintProperty(SYMBOL, 'text-opacity', opacity);
      }
    };

    const refresh = () => {
      const meta = metaRef.current;
      if (!meta || map.getZoom() < (meta.minzoom ?? 0)) return;
      const bbox = viewport(map);
      const key = bbox.map((value) => value.toFixed(3)).join(',');
      if (loadedKeyRef.current === key || fetchingKeyRef.current === key) return;
      fetchingKeyRef.current = key;
      void (async () => {
        try {
          const res = await fetch(iceObservationsUrl('', meta, bbox));
          if (!res.ok || metaRef.current?.rev !== meta.rev) return;
          const body = (await res.json()) as IceObservationsResponse;
          dataRef.current = body;
          loadedKeyRef.current = key;
          // An opacity edit re-runs the effect while this request is in flight.
          // The payload still belongs to the same rev; do not throw it away and
          // leave the replacement effect waiting on a request that just ended.
          if (metaRef.current?.id === ICE_OBSERVATIONS_ID) {
            const source = map.getSource(SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
            source?.setData(body);
          }
        } catch {
          // Offline/transient: keep the last viewport's observations visible;
          // the next settled move retries.
        } finally {
          if (fetchingKeyRef.current === key) fetchingKeyRef.current = null;
        }
      })();
    };

    const sync = () => {
      ensure();
      refresh();
    };
    sync();
    map.on('style.load', sync);
    map.on('moveend', sync);
    return () => {
      cancelled = true;
      map.off('style.load', sync);
      map.off('moveend', sync);
    };
  }, [map, Boolean(active), rev, opacity]);
}
