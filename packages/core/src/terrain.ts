/**
 * Local slope and downhill aspect from a ring of elevation samples.
 *
 * The hunting conditions model has always been able to read terrain thermals —
 * cold air draining downhill at first and last light, warm air lifting under a
 * midday sun — and under the light winds that define those two hours the slope
 * flow *is* the wind. It just never had a slope to read: the only production
 * path into `assessHuntStand` dropped the field.
 *
 * A saved stand is a point, and the surface that planned it is re-derived, so
 * the cheap way to answer "which way does the ground here fall?" is to ask the
 * elevation service for a ring around the point and fit a plane to it. That is
 * what this does — no raster, no new upstream, and it works for stands saved
 * before any of this existed.
 *
 * Deliberately a *plane* fit rather than a steepest-neighbour rule: a single
 * pair of samples on a noisy national elevation model turns a flat field into a
 * 4° hillside, and the whole point of the thermal factor is that it only speaks
 * on ground steep enough to organise a flow.
 */

/** Ground fall at a point, as the hunt conditions model wants it. */
export interface TerrainSlope {
  /** Steepness in degrees, 0 on level ground. */
  readonly slopeDeg: number;
  /**
   * Bearing the ground falls toward, degrees clockwise from north — the way
   * cold air drains and therefore the way your scent goes in a calm dawn.
   * Null when the fit is too flat for a direction to mean anything.
   */
  readonly aspectDeg: number | null;
}

/**
 * Below this the fitted gradient is indistinguishable from sampling noise on a
 * national elevation model, and a downhill bearing would be invented.
 */
const FLAT_DEG = 0.5;

/**
 * Fit slope/aspect to elevations sampled on a circle of `radiusM` around a
 * point, `bearings` being where each sample was taken (degrees from north).
 *
 * Samples whose elevation is missing are skipped — off-coverage points are an
 * ordinary answer from Høydedata — and fewer than four usable ones is reported
 * as no slope rather than as a fit through a gap.
 */
export function slopeFromRing(
  samples: readonly { bearingDeg: number; elevationM: number | null }[],
  radiusM: number,
): TerrainSlope | null {
  const usable = samples.filter(
    (sample): sample is { bearingDeg: number; elevationM: number } =>
      typeof sample.elevationM === 'number' && Number.isFinite(sample.elevationM),
  );
  if (usable.length < 4 || !(radiusM > 0)) return null;

  const points = usable.map((sample) => {
    const radians = (sample.bearingDeg * Math.PI) / 180;
    return {
      east: Math.sin(radians) * radiusM,
      north: Math.cos(radians) * radiusM,
      z: sample.elevationM,
    };
  });
  // Least squares over z = c + a·east + b·north, with the intercept eliminated
  // by centring on the *samples' own* centroid rather than on the ring's. The
  // two coincide only while the ring is whole, and a half-covered ring is the
  // ordinary case at a coastline or a model edge.
  const mean = (pick: (p: (typeof points)[number]) => number): number =>
    points.reduce((sum, point) => sum + pick(point), 0) / points.length;
  const meanEast = mean((p) => p.east);
  const meanNorth = mean((p) => p.north);
  const meanZ = mean((p) => p.z);
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  let sxz = 0;
  let syz = 0;
  for (const point of points) {
    const dx = point.east - meanEast;
    const dy = point.north - meanNorth;
    const dz = point.z - meanZ;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
    sxz += dx * dz;
    syz += dy * dz;
  }
  const determinant = sxx * syy - sxy * sxy;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-9) return null;
  const gradientEast = (sxz * syy - syz * sxy) / determinant;
  const gradientNorth = (syz * sxx - sxz * sxy) / determinant;

  const slopeDeg = (Math.atan(Math.hypot(gradientEast, gradientNorth)) * 180) / Math.PI;
  if (slopeDeg < FLAT_DEG) return { slopeDeg: Math.round(slopeDeg * 10) / 10, aspectDeg: null };
  // Steepest *descent*: the gradient points uphill, so negate both components.
  const aspect = (Math.atan2(-gradientEast, -gradientNorth) * 180) / Math.PI;
  return {
    slopeDeg: Math.round(slopeDeg * 10) / 10,
    aspectDeg: Math.round(((aspect % 360) + 360) % 360),
  };
}
