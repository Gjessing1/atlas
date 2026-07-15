import { haversineM } from '@atlas/core';
import type { TrackData, TrackStats } from './model.js';

/**
 * Elevation changes smaller than this are treated as GPS noise and not
 * accumulated into ascent/descent (simple hysteresis filter).
 */
const ELEVATION_HYSTERESIS_M = 2;

/** Compute summary statistics over all segments of a track. */
export function computeTrackStats(data: TrackData): TrackStats {
  let points = 0;
  let distanceM = 0;
  let ascentM = 0;
  let descentM = 0;
  let minEleM: number | undefined;
  let maxEleM: number | undefined;
  let startTime: number | undefined;
  let endTime: number | undefined;

  for (const segment of data.segments) {
    let anchorEle: number | undefined;
    for (let i = 0; i < segment.length; i++) {
      const p = segment[i]!;
      points++;
      if (i > 0) distanceM += haversineM(segment[i - 1]!, p);

      if (p.ele !== undefined) {
        if (minEleM === undefined || p.ele < minEleM) minEleM = p.ele;
        if (maxEleM === undefined || p.ele > maxEleM) maxEleM = p.ele;
        if (anchorEle === undefined) {
          anchorEle = p.ele;
        } else {
          const delta = p.ele - anchorEle;
          if (Math.abs(delta) >= ELEVATION_HYSTERESIS_M) {
            if (delta > 0) ascentM += delta;
            else descentM -= delta;
            anchorEle = p.ele;
          }
        }
      }

      if (p.time !== undefined) {
        if (startTime === undefined || p.time < startTime) startTime = p.time;
        if (endTime === undefined || p.time > endTime) endTime = p.time;
      }
    }
  }

  const stats: TrackStats = { points, distanceM, ascentM, descentM };
  if (minEleM !== undefined) stats.minEleM = minEleM;
  if (maxEleM !== undefined) stats.maxEleM = maxEleM;
  if (startTime !== undefined && endTime !== undefined) {
    stats.startTime = startTime;
    stats.endTime = endTime;
    stats.durationMs = endTime - startTime;
  }
  return stats;
}
