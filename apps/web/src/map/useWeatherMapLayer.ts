import type { WeatherMapsController } from '@atlas/app-hooks';
import { WEATHER_FRAME_FADE } from '@atlas/conditions';
import type maplibregl from 'maplibre-gl';
import { useEffect, useRef } from 'react';

const PREFIX = 'atlas-weather-map-';
/** A frame that never finishes loading is shown after this, rather than never. */
const SHOW_ANYWAY_MS = 3_000;
const HIDDEN = { duration: 0, delay: 0 };
const FADE_IN = { duration: WEATHER_FRAME_FADE.inMs, delay: 0 };
const FADE_OUT = { duration: WEATHER_FRAME_FADE.outMs, delay: WEATHER_FRAME_FADE.outDelayMs };
const FADE_OUT_TOTAL_MS = WEATHER_FRAME_FADE.outDelayMs + WEATHER_FRAME_FADE.outMs;

/**
 * The switched-on weather field's current frame, under the basemap's labels.
 *
 * Each frame is its own raster source. The frames play reaches next are added
 * too, at zero opacity, so their tiles load before they are needed. A frame is
 * shown only once its tiles have loaded for the view on screen — until then the
 * picture before it stays up — and it replaces that picture by crossfading
 * (WEATHER_FRAME_FADE), the old one starting to fade just after the new one. Play
 * asks the same readiness question before it steps (`setFrameReadiness`), so it
 * slows down on a slow connection instead of flashing the map between frames.
 */
export function useWeatherMapLayer(
  map: maplibregl.Map | null,
  maps: WeatherMapsController,
  opacity: number,
): void {
  const { layerId, timeline, frame, upcoming, attribution, setFrameReadiness } = maps;
  // The frame last actually shown: kept on screen until its successor is ready.
  const shownRef = useRef<string | null>(null);
  // Frames fading out, until when (ms) they must stay in the style.
  const fadingRef = useRef(new Map<string, number>());
  // Sources that have delivered at least one tile: a source added a moment ago
  // has no tiles *requested* yet, and MapLibre reports that as loaded.
  const deliveredRef = useRef(new Set<string>());
  // When the frame now wanted first became wanted, for SHOW_ANYWAY_MS.
  const wantedSinceRef = useRef<{ id: string | null; at: number }>({ id: null, at: 0 });
  const upcomingKey = upcoming.map((f) => f.id).join(',');

  const sourceIdOf = (frameId: string) => `${PREFIX}${layerId}-${frameId}`;

  // Readiness, for play and for the swap below.
  useEffect(() => {
    if (!map || !layerId || !timeline) {
      setFrameReadiness(null);
      return;
    }
    const [w, s, e, n] = timeline.bounds;
    const ready = (sourceId: string): boolean => {
      try {
        if (!map.getSource(sourceId)) return false;
        const view = map.getBounds();
        // Nothing of this field in view: there is nothing to wait for.
        if (
          view.getEast() < w ||
          view.getWest() > e ||
          view.getNorth() < s ||
          view.getSouth() > n ||
          map.getZoom() < timeline.minzoom
        ) {
          return true;
        }
        return deliveredRef.current.has(sourceId) && map.isSourceLoaded(sourceId);
      } catch {
        return false;
      }
    };
    setFrameReadiness((frameId) => ready(`${PREFIX}${layerId}-${frameId}`));
    return () => setFrameReadiness(null);
  }, [map, layerId, timeline, setFrameReadiness]);

  useEffect(() => {
    if (!map) return;
    let cancelled = false;
    let fadeTimer: ReturnType<typeof setTimeout> | undefined;
    const wanted = frame && timeline && layerId ? [frame, ...upcoming] : [];
    const currentId = frame && layerId ? sourceIdOf(frame.id) : null;
    if (wantedSinceRef.current.id !== currentId) {
      wantedSinceRef.current = { id: currentId, at: Date.now() };
    }

    const loaded = (id: string) => {
      try {
        return deliveredRef.current.has(id) && map.isSourceLoaded(id);
      } catch {
        return false;
      }
    };

    const sync = () => {
      if (cancelled) return;
      let style: maplibregl.StyleSpecification;
      try {
        style = map.getStyle();
      } catch {
        return;
      }
      try {
        const now = Date.now();
        const previous = shownRef.current;
        const fading = fadingRef.current;
        for (const [id, until] of fading) if (until <= now || id === currentId) fading.delete(id);

        let visibleId: string | null;
        if (currentId === null) {
          // Switched off: nothing stays, and nothing fades.
          visibleId = null;
          fading.clear();
        } else if (
          previous === currentId ||
          !previous ||
          !map.getSource(previous) ||
          (map.getSource(currentId) && loaded(currentId)) ||
          now - wantedSinceRef.current.at > SHOW_ANYWAY_MS
        ) {
          visibleId = currentId;
        } else {
          visibleId = previous;
        }
        if (previous && visibleId !== previous && visibleId !== null && map.getSource(previous)) {
          fading.set(previous, now + FADE_OUT_TOTAL_MS + 50);
        }

        const keep = new Set(wanted.map((f) => sourceIdOf(f.id)));
        if (visibleId) keep.add(visibleId);
        for (const id of fading.keys()) keep.add(id);
        for (const layer of style.layers ?? []) {
          if (layer.id.startsWith(PREFIX) && !keep.has(layer.id)) map.removeLayer(layer.id);
        }
        for (const id of Object.keys(style.sources ?? {})) {
          if (id.startsWith(PREFIX) && !keep.has(id)) {
            map.removeSource(id);
            deliveredRef.current.delete(id);
          }
        }
        if (!timeline) {
          shownRef.current = null;
          return;
        }

        const labelAnchor = (style.layers ?? []).find((layer) => layer.type === 'symbol')?.id;
        for (const next of wanted) {
          const id = sourceIdOf(next.id);
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
                paint: {
                  'raster-opacity': 0,
                  'raster-opacity-transition': HIDDEN,
                  'raster-fade-duration': 0,
                },
              },
              labelAnchor,
            );
          }
        }
        for (const id of keep) {
          if (!map.getLayer(id)) continue;
          if (id === visibleId) {
            map.setPaintProperty(id, 'raster-opacity-transition', FADE_IN);
            map.setPaintProperty(id, 'raster-opacity', opacity);
          } else if (fading.has(id)) {
            map.setPaintProperty(id, 'raster-opacity-transition', FADE_OUT);
            map.setPaintProperty(id, 'raster-opacity', 0);
          } else {
            map.setPaintProperty(id, 'raster-opacity-transition', HIDDEN);
            map.setPaintProperty(id, 'raster-opacity', 0);
          }
        }
        shownRef.current = visibleId;
        // Take the faded-out frames out of the style once they are invisible.
        if (fading.size > 0) {
          clearTimeout(fadeTimer);
          fadeTimer = setTimeout(sync, Math.max(...fading.values()) - now + 10);
        }
      } catch {
        // The style is mid-swap: style.load re-runs this pass.
      }
    };

    // The moment the frame being waited for has its tiles is the moment to show it.
    const onData = (event: maplibregl.MapSourceDataEvent) => {
      if (!event.sourceId?.startsWith(PREFIX)) return;
      if (event.tile) deliveredRef.current.add(event.sourceId);
      if (event.sourceId === currentId && shownRef.current !== currentId) sync();
    };
    // A style swap drops every source; their tiles must be delivered again.
    const onStyle = () => {
      deliveredRef.current.clear();
      sync();
    };

    sync();
    map.on('style.load', onStyle);
    map.on('idle', sync);
    map.on('sourcedata', onData);
    // Waiting out SHOW_ANYWAY_MS needs a clock when the map has gone quiet.
    const showAnyway = setTimeout(sync, SHOW_ANYWAY_MS + 20);
    return () => {
      cancelled = true;
      clearTimeout(fadeTimer);
      clearTimeout(showAnyway);
      map.off('style.load', onStyle);
      map.off('idle', sync);
      map.off('sourcedata', onData);
    };
    // upcomingKey stands in for `upcoming`, a fresh array on every render.
  }, [map, layerId, timeline, frame?.id, upcomingKey, opacity, attribution]);
}
