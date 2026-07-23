/** A vector in device coordinates (x right, y toward the top edge, z out of the screen). */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * Rate of change of the compass heading (deg/s, clockwise-positive) from raw
 * motion sensors: the device rotation rate (deg/s, right-hand rule about the
 * device x/y/z axes) projected onto the world vertical, taken from the
 * gravity-including acceleration vector.
 *
 * `gravity` must point **down**, toward the earth — the DeviceMotion
 * convention (at rest, screen up, it reads `z ≈ -9.81`), not the raw Android
 * accelerometer's up-pointing reaction force. A right-hand rotation about
 * "down" is clockwise seen from above, which is also how compass bearings
 * grow, so the projection is taken as-is.
 *
 * The projection makes the result mount-agnostic — flat on a seat, portrait
 * or landscape in a windshield cradle, anything in between: only the device's
 * attitude relative to the world matters, and both input vectors are in the
 * same device frame. Returns null when the accelerometer reading is far from
 * 1 g (hard braking, pothole) and the vertical is momentarily unknown.
 */
export function headingRateDegPerSec(rotationRateDeg: Vec3, gravity: Vec3): number | null {
  const g = Math.hypot(gravity.x, gravity.y, gravity.z);
  // Trust the vertical only near 1 g (9.81 ±40 %).
  if (g < 5.9 || g > 13.7) return null;
  const dot =
    rotationRateDeg.x * gravity.x + rotationRateDeg.y * gravity.y + rotationRateDeg.z * gravity.z;
  return dot / g;
}
