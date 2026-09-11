import { haversineM, type LatLng } from '@atlas/core';

/**
 * Speed-camera conflation — matching Vegvesen's ATK installations (NVDB object
 * types 162 Punkt-ATK and 823 Streknings-ATK) onto a chosen route, the same
 * spatial side-dataset approach as the NVDB speed limits in nvdb.ts:
 * static data baked into a shipped SQLite, never a live call,
 * matched onto the route by geometry alone. Nothing here is Norway-aware in
 * code — outside Norway the dataset has nothing near the route, no cameras are
 * produced, and navigation carries no camera UI at all (absent, not "no data").
 *
 * The two ATK kinds are deliberately different features:
 * a Punkt-ATK is a point hazard to announce ahead; a Streknings-ATK measures an
 * *average* over a stretch, so it becomes a distance range the navigation
 * session tracks with its own running average. Both are direction-controlled
 * installations (a camera facing the other carriageway must stay silent),
 * which is why the dataset carries a resolved travel direction:
 * point cameras a compass bearing, sections geometry already in travel order.
 */

/** One Punkt-ATK camera from the dataset. */
export interface NvdbCameraPoint {
  lat: number;
  lng: number;
  /**
   * Compass bearing (deg from north) of the *controlled* travel direction —
   * resolved at import from the road-link geometry and NVDB's Kontrollretning.
   * Null when the import could not resolve it; the camera then matches either
   * direction (a spurious warning beats a silent camera).
   */
  bearingDeg: number | null;
  name: string | null;
}

/** One Streknings-ATK measured stretch from the dataset. */
export interface NvdbCameraSection {
  name: string | null;
  /** Section geometry **in the controlled travel direction** (flipped at import). */
  points: LatLng[];
}

/** What the dataset store hands the conflation for one route's bounding box. */
export interface NvdbCameraData {
  points: NvdbCameraPoint[];
  sections: NvdbCameraSection[];
}

/** A point camera the route passes, keyed by distance along the route. */
export interface RouteCameraPoint {
  atM: number;
  name: string | null;
}

/** An average-speed stretch the route drives end to end. */
export interface RouteCameraSection {
  startM: number;
  endM: number;
  name: string | null;
}

/** Cameras matched onto one route, both sorted by along-route distance. */
export interface RouteCameras {
  points: RouteCameraPoint[];
  sections: RouteCameraSection[];
}

export interface CameraConflationOptions {
  /**
   * Farthest a camera may sit from the route to count as on it. Looser than
   * the speed-limit tolerance (15 m) because a camera's surveyed point is the
   * roadside gantry, metres off the centreline both datasets draw.
   */
  toleranceM?: number;
  /**
   * Largest angle (deg) between the route's travel direction and a point
   * camera's controlled direction that still counts as the controlled one.
   * Wide enough for curved approaches; narrow enough that the opposite
   * carriageway (180° off) can never match.
   */
  headingToleranceDeg?: number;
}

const DEFAULT_TOLERANCE_M = 40;
const DEFAULT_HEADING_TOLERANCE_DEG = 65;
/** Fraction of a section's sampled vertices that must lie on the route. */
const SECTION_MATCH_FRACTION = 0.8;
/** Sample a section roughly this often along its length. */
const SECTION_SAMPLE_SPACING_M = 400;
/**
 * Suppression margin around a matched section: its endpoint cameras are also
 * Punkt-ATK objects, and announcing them separately would voice every section
 * three times (enter, camera, camera). Their surveyed points sit within a few
 * metres of the section's ends, so a slack this small is plenty.
 */
const SECTION_MEMBER_MARGIN_M = 200;

/** Cumulative distance (m) at each point (`[0]` is always 0). */
function cumulative(points: LatLng[]): number[] {
  const cum = new Array<number>(points.length).fill(0);
  for (let i = 1; i < points.length; i++) {
    cum[i] = cum[i - 1]! + haversineM(points[i - 1]!, points[i]!);
  }
  return cum;
}

/** Metres-per-degree at a latitude, for a local equirectangular plane. */
function scaleAt(lat: number): { mx: number; my: number } {
  const my = 111_320;
  const mx = 111_320 * Math.cos((lat * Math.PI) / 180);
  return { mx, my };
}

/** Smallest signed angle (deg, −180..180]) equivalent to `d`. */
function wrapDeg(d: number): number {
  const w = ((d % 360) + 540) % 360;
  return w - 180 === -180 ? 180 : w - 180;
}

/** Initial bearing (deg from north) from `a` to `b` on the local plane. */
function bearingDeg(a: LatLng, b: LatLng): number {
  const { mx, my } = scaleAt(a.lat);
  const x = (b.lng - a.lng) * mx;
  const y = (b.lat - a.lat) * my;
  return (Math.atan2(x, y) * (180 / Math.PI) + 360) % 360;
}

interface RouteProjection {
  /** Distance (m) along the route of the nearest point. */
  alongM: number;
  /** Distance (m) from the query point to that nearest point. */
  distM: number;
}

/**
 * Project `p` onto the route polyline: the nearest point on any segment, as an
 * along-route distance. Linear in route length with a cheap bbox prefilter per
 * segment — camera counts are tiny (hundreds nationally), so no grid is needed.
 */
function projectOntoRoute(p: LatLng, points: LatLng[], cum: number[]): RouteProjection | null {
  if (points.length < 2) return null;
  const { mx, my } = scaleAt(p.lat);
  // Prefilter box: anything farther than ~1 km can never be a camera match.
  const prefM = 1000;
  const latPad = prefM / my;
  const lngPad = prefM / Math.max(1, mx);
  let best: RouteProjection | null = null;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    if (
      (a.lat < p.lat - latPad && b.lat < p.lat - latPad) ||
      (a.lat > p.lat + latPad && b.lat > p.lat + latPad) ||
      (a.lng < p.lng - lngPad && b.lng < p.lng - lngPad) ||
      (a.lng > p.lng + lngPad && b.lng > p.lng + lngPad)
    ) {
      continue;
    }
    const ax = (a.lng - p.lng) * mx;
    const ay = (a.lat - p.lat) * my;
    const bx = (b.lng - p.lng) * mx;
    const by = (b.lat - p.lat) * my;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = 0;
    if (len2 > 0) {
      t = -(ax * dx + ay * dy) / len2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
    }
    const cx = ax + t * dx;
    const cy = ay + t * dy;
    const distM = Math.sqrt(cx * cx + cy * cy);
    if (best === null || distM < best.distM) {
      best = { alongM: cum[i - 1]! + Math.sqrt(len2) * t, distM };
    }
  }
  return best;
}

/** The point `m` metres along the polyline (clamped to its ends). */
function pointAlong(points: LatLng[], cum: number[], m: number): LatLng {
  const total = cum[cum.length - 1] ?? 0;
  const target = Math.min(Math.max(0, m), total);
  for (let i = 1; i < points.length; i++) {
    if (cum[i]! >= target) {
      const span = cum[i]! - cum[i - 1]!;
      const t = span > 0 ? (target - cum[i - 1]!) / span : 0;
      const a = points[i - 1]!;
      const b = points[i]!;
      return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
    }
  }
  return points[points.length - 1]!;
}

/**
 * The route's travel bearing at `alongM`, from a short chord centred on the
 * position — one raw segment's bearing jitters on dense polylines.
 */
function routeBearingAt(points: LatLng[], cum: number[], alongM: number): number | null {
  const total = cum[cum.length - 1] ?? 0;
  if (total <= 0) return null;
  const half = 15;
  const from = Math.min(Math.max(0, alongM - half), Math.max(0, total - 2 * half));
  const to = Math.min(total, from + 2 * half);
  if (to <= from) return null;
  return bearingDeg(pointAlong(points, cum, from), pointAlong(points, cum, to));
}

/**
 * Match ATK cameras onto a chosen route. Pure and platform-neutral, like
 * {@link nvdbSpeedOverrides}: the backend feeds it dataset rows for the
 * route's bounding box, an offline pack does the same on-device.
 *
 * A point camera matches when it lies within tolerance of the route *and* the
 * route's travel direction there agrees with the camera's controlled
 * direction. A section matches only when the route actually drives it in the
 * controlled direction, start to end — sampled vertices must lie on the route
 * in increasing along-route order, and the route must not shortcut it (an
 * on-ramp joining mid-way gets no section, correctly: an average that didn't
 * start at the entry camera is not the number the installation measures).
 * A matched section's own endpoint cameras are dropped from the point list so
 * the stretch is announced once, as a section, not three times.
 */
export function conflateCameras(
  routePoints: LatLng[],
  data: NvdbCameraData,
  opts: CameraConflationOptions = {},
): RouteCameras {
  if (routePoints.length < 2 || (data.points.length === 0 && data.sections.length === 0)) {
    return { points: [], sections: [] };
  }
  const toleranceM = opts.toleranceM ?? DEFAULT_TOLERANCE_M;
  const headingTolDeg = opts.headingToleranceDeg ?? DEFAULT_HEADING_TOLERANCE_DEG;
  const cum = cumulative(routePoints);

  const sections: RouteCameraSection[] = [];
  for (const section of data.sections) {
    if (section.points.length < 2) continue;
    const secCum = cumulative(section.points);
    const secLenM = secCum[secCum.length - 1]!;
    if (secLenM <= 0) continue;
    const sampleCount = Math.min(
      25,
      Math.max(3, Math.round(secLenM / SECTION_SAMPLE_SPACING_M) + 1),
    );
    let matched = 0;
    let prevAlong = -Infinity;
    let ordered = true;
    let firstAlong: number | null = null;
    let lastAlong: number | null = null;
    for (let s = 0; s < sampleCount; s++) {
      const at = (secLenM * s) / (sampleCount - 1);
      const proj = projectOntoRoute(pointAlong(section.points, secCum, at), routePoints, cum);
      if (!proj || proj.distM > toleranceM) {
        // The section's ends are not optional: a route that joins after the
        // entry camera (or leaves before the exit one) is not measured.
        if (s === 0 || s === sampleCount - 1) {
          ordered = false;
          break;
        }
        continue;
      }
      matched++;
      // Travel order: the route must pass the samples in section order, or it
      // is driving the stretch the uncontrolled way. Small slack for the
      // projection wobble of near-coincident samples.
      if (proj.alongM < prevAlong - 30) {
        ordered = false;
        break;
      }
      prevAlong = Math.max(prevAlong, proj.alongM);
      if (firstAlong === null) firstAlong = proj.alongM;
      lastAlong = proj.alongM;
    }
    if (!ordered || firstAlong === null || lastAlong === null) continue;
    if (matched / sampleCount < SECTION_MATCH_FRACTION) continue;
    const spanM = lastAlong - firstAlong;
    // The route must cover the whole stretch, not a geometric coincidence of
    // similar length elsewhere: span within ±25 % of the section's own length.
    if (spanM < secLenM * 0.75 || spanM > secLenM * 1.25) continue;
    sections.push({ startM: firstAlong, endM: lastAlong, name: section.name });
  }
  sections.sort((a, b) => a.startM - b.startM);

  const points: RouteCameraPoint[] = [];
  for (const camera of data.points) {
    const proj = projectOntoRoute({ lat: camera.lat, lng: camera.lng }, routePoints, cum);
    if (!proj || proj.distM > toleranceM) continue;
    if (camera.bearingDeg !== null) {
      const travel = routeBearingAt(routePoints, cum, proj.alongM);
      if (travel !== null && Math.abs(wrapDeg(travel - camera.bearingDeg)) > headingTolDeg) {
        continue;
      }
    }
    const inMatchedSection = sections.some(
      (s) =>
        proj.alongM >= s.startM - SECTION_MEMBER_MARGIN_M &&
        proj.alongM <= s.endM + SECTION_MEMBER_MARGIN_M,
    );
    if (inMatchedSection) continue;
    points.push({ atM: proj.alongM, name: camera.name });
  }
  points.sort((a, b) => a.atM - b.atM);

  return { points, sections };
}
