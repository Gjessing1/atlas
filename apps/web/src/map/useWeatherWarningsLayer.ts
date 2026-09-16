import { WEATHER_WARNINGS_ID } from '@atlas/conditions';
import { overlayFeaturesUrl } from '@atlas/core';
import type maplibregl from 'maplibre-gl';
import { useEffect, useRef } from 'react';

import type { ActiveOverlay } from './useOverlayLayers.js';

const SOURCE_ID = 'atlas-weather-warnings';
const FILL_ID = 'atlas-weather-warnings-fill';
const LINE_ID = 'atlas-weather-warnings-line';
const BADGE_ID = 'atlas-weather-warnings-badge';
const BADGE_TEXT_ID = 'atlas-weather-warnings-badge-text';
const BADGE_LABEL_ID = 'atlas-weather-warnings-badge-label';
const REFRESH_MS = 5 * 60_000;
const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

/** Tapping a warning's area or its badge describes it. */
export const WEATHER_WARNING_IDENTIFY_LAYERS = [BADGE_ID, FILL_ID];

const isBadge: maplibregl.FilterSpecification = ['==', ['get', 'badge'], true];
const isArea: maplibregl.FilterSpecification = ['!=', ['get', 'badge'], true];

/**
 * MET's live weather warnings: each area filled faintly and outlined in its
 * level's colour, with a badge naming the hazard at its centre. Areas sit under
 * the basemap's labels; badges over everything, because a badge you cannot see
 * is the whole point lost.
 */
export function useWeatherWarningsLayer(
  map: maplibregl.Map | null,
  overlays: ActiveOverlay[],
): void {
  const active = overlays.find((overlay) => overlay.meta.id === WEATHER_WARNINGS_ID);
  const present = Boolean(active?.meta.vector);
  const opacity = active?.opacity ?? 1;
  const dataRef = useRef<GeoJSON.FeatureCollection>(EMPTY);
  const metaRef = useRef(active?.meta);
  metaRef.current = active?.meta;

  useEffect(() => {
    if (!map) return;
    let stopped = false;
    const remove = () => {
      try {
        for (const id of [BADGE_LABEL_ID, BADGE_TEXT_ID, BADGE_ID, LINE_ID, FILL_ID]) {
          if (map.getLayer(id)) map.removeLayer(id);
        }
        if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
      } catch {
        // No style yet: nothing to remove.
      }
    };
    if (!present) {
      remove();
      return;
    }
    const ensure = () => {
      if (stopped) return;
      let style: maplibregl.StyleSpecification;
      try {
        style = map.getStyle();
      } catch {
        return;
      }
      try {
        if (!map.getSource(SOURCE_ID)) {
          map.addSource(SOURCE_ID, {
            type: 'geojson',
            data: dataRef.current,
            attribution: metaRef.current?.attribution,
          });
        }
        const labelAnchor = (style.layers ?? []).find((layer) => layer.type === 'symbol')?.id;
        if (!map.getLayer(FILL_ID)) {
          map.addLayer(
            {
              id: FILL_ID,
              type: 'fill',
              source: SOURCE_ID,
              filter: isArea,
              paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.25 * opacity },
            },
            labelAnchor,
          );
          map.addLayer(
            {
              id: LINE_ID,
              type: 'line',
              source: SOURCE_ID,
              filter: isArea,
              paint: {
                'line-color': ['get', 'color'],
                'line-width': ['interpolate', ['linear'], ['zoom'], 4, 1.2, 10, 2.2],
                'line-opacity': opacity,
              },
            },
            labelAnchor,
          );
          map.addLayer({
            id: BADGE_ID,
            type: 'circle',
            source: SOURCE_ID,
            filter: isBadge,
            paint: {
              'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, 8, 8, 12],
              'circle-color': ['get', 'color'],
              'circle-stroke-color': '#ffffff',
              'circle-stroke-width': 2,
              'circle-opacity': opacity,
              'circle-stroke-opacity': opacity,
            },
          });
          map.addLayer({
            id: BADGE_TEXT_ID,
            type: 'symbol',
            source: SOURCE_ID,
            filter: isBadge,
            layout: {
              'text-field': '!',
              'text-font': ['Noto Sans Bold'],
              'text-size': ['interpolate', ['linear'], ['zoom'], 3, 11, 8, 15],
              'text-allow-overlap': true,
              'text-ignore-placement': true,
            },
            paint: {
              // Dark on yellow reads; white on orange and red does.
              'text-color': ['match', ['get', 'level'], 'yellow', '#2b2200', '#ffffff'],
              'text-opacity': opacity,
            },
          });
          map.addLayer({
            id: BADGE_LABEL_ID,
            type: 'symbol',
            source: SOURCE_ID,
            filter: isBadge,
            minzoom: 5,
            layout: {
              'text-field': ['get', 'eventLabel'],
              'text-font': ['Noto Sans Bold'],
              'text-size': 12,
              'text-anchor': 'top',
              'text-offset': [0, 1.1],
            },
            paint: {
              'text-color': '#1f2328',
              'text-halo-color': '#ffffff',
              'text-halo-width': 1.5,
              'text-opacity': opacity,
            },
          });
        } else {
          map.setPaintProperty(FILL_ID, 'fill-opacity', 0.25 * opacity);
          map.setPaintProperty(LINE_ID, 'line-opacity', opacity);
          map.setPaintProperty(BADGE_ID, 'circle-opacity', opacity);
          map.setPaintProperty(BADGE_ID, 'circle-stroke-opacity', opacity);
          map.setPaintProperty(BADGE_TEXT_ID, 'text-opacity', opacity);
          map.setPaintProperty(BADGE_LABEL_ID, 'text-opacity', opacity);
        }
      } catch {
        // Mid style swap; style.load retries.
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
        // Keep the last warnings drawn while offline.
      }
    };
    ensure();
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    map.on('style.load', ensure);
    return () => {
      stopped = true;
      clearInterval(timer);
      map.off('style.load', ensure);
    };
  }, [map, present, opacity]);
}
