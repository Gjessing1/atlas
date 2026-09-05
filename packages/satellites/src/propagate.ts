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
 */
export function horizonHalfAngleDeg(altitudeKm: number): number {
  if (altitudeKm <= 0) return 0;
  return (Math.acos(EARTH_RADIUS_KM / (EARTH_RADIUS_KM + altitudeKm)) * 180) / Math.PI;
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

/**
 * The horizon circle: the ground area from which this object is above the
 * horizon right now, as a closed ring.
 *
 * Returns null when the circle swallows a pole. A ring drawn round a pole is
 * not a ring in longitude/latitude — every meridian is inside it — so there is
 * no honest closed polygon to hand a renderer, and the alternative (a ring that
 * silently omits the cap) would draw a hole exactly where the coverage is
 * total. Polar-orbiting objects hit this over the Arctic regularly, which is
 * to say: over Norway's sky.
 */
export function footprintRing(fix: SatelliteFix, points = 96): [number, number][] | null {
  const centralAngle = Math.acos(EARTH_RADIUS_KM / (EARTH_RADIUS_KM + fix.altitudeKm));
  const latRad = (fix.lat * Math.PI) / 180;
  if (Math.abs(latRad) + centralAngle >= Math.PI / 2) return null;

  const ring: [number, number][] = [];
  for (let i = 0; i <= points; i++) {
    const bearing = (2 * Math.PI * i) / points;
    const lat = Math.asin(
      Math.sin(latRad) * Math.cos(centralAngle) +
        Math.cos(latRad) * Math.sin(centralAngle) * Math.cos(bearing),
    );
    const lng =
      (fix.lng * Math.PI) / 180 +
      Math.atan2(
        Math.sin(bearing) * Math.sin(centralAngle) * Math.cos(latRad),
        Math.cos(centralAngle) - Math.sin(latRad) * Math.sin(lat),
      );
    ring.push([normalizeLng((lng * 180) / Math.PI), (lat * 180) / Math.PI]);
  }
  return ring;
}

export { EARTH_RADIUS_KM, normalizeLng };
