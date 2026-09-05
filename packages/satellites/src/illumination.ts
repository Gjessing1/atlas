/** Sun position and Earth-shadow geometry, kept independent of optional WASM. */

import { constants, sunPos, type EciVec3 } from 'satellite.js';

const SUN_RADIUS_KM = 695_700;
const KM_PER_AU = 149_597_870.69098932;

/** satellite.js 6 exposes the Vallado sun vector as a tuple rather than EciVec3. */
export function sunPosition(julianDay: number): EciVec3<number> {
  const [x = 0, y = 0, z = 0] = sunPos(julianDay).rsun;
  return { x, y, z };
}

const length = (v: EciVec3<number>) => Math.hypot(v.x, v.y, v.z);
const dot = (a: EciVec3<number>, b: EciVec3<number>) => a.x * b.x + a.y * b.y + a.z * b.z;

/**
 * Fraction of the Sun's disc hidden by Earth from a satellite.
 *
 * 0 is fully lit, 1 is umbra, and the circle-overlap result between them is
 * penumbra. This small geometry implementation keeps clients on satellite.js's
 * pure-JS SGP4 build: version 7's package root also exports its optional WASM
 * engines, whose Node imports cannot be bundled by Expo/Metro.
 */
export function shadowFraction(sunEciAu: EciVec3<number>, satelliteEciKm: EciVec3<number>): number {
  const sunKm = {
    x: sunEciAu.x * KM_PER_AU,
    y: sunEciAu.y * KM_PER_AU,
    z: sunEciAu.z * KM_PER_AU,
  };
  const sunDistance = length(sunKm);
  const satelliteDistance = length(satelliteEciKm);
  const antisolar = {
    x: -sunKm.x / sunDistance,
    y: -sunKm.y / sunDistance,
    z: -sunKm.z / sunDistance,
  };
  const behindEarth = dot(satelliteEciKm, antisolar);
  if (behindEarth <= 0) return 0;

  const earthRadius = Math.asin(constants.earthRadius / satelliteDistance);
  const sunRadius = Math.asin(SUN_RADIUS_KM / sunDistance);
  const separation = Math.acos(Math.min(1, Math.max(-1, behindEarth / satelliteDistance)));
  if (separation <= earthRadius - sunRadius) return 1;
  if (separation >= earthRadius + sunRadius) return 0;

  const sunArea =
    sunRadius *
    sunRadius *
    Math.acos(
      (separation * separation + sunRadius * sunRadius - earthRadius * earthRadius) /
        (2 * separation * sunRadius),
    );
  const earthArea =
    earthRadius *
    earthRadius *
    Math.acos(
      (separation * separation + earthRadius * earthRadius - sunRadius * sunRadius) /
        (2 * separation * earthRadius),
    );
  const lens =
    0.5 *
    Math.sqrt(
      (-separation + sunRadius + earthRadius) *
        (separation + sunRadius - earthRadius) *
        (separation - sunRadius + earthRadius) *
        (separation + sunRadius + earthRadius),
    );
  return Math.min(1, Math.max(0, (sunArea + earthArea - lens) / (Math.PI * sunRadius ** 2)));
}
