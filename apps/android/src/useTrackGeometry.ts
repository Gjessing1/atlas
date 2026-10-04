import { parseGpx, trackLineCoordinates, type TrackData } from '@atlas/gpx';
import type { AtlasStorage, TrackRecord } from '@atlas/storage';
import { useEffect, useRef, useState } from 'react';

type TrackFeature = TrackGeometry['features'][number];

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
 * Metres of deviation the drawn overview line may take. GPS noise alone is
 * about this, and a 1 Hz run keeps a small fraction of its points; the selected
 * track is drawn from its full geometry on a layer of its own.
 */
const DRAW_TOLERANCE_M = 3;

/** How many newly parsed tracks to collect before handing the map a new set. */
const PUBLISH_EVERY = 25;

function featuresFor(track: TrackRecord, coords: number[][][]): TrackFeature[] {
  if (coords.length === 0) return [];
  const line: TrackFeature = {
    type: 'Feature',
    properties: {
      trackId: track.id,
      featureKind: 'line',
      recordKind: track.area ? 'area' : 'track',
    },
    geometry: { type: 'MultiLineString', coordinates: coords },
  };
  if (!track.area) return [line];
  return [
    {
      type: 'Feature',
      properties: { trackId: track.id, featureKind: 'area', recordKind: 'area' },
      geometry: { type: 'MultiPolygon', coordinates: track.area.polygons },
    },
    line,
  ];
}

/** One track at full resolution — the selected track's own top layer. */
export function selectedTrackGeometry(track: TrackRecord, data: TrackData): TrackGeometry {
  return { type: 'FeatureCollection', features: featuresFor(track, trackLineCoordinates(data)) };
}

/**
 * Parsed geometry for the tracks the map should draw (the caller passes only
 * effectively-visible ones), as one GeoJSON FeatureCollection for a single map
 * source — the mobile counterpart of the web's useTrackLayers.
 *
 * The parse cache lives for the whole session, keyed by id and `updatedAt`:
 * hiding a folder, toggling one track or a sync refresh used to re-read and
 * re-parse every visible GPX body, one at a time, before the map changed at
 * all — with a few hundred imported activities that was the slow app and the
 * line that "never appeared". Now only tracks not seen before are loaded, and
 * the map gets what is already parsed straight away.
 */
export function useTrackGeometry(
  storage: AtlasStorage | null,
  tracks: TrackRecord[],
): TrackGeometry {
  const [geometry, setGeometry] = useState<TrackGeometry>(EMPTY);
  const cache = useRef(new Map<string, { updatedAt: number; coords: number[][][] }>());
  // What the map currently shows, so an unchanged set never re-tiles the source.
  const shown = useRef('');

  useEffect(() => {
    if (!storage) {
      shown.current = '';
      setGeometry(EMPTY);
      return;
    }
    let cancelled = false;

    const publish = () => {
      const features: TrackFeature[] = [];
      const ids: string[] = [];
      for (const track of tracks) {
        const entry = cache.current.get(track.id);
        if (!entry || entry.updatedAt !== track.updatedAt) continue;
        features.push(...featuresFor(track, entry.coords));
        ids.push(`${track.id}@${track.updatedAt}`);
      }
      const key = ids.join(',');
      if (key === shown.current) return;
      shown.current = key;
      setGeometry({ type: 'FeatureCollection', features });
    };

    const load = async () => {
      publish();
      let pending = 0;
      for (const track of tracks) {
        if (cancelled) return;
        if (cache.current.get(track.id)?.updatedAt === track.updatedAt) continue;
        const gpx = await storage.getTrackGpx(track.id);
        let coords: number[][][] = [];
        if (gpx) {
          try {
            coords = trackLineCoordinates(parseGpx(gpx), DRAW_TOLERANCE_M);
          } catch {
            // An unparseable body draws nothing rather than breaking the map.
          }
        }
        cache.current.set(track.id, { updatedAt: track.updatedAt, coords });
        if (++pending >= PUBLISH_EVERY && !cancelled) {
          pending = 0;
          publish();
        }
      }
      if (!cancelled) publish();
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [storage, tracks]);

  return geometry;
}
