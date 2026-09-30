import { overlayFeaturesUrl, PUBLIC_TOILETS_ID } from '@atlas/core';
import type maplibregl from 'maplibre-gl';
import { useEffect, useRef } from 'react';
import type { ActiveOverlay } from './useOverlayLayers.js';

const SOURCE_ID = 'atlas-public-toilets';
const DISC = 'atlas-public-toilets-disc';
const ICON = 'atlas-public-toilets-icon';
const NAME = 'atlas-public-toilets-name';
const ALL_LAYERS = [DISC, ICON, NAME];

/** Hit-test layers shared with the single map identify pass. */
export const PUBLIC_TOILET_IDENTIFY_LAYERS = [ICON, DISC];

/** WC-sign blue, apart from the explore results' teal so the two never read as one layer. */
const TOILET_COLOR = '#1d4ed8';

const EMPTY_FC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

/**
 * The public-toilets overlay (Curiosities): NVDB's road-side toilets and the
 * Oslo, Bergen and Stavanger city lists, merged server-side into one
 * ~900-point GeoJSON. A blue disc
 * carrying the basemap sprite's `toilets` icon — the same glyph the Toilets
 * search category draws — and the name from z14 where the register has one.
 * What a tap says is `publicToiletIdentify` in @atlas/core.
 *
 * The hunting-fields hook's fetch-once discipline, applied to points.
 */
export function usePublicToiletsLayer(map: maplibregl.Map | null, overlays: ActiveOverlay[]): void {
  const dataRef = useRef<GeoJSON.FeatureCollection | null>(null);
  const fetchingRef = useRef(false);

  const active = overlays.find((o) => o.meta.id === PUBLIC_TOILETS_ID && o.meta.vector);
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
      if (cancelled || !map.getStyle()) return;
      if (!map.getSource(SOURCE_ID)) {
        map.addSource(SOURCE_ID, { type: 'geojson', data: dataRef.current ?? EMPTY_FC });
      }
      if (!map.getLayer(DISC)) {
        map.addLayer({
          id: DISC,
          type: 'circle',
          source: SOURCE_ID,
          paint: {
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, 3.5, 10, 8, 14, 12],
            'circle-color': TOILET_COLOR,
            'circle-stroke-color': '#ffffff',
            'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 5, 1, 10, 1.5],
            'circle-opacity': opacity,
            'circle-stroke-opacity': opacity,
          },
        });
        map.addLayer({
          id: ICON,
          type: 'symbol',
          source: SOURCE_ID,
          // Below z10 the disc is too small to hold a legible glyph.
          minzoom: 10,
          layout: {
            'icon-image': 'toilets',
            'icon-size': ['interpolate', ['linear'], ['zoom'], 10, 0.55, 14, 0.8],
            'icon-allow-overlap': true,
            'icon-ignore-placement': true,
          },
          paint: { 'icon-opacity': opacity },
        });
        map.addLayer({
          id: NAME,
          type: 'symbol',
          source: SOURCE_ID,
          minzoom: 14,
          layout: {
            'text-field': ['coalesce', ['get', 'name'], ''],
            'text-font': ['Noto Sans Bold'],
            'text-size': 11,
            'text-anchor': 'top',
            'text-offset': [0, 1.3],
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
        map.setPaintProperty(DISC, 'circle-opacity', opacity);
        map.setPaintProperty(DISC, 'circle-stroke-opacity', opacity);
        map.setPaintProperty(ICON, 'icon-opacity', opacity);
        map.setPaintProperty(NAME, 'text-opacity', opacity);
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
}
