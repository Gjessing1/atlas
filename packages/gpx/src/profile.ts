import { haversineM } from '@atlas/core';
import type { TrackData } from './model.js';

/** One sample of an elevation-vs-distance series (see buildElevationProfile). */
export interface ElevationProfilePoint {
  distM: number;
  ele: number;
  lat: number;
  lng: number;
}

/**
 * Flatten a track's segments into an elevation-vs-distance series for charting
 * (points lacking elevation are skipped; distance accumulates over all points).
 * Series longer than `maxPoints` are downsampled evenly, keeping the last point.
 */
export function buildElevationProfile(data: TrackData, maxPoints = 600): ElevationProfilePoint[] {
  const points: ElevationProfilePoint[] = [];
  let distM = 0;
  for (const segment of data.segments) {
    for (let i = 0; i < segment.length; i++) {
      const p = segment[i]!;
      if (i > 0) distM += haversineM(segment[i - 1]!, p);
      if (p.ele !== undefined) points.push({ distM, ele: p.ele, lat: p.lat, lng: p.lng });
    }
  }
  if (points.length <= maxPoints) return points;
  const step = points.length / maxPoints;
  const sampled: ElevationProfilePoint[] = [];
  for (let i = 0; i < maxPoints; i++) sampled.push(points[Math.floor(i * step)]!);
  sampled.push(points[points.length - 1]!);
  return sampled;
}
