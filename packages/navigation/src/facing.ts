/**
 * Which way the *traveller* faces — as opposed to `NavState.courseDeg`, which
 * is where the *route* goes. For a car the two agree by construction; a
 * pedestrian stands still at a junction and turns on the spot, where the route
 * tangent keeps pointing down a path they have not chosen. The fix (the
 * Google Maps / OsmAnd answer) is to take orientation from the device compass
 * while walking and hand back to the movement-derived course above a
 * walking-speed threshold, where GPS course is both accurate and immune to
 * magnetic interference.
 */

export interface FacingSample {
  /** Compass heading in degrees (0 = true north, clockwise). */
  deg: number;
  /**
   * Sensor-declared accuracy (± degrees), or null when the platform reports
   * none (web). UIs widen the uncertainty cone with it.
   */
  accuracyDeg: number | null;
}

export interface FacingBlendOptions {
  /** Below this ground speed (m/s) the compass owns the puck. */
  compassMaxSpeedMps: number;
  /** Above this speed GPS course takes over (the gap between is hysteresis). */
  courseMinSpeedMps: number;
  /**
   * Accuracy (± deg) beyond which the compass is not worth drawing at all —
   * the Google behaviour is to degrade to a plain dot and ask for a figure-8
   * calibration rather than point a confident arrow somewhere wrong.
   */
  maxAccuracyDeg: number;
  /** Compass readings older than this (ms) are stale and dropped. */
  maxSampleAgeMs: number;
}

export const DEFAULT_FACING_BLEND: FacingBlendOptions = {
  // Roughly the walking/jogging boundary, with hysteresis so a brisk walker
  // hovering at the threshold doesn't get a puck that flickers between
  // sources: compass releases at 2 m/s, and only re-arms back below 1.5.
  compassMaxSpeedMps: 1.5,
  courseMinSpeedMps: 2,
  maxAccuracyDeg: 60,
  maxSampleAgeMs: 5000,
};

/**
 * Decides, fix by fix, whether the compass heading should drive the puck.
 * Pure and platform-neutral: the platform feeds compass samples and ground
 * speed in, and reads back either a facing (compass regime) or null (use the
 * route course / GPS course as before). Speed hysteresis keeps the source
 * from flapping at the boundary.
 */
export class FacingBlender {
  private readonly opts: FacingBlendOptions;
  private sample: FacingSample | null = null;
  private sampleAtMs = 0;
  /** True while speed says "walking" — the compass regime, with hysteresis. */
  private compassRegime = true;

  constructor(options: Partial<FacingBlendOptions> = {}) {
    this.opts = { ...DEFAULT_FACING_BLEND, ...options };
  }

  /** Forget everything — a new trip, or the watch being torn down. */
  reset(): void {
    this.sample = null;
    this.sampleAtMs = 0;
    this.compassRegime = true;
  }

  /** Feed one compass reading (already true-north referenced). */
  updateCompass(deg: number, accuracyDeg: number | null, nowMs: number): void {
    if (!Number.isFinite(deg)) return;
    this.sample = { deg: ((deg % 360) + 360) % 360, accuracyDeg };
    this.sampleAtMs = nowMs;
  }

  /**
   * The facing the puck should show, given the latest ground speed — or null
   * when movement owns the heading (or no usable compass reading exists), in
   * which case the caller falls back to the course exactly as before.
   */
  current(speedMps: number | null, nowMs: number): FacingSample | null {
    const speed = speedMps ?? 0;
    if (this.compassRegime) {
      if (speed >= this.opts.courseMinSpeedMps) this.compassRegime = false;
    } else if (speed <= this.opts.compassMaxSpeedMps) {
      this.compassRegime = true;
    }
    if (!this.compassRegime) return null;
    const sample = this.sample;
    if (!sample) return null;
    if (nowMs - this.sampleAtMs > this.opts.maxSampleAgeMs) return null;
    if (sample.accuracyDeg !== null && sample.accuracyDeg > this.opts.maxAccuracyDeg) return null;
    return sample;
  }
}
