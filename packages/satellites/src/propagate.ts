/** SGP4 propagation: where an object is now, and the track it draws. */

import {
  eciToGeodetic,
  gstime,
  jday,
  json2satrec,
  propagate,
  radiansToDegrees,
  type OMMJsonObject,
  type SatRec,
} from 'satellite.js';

import {
  elementAgeDays,
  orbitalPeriodMinutes,
  type SatelliteGroup,
  type SatelliteOmm,
} from './elements.js';
import { shadowFraction, sunPosition } from './illumination.js';

/** Mean Earth radius (km), matching the WGS-84 sphere SGP4's transforms assume. */
const EARTH_RADIUS_KM = 6371;

/** Earth's standard gravitational parameter, km^3/s^2. */
const MU_KM3_S2 = 398_600.4418;

/**
 * Mean altitude from mean motion, km — Kepler's third law backwards.
 *
 * Cheap enough to use as a filter before any propagation happens, which is what
 * it is for: the horizon distance it feeds decides whether an orbit can reach a
 * given observer at all.
 */
export function meanAltitudeKm(omm: Pick<SatelliteOmm, 'MEAN_MOTION'>): number {
  const radiansPerSecond = (omm.MEAN_MOTION * 2 * Math.PI) / 86_400;
  const semiMajorAxis = Math.cbrt(MU_KM3_S2 / (radiansPerSecond * radiansPerSecond));
  return semiMajorAxis - EARTH_RADIUS_KM;
}

/**
 * Angular radius of the ground area an object at this altitude can see,
 * degrees — half the width of its footprint, and the margin by which it can
 * appear beyond the latitude its inclination reaches.
 *
 * `minElevationDeg` raises the floor from the geometric horizon to the angle a
 * pass must actually reach to be worth walking outside for, and it is not a
 * small correction: the ISS clears a 2250 km radius at 0°, but only ~1390 km
 * at the 10° the pass list defaults to. A 0° circle drawn beside a 10° list
 * would promise sightings from a ring nearly twice too wide.
 */
export function horizonHalfAngleDeg(altitudeKm: number, minElevationDeg = 0): number {
  if (altitudeKm <= 0) return 0;
  const epsilon = (minElevationDeg * Math.PI) / 180;
  // Law of sines on the observer/centre/object triangle: the elevation floor
  // eats into the central angle from both ends, once by tilting the sight line
  // and once by the range that tilt costs.
  const ratio = (EARTH_RADIUS_KM / (EARTH_RADIUS_KM + altitudeKm)) * Math.cos(epsilon);
  if (ratio >= 1) return 0;
  return Math.max(0, ((Math.acos(ratio) - epsilon) * 180) / Math.PI);
}

/** Great-circle separation of two points on the ground, degrees. */
export function groundAngleDeg(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return (2 * Math.asin(Math.min(1, Math.sqrt(h))) * 180) / Math.PI;
}

/**
 * Whether an object is above the horizon as seen from a point on the ground.
 *
 * Deliberately the *same* spherical test the drawn footprint is built from,
 * rather than the ellipsoidal look angles `predictPasses` uses. The two differ
 * by a few km at the rim, and here agreement matters more than accuracy: this
 * answers "am I inside that circle", and a badge that said "not up" while the
 * user's own dot sat plainly inside the ring would read as a broken map.
 */
export function coversGround(
  fix: Pick<SatelliteFix, 'lat' | 'lng' | 'altitudeKm'>,
  point: { lat: number; lng: number },
  minElevationDeg = 0,
): boolean {
  const halfAngle = horizonHalfAngleDeg(fix.altitudeKm, minElevationDeg);
  if (halfAngle <= 0) return false;
  return groundAngleDeg(fix, point) <= halfAngle;
}

/** Where an object is at one instant, in map terms. */
export interface SatelliteFix {
  noradId: number;
  name: string;
  /** Source group, for cartography — see `SatelliteOmm.ATLAS_GROUP`. */
  group?: SatelliteGroup;
  /** Sub-satellite point — the spot on the ground it is directly above. */
  lng: number;
  lat: number;
  /** Height above the ellipsoid, km. */
  altitudeKm: number;
  /** Speed, km/s. The ISS runs about 7.66. */
  speedKmS: number;
  /**
   * True when sunlight reaches it — the precondition for seeing it at all.
   * A satellite in Earth's shadow is invisible however high it rides.
   */
  sunlit: boolean;
  /** 0 = full sun, 1 = umbra, between = penumbra. */
  shadow: number;
  /** Age of the elements this was propagated from, days. */
  ageDays: number;
}

/**
 * SatRec cache.
 *
 * Keyed on the element object itself, so a refreshed element set invalidates by
 * construction — a new array of parsed records shares no identity with the old
 * one, and the entries for the replaced objects simply become unreachable. That
 * matters more than it looks: building a SatRec is the expensive half of SGP4
 * (it runs the whole initialiser), and the tracker rebuilds every position once
 * a second for a couple of hundred objects.
 */
const satrecs = new WeakMap<SatelliteOmm, SatRec | null>();

/** The initialised propagator for an element set, or null if SGP4 rejects it. */
export function satrecFor(omm: SatelliteOmm): SatRec | null {
  const cached = satrecs.get(omm);
  if (cached !== undefined) return cached;
  let rec: SatRec | null = null;
  try {
    // The wire format *is* OMM JSON, which is the whole reason it is carried
    // through unremapped — this hand-off is a pass, not a conversion. The cast
    // only supplies the propagator's open index signature for the extension
    // metadata CelesTrak does not send; every field it actually reads has been
    // range-checked by `parseOmmRecords` before an element gets this far.
    rec = json2satrec(omm as unknown as OMMJsonObject);
  } catch {
    rec = null;
  }
  satrecs.set(omm, rec);
  return rec;
}

/**
 * Sub-satellite point and illumination at `date`, or null when SGP4 declines —
 * a decayed object, or elements it cannot initialise.
 *
 * Null is a normal outcome, not an error: the catalog carries objects that
 * re-entered between one element refresh and the next, and SGP4's decay/error
 * result is what stops those being drawn at a nonsense position instead of
 * disappearing.
 */
export function subpointAt(omm: SatelliteOmm, date: Date): SatelliteFix | null {
  const rec = satrecFor(omm);
  if (!rec) return null;
  const state = propagate(rec, date);
  if (!state) return null;
  const gmst = gstime(date);
  const geodetic = eciToGeodetic(state.position, gmst);
  if (!Number.isFinite(geodetic.latitude) || !Number.isFinite(geodetic.longitude)) return null;
  const { x, y, z } = state.velocity;
  const shadow = shadowFraction(sunPosition(jday(date)), state.position);
  return {
    noradId: omm.NORAD_CAT_ID,
    name: omm.OBJECT_NAME,
    group: omm.ATLAS_GROUP,
    lng: normalizeLng(radiansToDegrees(geodetic.longitude)),
    lat: radiansToDegrees(geodetic.latitude),
    altitudeKm: geodetic.height,
    speedKmS: Math.sqrt(x * x + y * y + z * z),
    sunlit: shadow < 1,
    shadow,
    ageDays: elementAgeDays(omm, date.getTime()),
  };
}

/** Wrap a longitude into [-180, 180). */
function normalizeLng(lng: number): number {
  return ((((lng + 180) % 360) + 360) % 360) - 180;
}

export interface GroundTrackOptions {
  /** Centre of the window. Default: now. */
  at?: Date;
  /**
   * How much of the orbit to draw, as a multiple of the period, centred on
   * `at`. Default 1 — half a revolution behind, half ahead.
   */
  revolutions?: number;
  /** Sample spacing in seconds. Default 20 (about 150 km of ISS track). */
  stepSeconds?: number;
}

/**
 * The path the sub-satellite point traces, as one or more line segments.
 *
 * Several segments rather than one line because of the antimeridian: a track
 * that steps from 179.6°E to 179.8°W has moved 90 km, but a renderer handed
 * both points in one LineString draws a stripe the entire width of the map
 * through it. Each crossing is cut, with the exact ±180 point interpolated in
 * on both sides so the track still reaches the edge rather than stopping short
 * of it.
 */
export function groundTrackSegments(
  omm: SatelliteOmm,
  options: GroundTrackOptions = {},
): [number, number][][] {
  const rec = satrecFor(omm);
  if (!rec) return [];
  const at = options.at ?? new Date();
  const revolutions = options.revolutions ?? 1;
  const stepSeconds = Math.max(1, options.stepSeconds ?? 20);
  const spanMs = orbitalPeriodMinutes(omm) * 60_000 * revolutions;
  const startMs = at.getTime() - spanMs / 2;
  const steps = Math.min(2000, Math.ceil(spanMs / (stepSeconds * 1000)));

  const points: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const when = new Date(startMs + (spanMs * i) / steps);
    const state = propagate(rec, when);
    if (!state) continue;
    const geodetic = eciToGeodetic(state.position, gstime(when));
    const lng = radiansToDegrees(geodetic.longitude);
    const lat = radiansToDegrees(geodetic.latitude);
    if (Number.isFinite(lng) && Number.isFinite(lat)) points.push([normalizeLng(lng), lat]);
  }
  return splitAtAntimeridian(points);
}

/** Cut a point run wherever it crosses ±180, interpolating the crossing. */
export function splitAtAntimeridian(points: [number, number][]): [number, number][][] {
  if (points.length < 2) return points.length ? [points] : [];
  const segments: [number, number][][] = [];
  let current: [number, number][] = [points[0]!];
  for (let i = 1; i < points.length; i++) {
    const [prevLng, prevLat] = points[i - 1]!;
    const [lng, lat] = points[i]!;
    if (Math.abs(lng - prevLng) > 180) {
      // Latitude at the crossing, by proportion of the wrapped longitude step.
      const east = prevLng > 0;
      const prevEdge = east ? 180 : -180;
      const nextEdge = -prevEdge;
      const delta = lng + (east ? 360 : -360) - prevLng;
      const ratio = delta === 0 ? 0.5 : (prevEdge - prevLng) / delta;
      const edgeLat = prevLat + (lat - prevLat) * ratio;
      current.push([prevEdge, edgeLat]);
      segments.push(current);
      current = [
        [nextEdge, edgeLat],
        [lng, lat],
      ];
    } else {
      current.push([lng, lat]);
    }
  }
  if (current.length > 1) segments.push(current);
  return segments;
}

/** Latitude a footprint's polar cap is closed at. */
const POLE_LAT = 90;

export interface FootprintOptions {
  /** Samples around the ring. Default 128. */
  points?: number;
  /** Horizon floor in degrees — see `horizonHalfAngleDeg`. Default 0. */
  minElevationDeg?: number;
}

/**
 * The horizon circle: the ground area from which this object is above the
 * horizon right now, as a closed polygon ring.
 *
 * Two things make this more than a loop round a circle, and for Atlas both are
 * the ordinary case rather than the exotic one:
 *
 * - **Longitudes stay continuous.** A footprint straddling the antimeridian
 *   holds points near +179 and −179 that are 200 km apart. Wrapping each into
 *   [−180, 180) turns the ring inside out, and the renderer fills the other
 *   358° of the planet. MapLibre's GeoJSON source wraps features itself, so an
 *   unwrapped ring is both the honest input and the one that draws correctly.
 * - **A ring around a pole is not a ring.** Once the circle reaches over the
 *   pole, every meridian is inside it and the sampled curve sweeps a full turn
 *   of longitude instead of closing on itself; the polygon is that curve plus
 *   the cap above it, spliced in below. A polar orbit does this over the
 *   Arctic on most revolutions — which is to say over Norway's sky, so a
 *   footprint that gave up here would blank out exactly where it is watched.
 *
 * Empty only for a floor of 90 degrees, where the sole point that clears it is
 * the sub-satellite point itself.
 */
export function footprintRing(
  fix: SatelliteFix,
  options: FootprintOptions = {},
): [number, number][] {
  const samples = Math.max(8, Math.round(options.points ?? 128));
  const halfAngle = horizonHalfAngleDeg(fix.altitudeKm, options.minElevationDeg ?? 0);
  if (halfAngle <= 0) return [];

  const centralAngle = (halfAngle * Math.PI) / 180;
  const latRad = (fix.lat * Math.PI) / 180;
  const sinLat = Math.sin(latRad);
  const cosLat = Math.cos(latRad);
  const sinCentral = Math.sin(centralAngle);
  const cosCentral = Math.cos(centralAngle);

  const ring: [number, number][] = [];
  let previousLng = fix.lng;
  for (let i = 0; i <= samples; i++) {
    const bearing = (2 * Math.PI * i) / samples;
    const lat = Math.asin(sinLat * cosCentral + cosLat * sinCentral * Math.cos(bearing));
    let lng =
      fix.lng +
      (Math.atan2(Math.sin(bearing) * sinCentral * cosLat, cosCentral - sinLat * Math.sin(lat)) *
        180) /
        Math.PI;
    // Unwrap against the previous sample. Neighbours are a few hundred km
    // apart, so a step of more than half the planet is atan2's branch cut and
    // not travel — the one place the pole case and the antimeridian case are
    // the same bug.
    while (lng - previousLng > 180) lng -= 360;
    while (lng - previousLng < -180) lng += 360;
    previousLng = lng;
    ring.push([lng, (lat * 180) / Math.PI]);
  }

  const first = ring[0]!;
  const sweep = ring[ring.length - 1]![0] - first[0];
  // A closed ring returns to the longitude it started from; a curve that has
  // moved a whole turn instead has gone over the pole.
  if (Math.abs(sweep) < 180) {
    // Land the closing vertex *on* the opening one. The bearing-2pi sample
    // comes back an ulp away from the bearing-0 sample, and a polygon ring
    // whose ends only nearly meet is not a closed ring.
    ring[ring.length - 1] = [first[0], first[1]];
    return ring;
  }

  const turn = sweep > 0 ? 360 : -360;
  ring[ring.length - 1] = [first[0] + turn, first[1]];
  const capLat = fix.lat + halfAngle >= 90 ? POLE_LAT : -POLE_LAT;
  // Up to the pole at the far end, back along it, and down to the near end.
  // Exactly +/-90 is safe to emit: the GeoJSON source clamps latitude into the
  // Mercator square when it tiles, so the cap lands on the top edge of the map
  // rather than at an infinite y.
  return [...ring, [first[0] + turn, capLat], [first[0], capLat], [first[0], first[1]]];
}

export { EARTH_RADIUS_KM, normalizeLng };
