import type { TrackData } from '@atlas/gpx';
import type { TrackRecord } from '@atlas/storage';
import type { Feature, FeatureCollection } from 'geojson';
import type maplibregl from 'maplibre-gl';
import { useEffect, useRef } from 'react';

const SOURCE_PREFIX = 'atlas-track-';
const TRACK_COLOR = '#2a78d6';
const SELECTED_COLOR = '#a855f7';

const lineLayerId = (sourceId: string) => `${sourceId}-line`;
const casingLayerId = (sourceId: string) => `${sourceId}-casing`;
const fillLayerId = (sourceId: string) => `${sourceId}-fill`;

/**
 * Lift the selected track's layers above every other track's. Colour alone
 * left it under whichever runs were added after it — and runs from the same
 * front door overlap street for street — so "selected" was invisible exactly
 * where it mattered.
 */
function raiseSelectedTrack(map: maplibregl.Map, selectedId: string | null): void {
  if (!selectedId) return;
  const sourceId = SOURCE_PREFIX + selectedId;
  const own = [fillLayerId(sourceId), casingLayerId(sourceId), lineLayerId(sourceId)];
  if (!map.getLayer(lineLayerId(sourceId))) return;
  const layers = map.getStyle()?.layers ?? [];
  let topTrack = -1;
  layers.forEach((layer, index) => {
    if (layer.id.startsWith(SOURCE_PREFIX) && !own.includes(layer.id)) topTrack = index;
  });
  if (topTrack < 0) return;
  const before = layers.slice(topTrack + 1).find((layer) => !own.includes(layer.id))?.id;
  for (const layerId of own) if (map.getLayer(layerId)) map.moveLayer(layerId, before);
}

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
  selectedTrackId: string | null,
): void {
  // The click handler is registered once; keep the latest callback in a ref.
  const onSelectRef = useRef(onSelectTrack);
  onSelectRef.current = onSelectTrack;
  const selectedIdRef = useRef(selectedTrackId);
  selectedIdRef.current = selectedTrackId;

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
              paint: {
                'fill-color': selectedIdRef.current === track.id ? SELECTED_COLOR : '#c2410c',
                'fill-opacity': selectedIdRef.current === track.id ? 0.25 : 0.16,
              },
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
            paint: {
              'line-color':
                selectedIdRef.current === track.id
                  ? SELECTED_COLOR
                  : track.area
                    ? '#c2410c'
                    : TRACK_COLOR,
              'line-width': selectedIdRef.current === track.id ? 5 : 3,
            },
          });
          raiseSelectedTrack(map, selectedIdRef.current);
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

  // Update existing layers when selection changes without fetching GPX again.
  useEffect(() => {
    if (!map || !map.isStyleLoaded()) return;
    for (const track of tracks) {
      const sourceId = SOURCE_PREFIX + track.id;
      const selected = track.id === selectedTrackId;
      if (map.getLayer(lineLayerId(sourceId))) {
        map.setPaintProperty(
          lineLayerId(sourceId),
          'line-color',
          selected ? SELECTED_COLOR : track.area ? '#c2410c' : TRACK_COLOR,
        );
        map.setPaintProperty(lineLayerId(sourceId), 'line-width', selected ? 5 : 3);
      }
      if (map.getLayer(fillLayerId(sourceId))) {
        map.setPaintProperty(
          fillLayerId(sourceId),
          'fill-color',
          selected ? SELECTED_COLOR : '#c2410c',
        );
        map.setPaintProperty(fillLayerId(sourceId), 'fill-opacity', selected ? 0.25 : 0.16);
      }
    }
    raiseSelectedTrack(map, selectedTrackId);
  }, [map, tracks, selectedTrackId]);

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
      const ids = [
        ...new Set(
          map
            .queryRenderedFeatures(e.point, { layers: trackLayers })
            .map((hit) => hit.properties?.['trackId'])
            .filter((id): id is string => typeof id === 'string'),
        ),
      ];
      if (ids.length === 0) return;
      // Where several tracks overlap, each click steps to the next one, so a
      // buried track can still be picked.
      const current = selectedIdRef.current ? ids.indexOf(selectedIdRef.current) : -1;
      onSelectRef.current(ids[(current + 1) % ids.length]!);
    };
    map.on('click', onClick);
    return () => {
      map.off('click', onClick);
    };
  }, [map]);
}
