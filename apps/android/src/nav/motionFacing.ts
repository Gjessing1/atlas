/** Normalize a compass bearing into [0, 360). */
const normalizeDeg = (deg: number): number => ((deg % 360) + 360) % 360;

/**
 * Convert Expo DeviceMotion's Android rotation-vector azimuth into a compass
 * bearing. Expo exposes `alpha` in radians with the opposite sign to Android's
 * clockwise azimuth; the optional declination learned from expo-location moves
 * magnetic north onto true north.
 */
export function motionFacingDeg(alphaRad: number, declinationDeg = 0): number | null {
  if (!Number.isFinite(alphaRad) || !Number.isFinite(declinationDeg)) return null;
  return normalizeDeg((-alphaRad * 180) / Math.PI + declinationDeg);
}

/** Signed shortest correction from magnetic north to true north. */
export function magneticDeclinationDeg(magneticDeg: number, trueDeg: number): number | null {
  if (!Number.isFinite(magneticDeg) || !Number.isFinite(trueDeg) || trueDeg < 0) return null;
  return ((((trueDeg - magneticDeg) % 360) + 540) % 360) - 180;
}
