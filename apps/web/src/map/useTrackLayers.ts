import type { TrackData } from '@atlas/gpx';
import type { TrackRecord } from '@atlas/storage';
import type { Feature, FeatureCollection } from 'geojson';
import type maplibregl from 'maplibre-gl';
import { useEffect, useRef } from 'react';

const SOURCE_PREFIX = 'atlas-track-';
const TRACK_COLOR = '#2a78d6';

const lineLayerId = (sourceId: string) => `${sourceId}-line`;
const casingLayerId = (sourceId: string) => `${sourceId}-casing`;
const fillLayerId = (sourceId: string) => `${sourceId}-fill`;

function trackFeatures(track: TrackRecord, data: TrackData): FeatureCollection {
  const line: Feature = {
    type: 'Feature',
    properties: {
      trackId: track.id,
      featureKind: 'line',
      recordKind: track.area ? 'area' : 'track',
    },
    geometry: {
      type: 'MultiLineString',
      coordinates: data.segments.map((seg) => seg.map((p) => [p.lng, p.lat])),
    },
  };
  const area: Feature | null = track.area
    ? {
        type: 'Feature',
        properties: { trackId: track.id, featureKind: 'area', recordKind: 'area' },
        geometry: { type: 'MultiPolygon', coordinates: track.area.polygons },
      }
    : null;
  return { type: 'FeatureCollection', features: area ? [area, line] : [line] };
}

/**
 * Keeps one geojson source + casing/line layer pair on the map per visible
 * track. Layers are re-synced after style swaps (setStyle wipes all sources).
 */
export function useTrackLayers(
  map: maplibregl.Map | null,
  tracks: TrackRecord[],
  getTrackData: (id: string) => Promise<TrackData | null>,
  onSelectTrack: (id: string) => void,
): void {
  // The click handler is registered once; keep the latest callback in a ref.
  const onSelectRef = useRef(onSelectTrack);
  onSelectRef.current = onSelectTrack;

  useEffect(() => {
    if (!map) return;
    let cancelled = false;
    const wanted = new Map(tracks.filter((t) => t.visible).map((t) => [SOURCE_PREFIX + t.id, t]));

    const sync = () => {
      if (cancelled || !map.isStyleLoaded()) return; // re-runs on style.load

      for (const sourceId of Object.keys(map.getStyle()?.sources ?? {})) {
        if (!sourceId.startsWith(SOURCE_PREFIX) || wanted.has(sourceId)) continue;
        for (const layerId of [
          lineLayerId(sourceId),
          casingLayerId(sourceId),
          fillLayerId(sourceId),
        ]) {
          if (map.getLayer(layerId)) map.removeLayer(layerId);
        }
        map.removeSource(sourceId);
      }

      for (const [sourceId, track] of wanted) {
        if (map.getSource(sourceId)) continue;
        void getTrackData(track.id).then((data) => {
          if (cancelled || !data || !map.isStyleLoaded() || map.getSource(sourceId)) return;
          map.addSource(sourceId, { type: 'geojson', data: trackFeatures(track, data) });
          if (track.area) {
            map.addLayer({
              id: fillLayerId(sourceId),
              type: 'fill',
              source: sourceId,
              filter: ['==', ['get', 'featureKind'], 'area'],
              paint: { 'fill-color': '#c2410c', 'fill-opacity': 0.16 },
            });
          }
          map.addLayer({
            id: casingLayerId(sourceId),
            type: 'line',
            source: sourceId,
            filter: ['==', ['get', 'featureKind'], 'line'],
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: { 'line-color': '#ffffff', 'line-width': 6, 'line-opacity': 0.85 },
          });
          map.addLayer({
            id: lineLayerId(sourceId),
            type: 'line',
            source: sourceId,
            filter: ['==', ['get', 'featureKind'], 'line'],
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: { 'line-color': track.area ? '#c2410c' : TRACK_COLOR, 'line-width': 3 },
          });
        });
      }
    };

    sync();
    // style.load alone is not enough: isStyleLoaded() can still be false when
    // tracks arrive (sprites/glyphs pending) and the event never fires again.
    // idle fires whenever the map settles, so the sync always gets a retry.
    map.on('style.load', sync);
    map.on('idle', sync);
    return () => {
      cancelled = true;
      map.off('style.load', sync);
      map.off('idle', sync);
    };
  }, [map, tracks, getTrackData]);

  // Clicking a rendered track line selects the track (opens its profile).
  useEffect(() => {
    if (!map) return;
    const onClick = (e: maplibregl.MapMouseEvent) => {
      const style = map.getStyle();
      if (!style?.layers) return;
      const trackLayers = style.layers
        .map((l) => l.id)
        .filter(
          (id) => id.startsWith(SOURCE_PREFIX) && (id.endsWith('-line') || id.endsWith('-fill')),
        );
      if (trackLayers.length === 0) return;
      const hit = map.queryRenderedFeatures(e.point, { layers: trackLayers })[0];
      const trackId = hit?.properties?.['trackId'] as string | undefined;
      if (trackId) onSelectRef.current(trackId);
    };
    map.on('click', onClick);
    return () => {
      map.off('click', onClick);
    };
  }, [map]);
}
