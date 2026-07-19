/**
 * Solar position + sunrise/sunset for a point, computed offline and
 * deterministically — no network, works identically on web and Android. The
 * planner couples the sun's altitude with the forecast (light drives both the
 * fishing-bite and hunting-stand models), and sunrise/sunset anchor the "best
 * windows" display.
 *
 * Algorithm after NOAA's solar equations as distilled by SunCalc (Vladimir
 * Agafonkin, BSD-2). Good to well under a minute / a fraction of a degree.
 */

const RAD = Math.PI / 180;
const DAY_MS = 86400000;
const J1970 = 2440588;
const J2000 = 2451545;
const OBLIQUITY = RAD * 23.4397; // Earth's axial tilt.

/** Sun direction at an instant: azimuth in degrees clockwise from true north, altitude above horizon. */
export interface SunPos {
  /** 0 = north, 90 = east, 180 = south, 270 = west. */
  azimuth: number;
  /** Degrees above the horizon (negative = below). */
  altitude: number;
}

/** Key solar events for a calendar day at a location. Times are null in polar day/night. */
export interface SunDay {
  sunrise: Date | null;
  sunset: Date | null;
  solarNoon: Date;
  /** Sun altitude at solar noon — how high it climbs that day. */
  noonAltitude: number;
}

function toDays(date: Date): number {
  return date.valueOf() / DAY_MS - 0.5 + J1970 - J2000;
}
function fromJulian(j: number): Date {
  return new Date((j + 0.5 - J1970) * DAY_MS);
}

function solarMeanAnomaly(d: number): number {
  return RAD * (357.5291 + 0.98560028 * d);
}
function eclipticLongitude(m: number): number {
  const c = RAD * (1.9148 * Math.sin(m) + 0.02 * Math.sin(2 * m) + 0.0003 * Math.sin(3 * m));
  return m + c + RAD * 102.9372 + Math.PI;
}
function declination(l: number): number {
  // Sun's ecliptic latitude is ~0, so only the obliquity term remains.
  return Math.asin(Math.sin(OBLIQUITY) * Math.sin(l));
}
function rightAscension(l: number): number {
  return Math.atan2(Math.sin(l) * Math.cos(OBLIQUITY), Math.cos(l));
}
function siderealTime(d: number, lw: number): number {
  return RAD * (280.16 + 360.9856235 * d) - lw;
}

/** Sun azimuth (deg clockwise from north) + altitude (deg) at `date` for [lat, lon] in degrees. */
export function sunPosition(date: Date, lat: number, lon: number): SunPos {
  const lw = RAD * -lon;
  const phi = RAD * lat;
  const d = toDays(date);
  const m = solarMeanAnomaly(d);
  const l = eclipticLongitude(m);
  const dec = declination(l);
  const ra = rightAscension(l);
  const h = siderealTime(d, lw) - ra;
  // SunCalc measures azimuth from south, clockwise to west; shift by 180° to read clockwise from north.
  const azSouth = Math.atan2(
    Math.sin(h),
    Math.cos(h) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi),
  );
  const altitude = Math.asin(
    Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(h),
  );
  let azimuth = (azSouth / RAD + 180) % 360;
  if (azimuth < 0) azimuth += 360;
  return { azimuth, altitude: altitude / RAD };
}

// ── Sunrise / sunset / solar noon ────────────────────────────────────────────
const J0 = 0.0009;
function julianCycle(d: number, lw: number): number {
  return Math.round(d - J0 - lw / (2 * Math.PI));
}
function approxTransit(ht: number, lw: number, n: number): number {
  return J0 + (ht + lw) / (2 * Math.PI) + n;
}
function solarTransitJ(ds: number, m: number, l: number): number {
  return J2000 + ds + 0.0053 * Math.sin(m) - 0.0069 * Math.sin(2 * l);
}
function hourAngle(h: number, phi: number, dec: number): number {
  return Math.acos((Math.sin(h) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec)));
}

/** Sunrise, sunset, solar noon (and noon altitude) for the calendar day containing `date`. */
export function sunDay(date: Date, lat: number, lon: number): SunDay {
  const lw = RAD * -lon;
  const phi = RAD * lat;
  const d = toDays(date);
  const n = julianCycle(d, lw);
  const ds = approxTransit(0, lw, n);
  const m = solarMeanAnomaly(ds);
  const l = eclipticLongitude(m);
  const dec = declination(l);
  const jNoon = solarTransitJ(ds, m, l);
  const noon = fromJulian(jNoon);

  // h0 = -0.833° accounts for the sun's radius + atmospheric refraction at the horizon.
  const w = hourAngle(-0.833 * RAD, phi, dec);
  let sunrise: Date | null = null;
  let sunset: Date | null = null;
  if (!Number.isNaN(w)) {
    const jSet = solarTransitJ(approxTransit(w, lw, n), m, l);
    sunset = fromJulian(jSet);
    sunrise = fromJulian(jNoon - (jSet - jNoon));
  }
  const noonAltitude = sunPosition(noon, lat, lon).altitude;
  return { sunrise, sunset, solarNoon: noon, noonAltitude };
}

const POINTS16 = [
  'N',
  'NNE',
  'NE',
  'ENE',
  'E',
  'ESE',
  'SE',
  'SSE',
  'S',
  'SSW',
  'SW',
  'WSW',
  'W',
  'WNW',
  'NW',
  'NNW',
];

/** Nearest 16-point compass label for an azimuth in degrees clockwise from north. */
export function compass16(azimuth: number): string {
  const i = Math.round((((azimuth % 360) + 360) % 360) / 22.5) % 16;
  return POINTS16[i] ?? 'N';
}
