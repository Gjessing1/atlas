import { parseGpx } from '@atlas/gpx';
import type { AtlasStorage, TrackRecord } from '@atlas/storage';
import { useEffect, useState } from 'react';

/** A GeoJSON FeatureCollection of the currently-visible tracks' geometry. */
export interface TrackGeometry {
  type: 'FeatureCollection';
  features: {
    type: 'Feature';
    properties: { trackId: string; featureKind: 'line' | 'area'; recordKind: 'track' | 'area' };
    geometry:
      | { type: 'MultiLineString'; coordinates: number[][][] }
      | { type: 'MultiPolygon'; coordinates: number[][][][] };
  }[];
}

const EMPTY: TrackGeometry = { type: 'FeatureCollection', features: [] };

/**
 * Loads and caches parsed geometry for every visible track, returning it as one
 * GeoJSON FeatureCollection for a single map ShapeSource/LineLayer — the mobile
 * counterpart of the web's useTrackLayers. GPX bodies are fetched lazily (they
 * can be large) and cached by id, so toggling visibility never re-parses.
 */
export function useTrackGeometry(
  storage: AtlasStorage | null,
  tracks: TrackRecord[],
): TrackGeometry {
  const [geometry, setGeometry] = useState<TrackGeometry>(EMPTY);

  useEffect(() => {
    if (!storage) {
      setGeometry(EMPTY);
      return;
    }
    let cancelled = false;
    const cache = new Map<string, number[][][]>();

    const load = async () => {
      const features: TrackGeometry['features'] = [];
      for (const track of tracks) {
        if (!track.visible) continue;
        let coords = cache.get(track.id);
        if (!coords) {
          const gpx = await storage.getTrackGpx(track.id);
          if (!gpx) continue;
          try {
            const data = parseGpx(gpx);
            coords = data.segments.map((seg) => seg.map((p) => [p.lng, p.lat]));
            cache.set(track.id, coords);
          } catch {
            continue; // skip an unparseable body rather than break the map
          }
        }
        if (coords.length > 0) {
          if (track.area) {
            features.push({
              type: 'Feature',
              properties: { trackId: track.id, featureKind: 'area', recordKind: 'area' },
              geometry: { type: 'MultiPolygon', coordinates: track.area.polygons },
            });
          }
          features.push({
            type: 'Feature',
            properties: {
              trackId: track.id,
              featureKind: 'line',
              recordKind: track.area ? 'area' : 'track',
            },
            geometry: { type: 'MultiLineString', coordinates: coords },
          });
        }
      }
      if (!cancelled) setGeometry({ type: 'FeatureCollection', features });
    };

    void load();
    return () => {
      cancelled = true;
    };
    // Re-run when the set of tracks (or their visibility) changes.
  }, [storage, tracks]);

  return geometry;
}
