import { haversineM } from '@atlas/core';
import type { TrackData, TrackPoint, TrackStats } from './model.js';

/**
 * A location fix fed into a {@link TrackRecorder}. Mirrors what a device GPS
 * exposes; `time` is epoch milliseconds so the recorder never reads a clock
 * itself (keeping it deterministic and platform-neutral).
 */
export interface RecordFix {
  lat: number;
  lng: number;
  /** Elevation in meters above sea level, when the fix carries one. */
  ele?: number;
  /** Fix timestamp in epoch milliseconds. */
  time: number;
  /** Horizontal accuracy in meters, when the device reports it. */
  accuracyM?: number;
}

export type RecorderStatus = 'idle' | 'recording' | 'paused' | 'stopped';

export interface RecorderOptions {
  /** Reject fixes whose reported accuracy is worse than this (m). Default 50. */
  maxAccuracyM?: number;
  /**
   * Ignore fixes closer than this to the last accepted point (m) — suppresses
   * the drift a stationary GPS accumulates. Default 3.
   */
  minDistanceM?: number;
  /**
   * A fix pair below this ground speed (m/s) counts as stationary and its time
   * is excluded from moving time. Default 0.5 (~1.8 km/h).
   */
  movingSpeedThresholdMps?: number;
}

/** Live statistics for an in-progress or finished recording. */
export interface RecorderStats extends TrackStats {
  /** Wall-clock ms from the first to the last recorded point (includes pauses). */
  elapsedMs: number;
  /** Ms during which the traveller was actually moving. */
  movingMs: number;
  /** distance / moving time (m/s); 0 until moving. */
  movingSpeedMps: number;
  /** distance / elapsed time (m/s); 0 until two timed points exist. */
  avgSpeedMps: number;
}

/** An immutable view of the recorder for a UI to render. */
export interface RecorderSnapshot {
  status: RecorderStatus;
  stats: RecorderStats;
  /** The most recently accepted fix, for a live position marker. */
  lastFix: RecordFix | null;
  /** Total accepted points across all segments. */
  points: number;
}

/**
 * Elevation changes smaller than this are treated as GPS noise, matching the
 * hysteresis {@link computeTrackStats} applies to imported tracks so a recorded
 * track's stats read the same as the same track re-imported.
 */
const ELEVATION_HYSTERESIS_M = 2;

const emptyStats = (): RecorderStats => ({
  points: 0,
  distanceM: 0,
  ascentM: 0,
  descentM: 0,
  elapsedMs: 0,
  movingMs: 0,
  movingSpeedMps: 0,
  avgSpeedMps: 0,
});

/**
 * Accumulates device GPS fixes into a GPX track with live statistics — the
 * platform-neutral core of "record my trip". A pause closes the current
 * segment; resuming opens a new one, so the exported GPX keeps recording gaps
 * as separate `<trkseg>`s (never drawing a straight line across a pause).
 *
 * Deterministic: it reads time only from the fixes it is given, so it is fully
 * unit-testable and reusable on any platform. Stats are maintained incrementally
 * (O(1) per fix); the `TrackStats` subset is kept identical to what
 * {@link computeTrackStats} would return for the same points.
 */
export class TrackRecorder {
  private readonly maxAccuracyM: number;
  private readonly minDistanceM: number;
  private readonly movingSpeedThresholdMps: number;

  private status: RecorderStatus = 'idle';
  private segments: TrackPoint[][] = [];
  private current: TrackPoint[] | null = null;

  private prev: TrackPoint | null = null;
  private anchorEle: number | undefined;

  private pointCount = 0;
  private distanceM = 0;
  private ascentM = 0;
  private descentM = 0;
  private minEleM: number | undefined;
  private maxEleM: number | undefined;
  private startTime: number | undefined;
  private endTime: number | undefined;
  private movingMs = 0;
  private lastFix: RecordFix | null = null;

  constructor(options: RecorderOptions = {}) {
    this.maxAccuracyM = options.maxAccuracyM ?? 50;
    this.minDistanceM = options.minDistanceM ?? 3;
    this.movingSpeedThresholdMps = options.movingSpeedThresholdMps ?? 0.5;
  }

  /** Begin (or restart) a recording, opening the first segment. */
  start(): void {
    this.status = 'recording';
    this.segments = [];
    this.current = [];
    this.segments.push(this.current);
    this.prev = null;
    this.anchorEle = undefined;
    this.pointCount = 0;
    this.distanceM = 0;
    this.ascentM = 0;
    this.descentM = 0;
    this.minEleM = undefined;
    this.maxEleM = undefined;
    this.startTime = undefined;
    this.endTime = undefined;
    this.movingMs = 0;
    this.lastFix = null;
  }

  /** Suspend recording; the current segment is closed. No-op unless recording. */
  pause(): void {
    if (this.status !== 'recording') return;
    this.status = 'paused';
    this.closeSegment();
  }

  /** Resume after a pause, opening a fresh segment. No-op unless paused. */
  resume(): void {
    if (this.status !== 'paused') return;
    this.status = 'recording';
    this.current = [];
    this.segments.push(this.current);
    this.prev = null;
    this.anchorEle = undefined;
  }

  /** End the recording. The accumulated track stays available via {@link toTrackData}. */
  stop(): void {
    this.status = 'stopped';
    this.closeSegment();
  }

  private closeSegment(): void {
    this.current = null;
    this.prev = null;
    this.anchorEle = undefined;
  }

  /**
   * Offer a fix to the recording. Returns whether it was appended — a fix is
   * dropped when the recorder isn't recording, when its accuracy is too poor,
   * or when it is within `minDistanceM` of the last point (jitter suppression;
   * the very first point of a segment is always kept).
   */
  addFix(fix: RecordFix): boolean {
    if (this.status !== 'recording' || !this.current) return false;
    if (fix.accuracyM !== undefined && fix.accuracyM > this.maxAccuracyM) return false;

    const point: TrackPoint = { lat: fix.lat, lng: fix.lng };
    if (fix.ele !== undefined) point.ele = fix.ele;
    point.time = fix.time;

    if (this.prev) {
      const d = haversineM(this.prev, point);
      if (d < this.minDistanceM) return false;
      this.distanceM += d;
      const prevTime = this.prev.time;
      if (prevTime !== undefined) {
        const dt = fix.time - prevTime;
        if (dt > 0 && d / (dt / 1000) >= this.movingSpeedThresholdMps) this.movingMs += dt;
      }
    }

    this.current.push(point);
    this.prev = point;
    this.pointCount++;
    this.lastFix = fix;

    if (fix.ele !== undefined) {
      if (this.minEleM === undefined || fix.ele < this.minEleM) this.minEleM = fix.ele;
      if (this.maxEleM === undefined || fix.ele > this.maxEleM) this.maxEleM = fix.ele;
      if (this.anchorEle === undefined) {
        this.anchorEle = fix.ele;
      } else {
        const delta = fix.ele - this.anchorEle;
        if (Math.abs(delta) >= ELEVATION_HYSTERESIS_M) {
          if (delta > 0) this.ascentM += delta;
          else this.descentM -= delta;
          this.anchorEle = fix.ele;
        }
      }
    }

    if (this.startTime === undefined || fix.time < this.startTime) this.startTime = fix.time;
    if (this.endTime === undefined || fix.time > this.endTime) this.endTime = fix.time;

    return true;
  }

  getStatus(): RecorderStatus {
    return this.status;
  }

  /** Current live statistics. */
  stats(): RecorderStats {
    if (this.pointCount === 0) return emptyStats();
    const elapsedMs =
      this.startTime !== undefined && this.endTime !== undefined
        ? this.endTime - this.startTime
        : 0;
    const stats: RecorderStats = {
      points: this.pointCount,
      distanceM: this.distanceM,
      ascentM: this.ascentM,
      descentM: this.descentM,
      elapsedMs,
      movingMs: this.movingMs,
      movingSpeedMps: this.movingMs > 0 ? this.distanceM / (this.movingMs / 1000) : 0,
      avgSpeedMps: elapsedMs > 0 ? this.distanceM / (elapsedMs / 1000) : 0,
    };
    if (this.minEleM !== undefined) stats.minEleM = this.minEleM;
    if (this.maxEleM !== undefined) stats.maxEleM = this.maxEleM;
    if (this.startTime !== undefined && this.endTime !== undefined) {
      stats.startTime = this.startTime;
      stats.endTime = this.endTime;
      stats.durationMs = elapsedMs;
    }
    return stats;
  }

  /** An immutable snapshot for rendering. */
  snapshot(): RecorderSnapshot {
    return {
      status: this.status,
      stats: this.stats(),
      lastFix: this.lastFix,
      points: this.pointCount,
    };
  }

  /**
   * The recorded track as {@link TrackData}, ready for {@link buildGpx} or
   * storage. Empty segments (e.g. a pause with no fix before stop) are dropped.
   */
  toTrackData(meta: { name?: string; description?: string } = {}): TrackData {
    const data: TrackData = {
      segments: this.segments.filter((s) => s.length > 0).map((s) => s.slice()),
      waypoints: [],
    };
    if (meta.name !== undefined) data.name = meta.name;
    if (meta.description !== undefined) data.description = meta.description;
    return data;
  }
}
