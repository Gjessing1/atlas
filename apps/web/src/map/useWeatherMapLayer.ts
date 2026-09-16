import type { WeatherMapsController } from '@atlas/app-hooks';
import type maplibregl from 'maplibre-gl';
import { useEffect } from 'react';

const SOURCE_PREFIX = 'atlas-weather-map-';

/** Draw the selected weather frame below labels, replacing the source per time step. */
export function useWeatherMapLayer(
  map: maplibregl.Map | null,
  weatherMaps: WeatherMapsController,
): void {
  const layer = weatherMaps.visible ? weatherMaps.layer : null;
  const frame = weatherMaps.visible ? weatherMaps.frame : null;

  useEffect(() => {
    if (!map) return;
    let cancelled = false;
    const wantedId = layer && frame ? `${SOURCE_PREFIX}${layer.id}-${frame.id}` : null;

    const sync = () => {
      if (cancelled) return;
      let style: maplibregl.StyleSpecification;
      try {
        style = map.getStyle();
      } catch {
        return;
      }
      try {
        for (const candidate of style.layers ?? []) {
          if (candidate.id.startsWith(SOURCE_PREFIX) && candidate.id !== wantedId)
            map.removeLayer(candidate.id);
        }
        for (const id of Object.keys(style.sources ?? {})) {
          if (id.startsWith(SOURCE_PREFIX) && id !== wantedId) map.removeSource(id);
        }
        if (!wantedId || !layer || !frame) return;
        const labelAnchor = (style.layers ?? []).find(
          (candidate) => candidate.type === 'symbol',
        )?.id;
        if (!map.getSource(wantedId)) {
          map.addSource(wantedId, {
            type: 'raster',
            tiles: [frame.tileUrlTemplate],
            tileSize: 256,
            minzoom: layer.minzoom,
            maxzoom: layer.maxzoom,
            attribution: weatherMaps.attribution,
          });
        }
        if (!map.getLayer(wantedId)) {
          map.addLayer(
            {
              id: wantedId,
              type: 'raster',
              source: wantedId,
              paint: { 'raster-opacity': 0.78, 'raster-fade-duration': 250 },
            },
            labelAnchor,
          );
        }
      } catch {
        // A style swap retries on style.load/idle.
      }
    };

    sync();
    map.on('style.load', sync);
    map.on('idle', sync);
    return () => {
      cancelled = true;
      map.off('style.load', sync);
      map.off('idle', sync);
    };
  }, [map, layer, frame, weatherMaps.attribution]);
}
