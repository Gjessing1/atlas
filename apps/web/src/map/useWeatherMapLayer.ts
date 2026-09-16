import type { WeatherMapsController } from '@atlas/app-hooks';
import type maplibregl from 'maplibre-gl';
import { useEffect, useRef } from 'react';

const PREFIX = 'atlas-weather-map-';

/**
 * The switched-on weather field's current frame, under the basemap's labels.
 *
 * Each frame is its own raster source. The frames play reaches next are added
 * too, at zero opacity, so their tiles are fetched before they are shown — and
 * the picture on screen only changes once the new frame has loaded. Swapping a
 * source's URL in place, or showing a frame whose tiles are still on their way,
 * blanks the map between steps and makes the animation strobe.
 */
export function useWeatherMapLayer(
  map: maplibregl.Map | null,
  maps: WeatherMapsController,
  opacity: number,
): void {
  const { layerId, timeline, frame, upcoming, attribution } = maps;
  // The frame last actually shown: kept on screen until its successor is ready.
  const shownRef = useRef<string | null>(null);
  const upcomingKey = upcoming.map((f) => f.id).join(',');

  useEffect(() => {
    if (!map) return;
    let cancelled = false;
    const sourceId = (frameId: string) => `${PREFIX}${layerId}-${frameId}`;
    const wanted = frame && timeline && layerId ? [frame, ...upcoming] : [];
    const currentId = frame && layerId ? sourceId(frame.id) : null;

    const sync = () => {
      if (cancelled) return;
      let style: maplibregl.StyleSpecification;
      try {
        style = map.getStyle();
      } catch {
        return;
      }
      try {
        const previous = shownRef.current;
        const currentReady =
          currentId !== null && Boolean(map.getSource(currentId)) && map.isSourceLoaded(currentId);
        // Switched off, nothing stays; otherwise hold the old frame until the new one is in.
        const visibleId =
          currentId === null ||
          currentReady ||
          !previous ||
          previous === currentId ||
          !map.getSource(previous)
            ? currentId
            : previous;

        const keep = new Set(wanted.map((f) => sourceId(f.id)));
        if (visibleId) keep.add(visibleId);
        for (const layer of style.layers ?? []) {
          if (layer.id.startsWith(PREFIX) && !keep.has(layer.id)) map.removeLayer(layer.id);
        }
        for (const id of Object.keys(style.sources ?? {})) {
          if (id.startsWith(PREFIX) && !keep.has(id)) map.removeSource(id);
        }
        if (!timeline) {
          shownRef.current = null;
          return;
        }

        const labelAnchor = (style.layers ?? []).find((layer) => layer.type === 'symbol')?.id;
        for (const next of wanted) {
          const id = sourceId(next.id);
          if (!map.getSource(id)) {
            map.addSource(id, {
              type: 'raster',
              tiles: [next.tileUrlTemplate],
              tileSize: 256,
              minzoom: timeline.minzoom,
              maxzoom: timeline.maxzoom,
              bounds: timeline.bounds,
              attribution,
            });
          }
          if (!map.getLayer(id)) {
            map.addLayer(
              {
                id,
                type: 'raster',
                source: id,
                paint: { 'raster-opacity': 0, 'raster-fade-duration': 0 },
              },
              labelAnchor,
            );
          }
        }
        for (const id of keep) {
          if (map.getLayer(id)) {
            map.setPaintProperty(id, 'raster-opacity', id === visibleId ? opacity : 0);
          }
        }
        shownRef.current = visibleId;
      } catch {
        // The style is mid-swap: style.load re-runs this pass.
      }
    };

    // The moment the frame being waited for finishes loading is the moment to show it.
    const onData = (event: maplibregl.MapSourceDataEvent) => {
      if (event.sourceId === currentId && shownRef.current !== currentId) sync();
    };

    sync();
    map.on('style.load', sync);
    map.on('idle', sync);
    map.on('sourcedata', onData);
    return () => {
      cancelled = true;
      map.off('style.load', sync);
      map.off('idle', sync);
      map.off('sourcedata', onData);
    };
    // upcomingKey stands in for `upcoming`, a fresh array on every render.
  }, [map, layerId, timeline, frame?.id, upcomingKey, opacity, attribution]);
}
