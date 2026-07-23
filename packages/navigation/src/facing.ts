/**
 * Which way the *traveller* faces — as opposed to `NavState.courseDeg`, which
 * is where the *route* goes. For a car the two agree by construction; a
 * pedestrian stands still at a junction and turns on the spot, where the route
 * tangent keeps pointing down a path they have not chosen. The fix (the
 * Google Maps / OsmAnd answer) is to take orientation from the device compass
 * while standing still and lean back onto the movement-derived course as the
 * traveller picks up walking pace, where the direction of travel is both
 * accurate and immune to magnetic interference.
 *
 * Rather than a hard switch between the two — which made a strolling walker's
 * puck point wherever the noisy magnetometer momentarily read — the blender
 * *crossfades* by speed: pure compass at a standstill, an ever-larger share of
 * the stable route course as they get moving, pure course at a brisk walk. The
 * compass itself is low-pass filtered so the standstill puck no longer jitters.
 */

export interface FacingSample {
  /** Heading in degrees (0 = true north, clockwise). */
  deg: number;
  /**
   * Sensor-declared accuracy (± degrees), or null when the platform reports
   * none (web). UIs may widen an uncertainty indicator with it.
   */
  accuracyDeg: number | null;
}

export interface FacingBlendOptions {
  /** At or below this ground speed (m/s) the puck is pure compass. */
  compassOnlySpeedMps: number;
  /** At or above this ground speed the puck is pure (route) course. */
  courseOnlySpeedMps: number;
  /**
   * Accuracy (± deg) beyond which the compass is not worth drawing at all —
   * the Google behaviour is to degrade to a plain dot and ask for a figure-8
   * calibration rather than point a confident arrow somewhere wrong.
   */
  maxAccuracyDeg: number;
  /** Compass readings older than this (ms) are stale and dropped. */
  maxSampleAgeMs: number;
  /**
   * Base weight (0..1) of each new compass reading in the low-pass filter that
   * kills magnetometer jitter. The weight is raised adaptively toward 1 as a
   * reading diverges further from the smoothed value, so a genuine turn is
   * still tracked promptly while small jitter is heavily damped.
   */
  smoothingAlpha: number;
}

export const DEFAULT_FACING_BLEND: FacingBlendOptions = {
  // Below ~0.4 m/s the traveller is effectively standing and course-over-ground
  // is meaningless, so the compass owns the puck; by ~1.6 m/s (a steady walk)
  // the direction of travel is the honest, jitter-free heading and takes over
  // entirely. The gap between is the crossfade.
  compassOnlySpeedMps: 0.4,
  courseOnlySpeedMps: 1.6,
  maxAccuracyDeg: 60,
  maxSampleAgeMs: 5000,
  smoothingAlpha: 0.3,
};

/** Shortest signed difference b−a, in (−180, 180]. */
function angleDeltaDeg(a: number, b: number): number {
  return ((((b - a) % 360) + 540) % 360) - 180;
}

/** Interpolate from `a` toward `b` by weight `w` (0..1) around the circle. */
function blendAngleDeg(a: number, b: number, w: number): number {
  return (((a + angleDeltaDeg(a, b) * w) % 360) + 360) % 360;
}

/**
 * Decides, fix by fix, which way the walking puck points: a speed-weighted
 * blend of the low-pass-filtered device compass and the stable route course.
 * Pure and platform-neutral — the platform feeds compass samples, the current
 * route course and the ground speed in, and reads back the heading to draw (or
 * null when there is no usable compass reading, in which case the caller falls
 * back to the route/GPS course exactly as before).
 */
export class FacingBlender {
  private readonly opts: FacingBlendOptions;
  private sample: FacingSample | null = null;
  private sampleAtMs = 0;

  constructor(options: Partial<FacingBlendOptions> = {}) {
    this.opts = { ...DEFAULT_FACING_BLEND, ...options };
  }

  /** Forget everything — a new trip, or the watch being torn down. */
  reset(): void {
    this.sample = null;
    this.sampleAtMs = 0;
  }

  /** Feed one compass reading (already true-north referenced). */
  updateCompass(deg: number, accuracyDeg: number | null, nowMs: number): void {
    if (!Number.isFinite(deg)) return;
    const wrapped = ((deg % 360) + 360) % 360;
    const prev = this.sample;
    const stale = prev === null || nowMs - this.sampleAtMs > this.opts.maxSampleAgeMs;
    let smoothed: number;
    if (stale) {
      // No trustworthy history to filter against — take the reading as-is.
      smoothed = wrapped;
    } else {
      // Low-pass the heading: small jitter is damped by `smoothingAlpha`, while
      // a large swing (a real turn) raises the weight toward 1 so the puck
      // still tracks it within a couple of samples rather than crawling.
      const delta = angleDeltaDeg(prev.deg, wrapped);
      const alpha = Math.min(1, this.opts.smoothingAlpha + Math.abs(delta) / 180);
      smoothed = blendAngleDeg(prev.deg, wrapped, alpha);
    }
    this.sample = { deg: smoothed, accuracyDeg };
    this.sampleAtMs = nowMs;
  }

  /**
   * The facing the puck should show, given the latest ground speed and route
   * course — or null when the compass no longer meaningfully contributes, in
   * which case the caller falls back to the course exactly as before. That
   * covers both no usable reading *and* full course weight (a brisk walk):
   * returning the course itself here would only duplicate what the caller
   * already draws when facing is null. `courseDeg` may be null (degenerate
   * route / no course yet); then the compass owns the puck whatever the speed.
   */
  current(speedMps: number | null, courseDeg: number | null, nowMs: number): FacingSample | null {
    const sample = this.sample;
    if (!sample) return null;
    if (nowMs - this.sampleAtMs > this.opts.maxSampleAgeMs) return null;
    if (sample.accuracyDeg !== null && sample.accuracyDeg > this.opts.maxAccuracyDeg) return null;
    if (courseDeg === null) return sample;
    const w = this.courseWeight(speedMps);
    if (w <= 0) return sample;
    if (w >= 1) return null;
    return { deg: blendAngleDeg(sample.deg, courseDeg, w), accuracyDeg: sample.accuracyDeg };
  }

  /** Share of the (stable) route course in the blend, ramped by ground speed. */
  private courseWeight(speedMps: number | null): number {
    const speed = speedMps ?? 0;
    const { compassOnlySpeedMps: lo, courseOnlySpeedMps: hi } = this.opts;
    if (speed <= lo) return 0;
    if (speed >= hi) return 1;
    return (speed - lo) / (hi - lo);
  }
}
