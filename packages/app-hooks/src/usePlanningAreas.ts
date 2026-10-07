/**
 * Visible saved permit boundaries available to field-planning tools.
 *
 * Newer iNatur saves carry filled polygon topology on the track record. Older
 * saves (including Sleikebekk) predate that field but still carry closed GPX
 * rings and the `iNatur permit` tag, so they are recovered rather than forcing
 * the user to delete and save the same permit again.
 */

import type { LngLatBbox } from '@atlas/core';
import type { TrackData } from '@atlas/gpx';
import type { TrackRecord } from '@atlas/storage';
import { isAreaTrack } from './libraryViews.js';
import { useEffect, useState } from 'react';

export interface PlanningArea {
  readonly id: string;
  readonly name: string;
  readonly bbox: LngLatBbox;
  /** MultiPolygon → polygon → ring → [lng,lat]. */
  readonly polygons: readonly (readonly (readonly (readonly [number, number])[])[])[];
}

function bounds(polygons: PlanningArea['polygons']): LngLatBbox | null {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const polygon of polygons) {
    for (const ring of polygon) {
      for (const [lng, lat] of ring) {
        west = Math.min(west, lng);
        south = Math.min(south, lat);
        east = Math.max(east, lng);
        north = Math.max(north, lat);
      }
    }
  }
  return Number.isFinite(west) ? [west, south, east, north] : null;
}

/** Recover one visible area from its record and, for legacy saves, its GPX. */
export function planningArea(track: TrackRecord, data: TrackData | null): PlanningArea | null {
  if (!track.visible) return null;
  if (track.area) {
    return {
      id: track.id,
      name: track.name,
      bbox: track.area.bbox,
      polygons: track.area.polygons,
    };
  }
  if (!isAreaTrack(track) || !data) return null;

  // iNatur GPX export stores one closed segment per boundary ring. Without the
  // original topology we cannot recover holes reliably, so each closed ring is
  // a polygon. This is conservative for the common no-hole permit and still
  // better than treating its bbox as permission; new saves keep exact holes.
  const polygons = data.segments.flatMap((segment) => {
    if (segment.length < 4) return [];
    const ring = segment.map((point) => [point.lng, point.lat] as [number, number]);
    const first = ring[0]!;
    const last = ring[ring.length - 1]!;
    if (first[0] !== last[0] || first[1] !== last[1]) ring.push(first);
    return [[ring]];
  });
  const bbox = bounds(polygons);
  return bbox ? { id: track.id, name: track.name, bbox, polygons } : null;
}

export function usePlanningAreas(
  tracks: readonly TrackRecord[],
  getTrackData: (id: string) => Promise<TrackData | null>,
): readonly PlanningArea[] {
  const [areas, setAreas] = useState<readonly PlanningArea[]>([]);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const found: PlanningArea[] = [];
      for (const track of tracks) {
        if (!track.visible) continue;
        const data = track.area ? null : await getTrackData(track.id);
        const area = planningArea(track, data);
        if (area) found.push(area);
      }
      if (!cancelled) setAreas(found);
    })();
    return () => {
      cancelled = true;
    };
  }, [tracks, getTrackData]);
  return areas;
}
