/** Visible-pass prediction: when an object crosses this sky, lit, after dark. */

import {
  degreesToRadians,
  ecfToLookAngles,
  eciToEcf,
  gstime,
  jday,
  propagate,
  radiansToDegrees,
  type EciVec3,
  type SatRec,
} from 'satellite.js';

import { elementAgeDays, type SatelliteOmm } from './elements.js';
import { shadowFraction, sunPosition } from './illumination.js';
import { horizonHalfAngleDeg, meanAltitudeKm, satrecFor } from './propagate.js';

const AU_KM = 149_597_870.7;

/**
 * How far the sun must be below the observer's horizon for a pass to read as a
 * moving star rather than nothing at all.
 *
 * Civil twilight. It is also the reason a pass list can be *correctly* empty
 * for weeks: north of the Arctic Circle in summer the sun never gets this low,
 * so there are no visible passes to predict — the objects are all still up
 * there, and none of them can be seen. Clients must say that rather than
 * showing a blank list, which would read as a broken feature.
 */
export const TWILIGHT_SUN_ELEVATION_DEG = -6;

/** One pass of one object over one observer. */
export interface SatellitePass {
  noradId: number;
  name: string;
  /** Rise above `minElevationDeg`, peak, and set, ISO 8601. */
  start: string;
  peak: string;
  end: string;
  /** Compass bearings at those three moments, degrees from north. */
  startAzimuth: number;
  peakAzimuth: number;
  endAzimuth: number;
  /** Highest point of the pass, degrees above the horizon. */
  maxElevationDeg: number;
  /** Range at peak, km. */
  peakRangeKm: number;
  durationSeconds: number;
  /** Sunlight reaches the object at peak. */
  sunlit: boolean;
  /** The observer's sky is dark enough at peak (see TWILIGHT_SUN_ELEVATION_DEG). */
  darkSky: boolean;
  /**
   * Estimated apparent magnitude at peak — lower is brighter, and roughly:
   * −4 rivals Venus, 0 is a bright star, 6 is the naked-eye limit.
   * Absent for the great majority: see `STANDARD_MAGNITUDES`.
   */
  magnitude?: number;
  /** Age of the elements this was predicted from, days. */
  ageDays: number;
}

export interface PassSearchOptions {
  /** Start of the search window. Default: now. */
  from?: Date;
  /** Window length. Default 48. */
  hours?: number;
  /** Ignore passes that never get this high. Default 10°. */
  minElevationDeg?: number;
  /** Drop passes that are unlit or in a bright sky. Default true. */
  visibleOnly?: boolean;
  /** Cap the returned list, soonest first. Default 20. */
  limit?: number;
  /** Coarse scan step, seconds. Default 30. */
  stepSeconds?: number;
}

export interface Observer {
  lat: number;
  lng: number;
  /** Metres above sea level. Default 0. */
  altitudeM?: number;
}

/**
 * Standard magnitudes (brightness at 1000 km, half phase) for the handful of
 * objects bright enough that quoting a number is worth anything.
 *
 * Deliberately a curated few, not a catalog. Per-object brightness lives in
 * hand-maintained amateur files that CelesTrak does not publish and nobody
 * guarantees; shipping a stale copy of one would put a confident, wrong
 * magnitude on hundreds of rows. Everything not listed here reports its
 * geometry — how high, how long, which way — and no magnitude, which is the
 * honest answer and still the one that decides whether to walk outside.
 */
const STANDARD_MAGNITUDES = new Map<number, number>([
  [25544, -1.8], // ISS (ZARYA)
  [48274, -0.5], // CSS (TIANHE) — the Chinese station's core module
]);

/** Sun's look angles from the ground, via the same ephemeris used for eclipse. */
function sunElevationDeg(date: Date, observerGeodetic: ReturnType<typeof geodeticOf>): number {
  const sun = sunPosition(jday(date));
  const eci: EciVec3<number> = {
    x: sun.x * AU_KM,
    y: sun.y * AU_KM,
    z: sun.z * AU_KM,
  };
  const look = ecfToLookAngles(observerGeodetic, eciToEcf(eci, gstime(date)));
  return radiansToDegrees(look.elevation);
}

function geodeticOf(observer: Observer) {
  return {
    longitude: degreesToRadians(observer.lng),
    latitude: degreesToRadians(observer.lat),
    height: (observer.altitudeM ?? 0) / 1000,
  };
}

/** Elevation of the object above the observer's horizon, degrees. */
function elevationAt(rec: SatRec, date: Date, observerGeodetic: ReturnType<typeof geodeticOf>) {
  const state = propagate(rec, date);
  if (!state) return null;
  const ecf = eciToEcf(state.position, gstime(date));
  const look = ecfToLookAngles(observerGeodetic, ecf);
  return {
    elevationDeg: radiansToDegrees(look.elevation),
    azimuthDeg: (radiansToDegrees(look.azimuth) + 360) % 360,
    rangeKm: look.rangeSat,
    position: state.position,
  };
}

/**
 * Can this orbit put the object over the observer's horizon *at all*?
 *
 * A satellite never reaches ground latitudes beyond its inclination, so from
 * 60°N a 28°-inclination orbit is below the horizon permanently — no amount of
 * scanning will find a pass. Skipping those up front is what keeps a whole-sky
 * search over a few hundred objects cheap enough to run on demand; without it
 * most of the work goes into objects that were never candidates.
 */
function reachable(omm: SatelliteOmm, observer: Observer): boolean {
  // Its own altitude, not a blanket LEO guess: the margin is 20° for the ISS
  // and 45° at 2000 km, and using the larger everywhere would wave through
  // most of what this is meant to skip. One degree of slack absorbs the
  // difference between mean and osculating elements.
  const reach = omm.INCLINATION + horizonHalfAngleDeg(meanAltitudeKm(omm)) + 1;
  return Math.abs(observer.lat) <= reach;
}

/** Refine a chronological, bracketed horizon crossing to the second. */
function refineCrossing(
  rec: SatRec,
  observerGeodetic: ReturnType<typeof geodeticOf>,
  beforeMs: number,
  afterMs: number,
  thresholdDeg: number,
  rising: boolean,
): number {
  let before = beforeMs;
  let after = afterMs;
  for (let i = 0; i < 12 && after - before > 1000; i++) {
    const mid = (before + after) / 2;
    const sample = elevationAt(rec, new Date(mid), observerGeodetic);
    if (!sample) break;
    const above = sample.elevationDeg >= thresholdDeg;
    // On a rise the later half is above; on a set the earlier half is. Keeping
    // time chronological matters: treating "below" as the low numeric bound
    // made every falling crossing return the 30-second coarse sample.
    if (above === rising) after = mid;
    else before = mid;
  }
  return (before + after) / 2;
}

/**
 * Passes of one object over one observer, soonest first.
 *
 * A coarse scan brackets each horizon crossing and a short bisection sharpens
 * it — full-resolution stepping would spend the entire budget on the ~95% of
 * the window in which the object is nowhere near the sky.
 */
export function predictPasses(
  omm: SatelliteOmm,
  observer: Observer,
  options: PassSearchOptions = {},
): SatellitePass[] {
  const rec = satrecFor(omm);
  if (!rec || !reachable(omm, observer)) return [];

  const from = options.from ?? new Date();
  const hours = options.hours ?? 48;
  const minElevationDeg = options.minElevationDeg ?? 10;
  const visibleOnly = options.visibleOnly ?? true;
  const stepMs = Math.max(5, options.stepSeconds ?? 30) * 1000;
  const observerGeodetic = geodeticOf(observer);
  const endMs = from.getTime() + hours * 3_600_000;

  const passes: SatellitePass[] = [];
  let riseMs: number | null = null;
  let peak: { ms: number; elevationDeg: number; azimuthDeg: number; rangeKm: number } | null = null;
  let previous: { ms: number; elevationDeg: number } | null = null;

  for (let ms = from.getTime(); ms <= endMs; ms += stepMs) {
    const sample = elevationAt(rec, new Date(ms), observerGeodetic);
    if (!sample) break;
    const above = sample.elevationDeg >= minElevationDeg;

    if (above) {
      if (riseMs === null) {
        riseMs = previous
          ? refineCrossing(rec, observerGeodetic, previous.ms, ms, minElevationDeg, true)
          : ms;
        peak = null;
      }
      if (!peak || sample.elevationDeg > peak.elevationDeg) {
        peak = {
          ms,
          elevationDeg: sample.elevationDeg,
          azimuthDeg: sample.azimuthDeg,
          rangeKm: sample.rangeKm,
        };
      }
    } else if (riseMs !== null && peak) {
      const setMs = previous
        ? refineCrossing(rec, observerGeodetic, previous.ms, ms, minElevationDeg, false)
        : ms;
      const pass = describePass(
        omm,
        rec,
        observerGeodetic,
        riseMs,
        peak,
        setMs,
        elevationAt(rec, new Date(riseMs), observerGeodetic)?.azimuthDeg ?? peak.azimuthDeg,
        elevationAt(rec, new Date(setMs), observerGeodetic)?.azimuthDeg ?? peak.azimuthDeg,
      );
      if (pass && (!visibleOnly || (pass.sunlit && pass.darkSky))) passes.push(pass);
      riseMs = null;
      peak = null;
    }
    previous = { ms, elevationDeg: sample.elevationDeg };
  }

  return passes.slice(0, options.limit ?? 20);
}

function describePass(
  omm: SatelliteOmm,
  rec: SatRec,
  observerGeodetic: ReturnType<typeof geodeticOf>,
  riseMs: number,
  peak: { ms: number; elevationDeg: number; azimuthDeg: number; rangeKm: number },
  setMs: number,
  startAzimuth: number,
  endAzimuth: number,
): SatellitePass | null {
  const peakDate = new Date(peak.ms);
  const state = elevationAt(rec, peakDate, observerGeodetic);
  if (!state) return null;
  const sunEci = sunPosition(jday(peakDate));
  const shadow = shadowFraction(sunEci, state.position);
  const sunElevation = sunElevationDeg(peakDate, observerGeodetic);
  return {
    noradId: omm.NORAD_CAT_ID,
    name: omm.OBJECT_NAME,
    start: new Date(riseMs).toISOString(),
    peak: peakDate.toISOString(),
    end: new Date(setMs).toISOString(),
    startAzimuth,
    peakAzimuth: peak.azimuthDeg,
    endAzimuth,
    maxElevationDeg: peak.elevationDeg,
    peakRangeKm: peak.rangeKm,
    durationSeconds: Math.max(0, Math.round((setMs - riseMs) / 1000)),
    sunlit: shadow < 1,
    darkSky: sunElevation < TWILIGHT_SUN_ELEVATION_DEG,
    magnitude: apparentMagnitude(omm, sunEci, state.position, peak.rangeKm),
    ageDays: elementAgeDays(omm, peak.ms),
  };
}

/**
 * Apparent magnitude at peak, for the few objects with a known standard
 * magnitude. The phase term is the standard satellite-observing approximation:
 * an object seen "full" (sun behind the observer) is far brighter than the same
 * object seen as a crescent, which is why a high pass at dusk can outshine an
 * overhead one later.
 */
function apparentMagnitude(
  omm: SatelliteOmm,
  sunEciAu: EciVec3<number>,
  satEciKm: EciVec3<number>,
  rangeKm: number,
): number | undefined {
  const standard = STANDARD_MAGNITUDES.get(omm.NORAD_CAT_ID);
  if (standard === undefined) return undefined;
  const sunKm = { x: sunEciAu.x * AU_KM, y: sunEciAu.y * AU_KM, z: sunEciAu.z * AU_KM };
  // Phase angle at the satellite, between the sun and the observer. The
  // observer sits within a few thousand km of Earth's centre against 150
  // million to the sun, so Earth's centre stands in for it here.
  const toSun = sub(sunKm, satEciKm);
  const toObserver = { x: -satEciKm.x, y: -satEciKm.y, z: -satEciKm.z };
  const cosPhase = dot(toSun, toObserver) / (norm(toSun) * norm(toObserver));
  const phase = Math.acos(Math.max(-1, Math.min(1, cosPhase)));
  const phaseFactor = Math.sin(phase) + (Math.PI - phase) * Math.cos(phase);
  if (phaseFactor <= 0) return undefined;
  return standard - 15.75 + 2.5 * Math.log10((rangeKm * rangeKm) / phaseFactor);
}

const sub = (a: EciVec3<number>, b: EciVec3<number>) => ({
  x: a.x - b.x,
  y: a.y - b.y,
  z: a.z - b.z,
});
const dot = (a: EciVec3<number>, b: EciVec3<number>) => a.x * b.x + a.y * b.y + a.z * b.z;
const norm = (a: EciVec3<number>) => Math.sqrt(dot(a, a));

/**
 * Passes of every object in a set, merged and sorted by time.
 *
 * The per-object limit is applied first so one prolific low-orbit object cannot
 * crowd every other out of the merged list.
 */
export function predictPassesForSet(
  elements: readonly SatelliteOmm[],
  observer: Observer,
  options: PassSearchOptions = {},
): SatellitePass[] {
  const perObject = { ...options, limit: options.limit ?? 20 };
  const all: SatellitePass[] = [];
  for (const omm of elements) all.push(...predictPasses(omm, observer, perObject));
  all.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  return all.slice(0, options.limit ?? 20);
}

/**
 * The sun's elevation from an observer's horizon, degrees.
 *
 * Exported because "no visible passes" has two completely different meanings
 * and a UI that cannot tell them apart is lying by omission: either nothing
 * happened to fly over, or the sky where you are standing never got dark. North
 * of the Arctic Circle in summer it is always the second, for months.
 */
export function observerSunElevationDeg(date: Date, observer: Observer): number {
  return sunElevationDeg(date, geodeticOf(observer));
}

/**
 * Does the sky at this place get dark enough for a satellite to be seen, at any
 * point in the window? Sampled every 20 minutes, which cannot miss a twilight
 * that lasts hours.
 */
export function skyGetsDark(observer: Observer, from: Date, hours: number): boolean {
  const endMs = from.getTime() + hours * 3_600_000;
  for (let ms = from.getTime(); ms <= endMs; ms += 20 * 60_000) {
    if (observerSunElevationDeg(new Date(ms), observer) < TWILIGHT_SUN_ELEVATION_DEG) return true;
  }
  return false;
}

export { sunElevationDeg, geodeticOf };
