import type { BBox } from '@atlas/core';

/** A single point of a recorded or planned track. */
export interface TrackPoint {
  lat: number;
  lng: number;
  /** Elevation in meters above sea level. */
  ele?: number;
  /** Timestamp in epoch milliseconds. */
  time?: number;
}

/** A standalone named point (GPX `<wpt>`, KML Point placemark). */
export interface Waypoint {
  lat: number;
  lng: number;
  ele?: number;
  name?: string;
}

/** Parsed contents of a track file, normalized across GPX/KML/KMZ. */
export interface TrackData {
  name?: string;
  description?: string;
  /** Track segments; routes (`<rte>`) are normalized into segments too. */
  segments: TrackPoint[][];
  waypoints: Waypoint[];
}

/** Summary statistics for a track, cheap to store alongside it. */
export interface TrackStats {
  /** Total number of track points. */
  points: number;
  distanceM: number;
  ascentM: number;
  descentM: number;
  minEleM?: number;
  maxEleM?: number;
  /** Epoch ms of the first/last timestamped points, when the file has times. */
  startTime?: number;
  endTime?: number;
  durationMs?: number;
}

/** Smallest bounding box containing every point of the track, or null when empty. */
export function trackBounds(data: TrackData): BBox | null {
  let minLat = Infinity;
  let minLng = Infinity;
  let maxLat = -Infinity;
  let maxLng = -Infinity;
  const extend = (p: { lat: number; lng: number }) => {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lng < minLng) minLng = p.lng;
    if (p.lng > maxLng) maxLng = p.lng;
  };
  for (const segment of data.segments) for (const p of segment) extend(p);
  for (const w of data.waypoints) extend(w);
  if (!Number.isFinite(minLat)) return null;
  return { sw: { lat: minLat, lng: minLng }, ne: { lat: maxLat, lng: maxLng } };
}
