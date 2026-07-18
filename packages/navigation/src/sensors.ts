/** A vector in device coordinates (x right, y toward the top edge, z out of the screen). */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * Rate of change of the compass heading (deg/s, clockwise-positive) from raw
 * motion sensors: the device rotation rate (deg/s, right-hand rule about each
 * device axis — DeviceMotion's beta/gamma/alpha as x/y/z) projected onto the
 * world vertical, taken from the gravity-including acceleration vector. The
 * projection makes the result mount-agnostic — flat on a seat, portrait in a
 * windshield cradle, anything in between. Compass bearings grow clockwise
 * seen from above while a right-hand rotation about "up" is counterclockwise,
 * hence the sign flip. Returns null when the accelerometer reading is far
 * from 1 g (hard braking, pothole) and the vertical is momentarily unknown.
 */
export function headingRateDegPerSec(rotationRateDeg: Vec3, gravity: Vec3): number | null {
  const g = Math.hypot(gravity.x, gravity.y, gravity.z);
  // Trust the vertical only near 1 g (9.81 ±40 %).
  if (g < 5.9 || g > 13.7) return null;
  const dot =
    rotationRateDeg.x * gravity.x + rotationRateDeg.y * gravity.y + rotationRateDeg.z * gravity.z;
  return -dot / g;
}
