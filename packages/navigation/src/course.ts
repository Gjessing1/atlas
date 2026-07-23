/** Signed shortest angle from one bearing to another, in (-180, 180]. */
function wrapDeg(d: number): number {
  return ((((d + 180) % 360) + 360) % 360) - 180;
}

export interface CourseFusionOptions {
  /**
   * Yaw faster than this is not a vehicle turning — it is the phone being
   * picked up, handed over, or knocked off the cradle. Such samples are
   * dropped rather than clamped: half of a bogus turn is still bogus.
   */
  maxYawRateDegPerSec: number;
  /**
   * How much of the gap to the route's own course is closed at each fix.
   * Low enough that a fix never snaps the map round, high enough that gyro
   * drift (and any missed yaw) is gone within a few seconds.
   */
  correctionGain: number;
  /**
   * Past this much disagreement the gyro is simply wrong — a phone that was
   * handled, or a drift that ran away — and the route's course is taken whole.
   */
  resyncDeg: number;
  /**
   * Below this speed the gyro is not measuring the vehicle: a stationary car
   * with a phone being picked up yaws wildly, and a crawling one turns so
   * slowly that the route course is the better answer anyway.
   */
  minSpeedMps: number;
}

export const DEFAULT_COURSE_FUSION: CourseFusionOptions = {
  maxYawRateDegPerSec: 90,
  correctionGain: 0.3,
  resyncDeg: 40,
  minSpeedMps: 1.5,
};

/**
 * The heading to point a course-up map at, fused from the two signals that
 * each know half of the answer.
 *
 * The route course (`NavState.courseDeg`) is absolute and drift-free but
 * arrives once a second and describes where the *line* goes, not what the
 * vehicle is doing between fixes. The gyro (see `headingRateDegPerSec`)
 * measures the turn as it happens, at sensor rate, but knows no absolute
 * direction and drifts. So: integrate yaw for the timing, and pull steadily
 * back towards the route course for the truth — a complementary filter.
 *
 * What this buys over the route course alone is *when* the map turns. A
 * bearing read off the route line turns when the polyline turns, which is
 * where the road bends, not where the car is; the driver sees the map swing
 * before or after the steering wheel moves. Fused, the rotation starts on the
 * first degree of real yaw and ends when the car straightens.
 *
 * Deliberately not in the mix: the magnetometer. Indoors it is unreliable, in
 * a car it is worse (steel body, speakers, the cradle magnet itself), and its
 * one advantage — an absolute reference while stationary — is exactly what
 * the route already provides.
 */
export class CourseFuser {
  private readonly opts: CourseFusionOptions;
  private heading: number | null = null;

  constructor(options: Partial<CourseFusionOptions> = {}) {
    this.opts = { ...DEFAULT_COURSE_FUSION, ...options };
  }

  /** The fused heading, or null until the first course reference arrives. */
  get bearingDeg(): number | null {
    return this.heading;
  }

  /** Forget everything — a new trip, or a camera that stopped following. */
  reset(): void {
    this.heading = null;
  }

  /**
   * Fold in the trip's own course, once per fix. `null` (no route course,
   * e.g. off the line and standing still) leaves the last heading alone
   * rather than dropping the map back to north.
   */
  syncTo(referenceDeg: number | null, speedMps: number | null): number | null {
    if (referenceDeg === null || !Number.isFinite(referenceDeg)) return this.heading;
    if (this.heading === null) {
      this.heading = ((referenceDeg % 360) + 360) % 360;
      return this.heading;
    }
    const error = wrapDeg(referenceDeg - this.heading);
    const slow = speedMps !== null && speedMps < this.opts.minSpeedMps;
    // Standing still there is no yaw worth keeping, and past the resync
    // threshold the integrated heading has lost the plot: take the route's.
    const gain = slow || Math.abs(error) > this.opts.resyncDeg ? 1 : this.opts.correctionGain;
    this.heading = norm(this.heading + error * gain);
    return this.heading;
  }

  /**
   * Fold in one gyro sample: `deltaDeg` is the compass-heading change over
   * `dtSec` (clockwise positive). Ignored before the first `syncTo`, while
   * the vehicle is too slow to be steering, and for implausible rates.
   * Returns the heading afterwards so a caller can compare it with what the
   * camera is currently showing.
   */
  applyYaw(deltaDeg: number, dtSec: number, speedMps: number | null): number | null {
    if (this.heading === null || !Number.isFinite(deltaDeg) || dtSec <= 0) return this.heading;
    if (speedMps !== null && speedMps < this.opts.minSpeedMps) return this.heading;
    if (Math.abs(deltaDeg / dtSec) > this.opts.maxYawRateDegPerSec) return this.heading;
    this.heading = norm(this.heading + deltaDeg);
    return this.heading;
  }
}

function norm(deg: number): number {
  return ((deg % 360) + 360) % 360;
}
