/**
 * Small projection + polygon helpers for talking to Norwegian government
 * services that answer only in their native grid.
 *
 * Deliberately not a general projection library: the one transform Atlas needs
 * is WGS84 → UTM zone 33N (EPSG:25833), because NVE's ArcGIS services **ignore
 * the `inSR` query parameter** and read a request envelope as native grid
 * metres. Sending lon/lat degrees there does not error — it silently matches
 * nothing, which reads exactly like "this lake has no data".
 */

import type { LatLng } from './geo.js';

/** A [west, south, east, north] box in WGS84 degrees. */
export type LngLatBbox = [number, number, number, number];

// GRS80 / WGS84 — identical to the metre for our purposes.
const A = 6378137;
const F = 1 / 298.257223563;
const K0 = 0.9996;
const FALSE_EASTING = 500000;
/** UTM zone 33's central meridian, in degrees. */
const LON0_DEG = 15;
const DEG = Math.PI / 180;

/**
 * Both directions use the Krüger series in the third flattening `n`, not the
 * older USGS series in eccentricity.
 *
 * The reason is Norway, not elegance: zone 33 nominally spans 12°–18° E, and
 * Norway uses it from Rogaland (≈ 4.5° E) to Kirkenes (≈ 30.5° E) — up to 15°
 * off the central meridian, five times the width the classic series is
 * written for. Checked against NVE's own reprojection of lake 209007 in
 * Finnmark, the USGS inverse lands **32 m** out there while its forward stays
 * within half a metre; the error is invisible in Oslo and grows silently
 * eastwards. Krüger converges in powers of `n` ≈ 1/598, so four terms hold
 * millimetres across the whole country.
 */
const N = F / (2 - F);
/** Rectifying radius: the sphere whose meridian arc matches the ellipsoid's. */
const RECTIFYING_RADIUS = (A / (1 + N)) * (1 + N ** 2 / 4 + N ** 4 / 64 + N ** 6 / 256) * K0;

/** Geodetic → conformal (Krüger α). */
const ALPHA = [
  N / 2 - (2 * N ** 2) / 3 + (5 * N ** 3) / 16 + (41 * N ** 4) / 180,
  (13 * N ** 2) / 48 - (3 * N ** 3) / 5 + (557 * N ** 4) / 1440,
  (61 * N ** 3) / 240 - (103 * N ** 4) / 140,
  (49561 * N ** 4) / 161280,
];
/** Conformal → geodetic (Krüger β), the inverse of {@link ALPHA}. */
const BETA = [
  N / 2 - (2 * N ** 2) / 3 + (37 * N ** 3) / 96 - N ** 4 / 360,
  N ** 2 / 48 + N ** 3 / 15 - (437 * N ** 4) / 1440,
  (17 * N ** 3) / 480 - (37 * N ** 4) / 840,
  (4397 * N ** 4) / 161280,
];
/** Conformal latitude → geodetic latitude (Krüger δ). */
const DELTA = [
  2 * N - (2 * N ** 2) / 3 - 2 * N ** 3 + (116 * N ** 4) / 45,
  (7 * N ** 2) / 3 - (8 * N ** 3) / 5 - (227 * N ** 4) / 45,
  (56 * N ** 3) / 15 - (136 * N ** 4) / 35,
  (4279 * N ** 4) / 630,
];

/** Forward transverse-Mercator to EPSG:25833, in metres. */
export function wgs84ToUtm33(lng: number, lat: number): { x: number; y: number } {
  const e = Math.sqrt(F * (2 - F));
  const phi = lat * DEG;
  const dLambda = (lng - LON0_DEG) * DEG;

  // Geodetic latitude → conformal latitude, on the sphere Krüger works on.
  const sinPhi = Math.sin(phi);
  const conformal = Math.atan(Math.sinh(Math.asinh(Math.tan(phi)) - e * Math.atanh(e * sinPhi)));

  let xi = Math.atan2(Math.sin(conformal), Math.cos(conformal) * Math.cos(dLambda));
  let eta = Math.asinh(
    (Math.cos(conformal) * Math.sin(dLambda)) /
      Math.hypot(Math.sin(conformal), Math.cos(conformal) * Math.cos(dLambda)),
  );
  const xi0 = xi;
  const eta0 = eta;
  for (let j = 1; j <= ALPHA.length; j++) {
    xi += ALPHA[j - 1]! * Math.sin(2 * j * xi0) * Math.cosh(2 * j * eta0);
    eta += ALPHA[j - 1]! * Math.cos(2 * j * xi0) * Math.sinh(2 * j * eta0);
  }

  return { x: RECTIFYING_RADIUS * eta + FALSE_EASTING, y: RECTIFYING_RADIUS * xi };
}

/**
 * Inverse transverse-Mercator from EPSG:25833 metres back to WGS84 degrees.
 *
 * Needed because some Norwegian services answer in the national grid rather
 * than accepting a projection: NPRA's DATEX corridor geometry is a GML
 * `posList` in UTM33, and western Norway sits far enough west of the central
 * meridian that its eastings go **negative** (Bergen ≈ −30 000). A reader that
 * assumes the false easting keeps coordinates positive puts Bergen in the
 * North Sea.
 */
export function utm33ToWgs84(x: number, y: number): LatLng {
  const xi = y / RECTIFYING_RADIUS;
  const eta = (x - FALSE_EASTING) / RECTIFYING_RADIUS;

  let xi0 = xi;
  let eta0 = eta;
  for (let j = 1; j <= BETA.length; j++) {
    xi0 -= BETA[j - 1]! * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
    eta0 -= BETA[j - 1]! * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
  }

  const conformal = Math.asin(Math.sin(xi0) / Math.cosh(eta0));
  let phi = conformal;
  for (let j = 1; j <= DELTA.length; j++) phi += DELTA[j - 1]! * Math.sin(2 * j * conformal);

  return {
    lat: phi / DEG,
    lng: LON0_DEG + Math.atan2(Math.sinh(eta0), Math.cos(xi0)) / DEG,
  };
}

/**
 * Project a lon/lat box to a UTM33 envelope. The corners are projected and then
 * min/max-ed rather than transformed pairwise, because the grid is not aligned
 * to the graticule — a box's easting extremes sit at its north or south edge
 * depending on hemisphere side, so taking two corners would clip the envelope.
 */
export function bboxToUtm33(bbox: LngLatBbox): [number, number, number, number] {
  const [w, s, e, n] = bbox;
  const corners = [wgs84ToUtm33(w, s), wgs84ToUtm33(e, s), wgs84ToUtm33(w, n), wgs84ToUtm33(e, n)];
  const xs = corners.map((p) => p.x);
  const ys = corners.map((p) => p.y);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/**
 * Grid that overlay-label viewports are rounded to, in degrees.
 *
 * One shared constant on purpose: the backend snaps before caching and querying
 * upstream, and both clients snap before deciding whether to refetch. If those
 * disagreed, every pan would look like a new viewport to the client and hit a
 * cache the server had keyed differently — the requests would be pointless but
 * not obviously wrong, which is the sort of waste nobody notices.
 */
export const OVERLAY_LABEL_SNAP_DEG = 0.25;

/**
 * The bbox a map camera is looking at, from its centre, zoom and screen size.
 *
 * Android needs this because its MapLibre binding exposes no `getVisibleBounds`
 * — the camera is all there is. It lives here rather than in the app so the two
 * things that ask "what am I looking at?" (overlay labels, and which derived
 * cells to prepare) cannot answer it differently.
 *
 * MapLibre's world is 512 px at zoom 0; in Mercator a pixel spans fewer degrees
 * of latitude than of longitude, by cos(latitude). Approximate near the poles
 * and for a pitched camera, which is fine for both callers: one snaps the
 * result to a coarse grid, the other to ~10 km cells.
 */
export function viewportBbox(
  center: LatLng,
  zoom: number,
  screen: { width: number; height: number },
): LngLatBbox {
  const degPerPxLng = 360 / (512 * 2 ** zoom);
  const cosLat = Math.max(0.02, Math.cos((center.lat * Math.PI) / 180));
  const halfLng = (screen.width / 2) * degPerPxLng;
  const halfLat = (screen.height / 2) * degPerPxLng * cosLat;
  return [
    center.lng - halfLng,
    Math.max(-85, center.lat - halfLat),
    center.lng + halfLng,
    Math.min(85, center.lat + halfLat),
  ];
}

/** Round a viewport outwards to the shared label grid. */
export function snapLabelBbox([w, s, e, n]: LngLatBbox, snap = OVERLAY_LABEL_SNAP_DEG): LngLatBbox {
  const floor = (v: number) => Math.floor(v / snap) * snap;
  const ceil = (v: number) => Math.ceil(v / snap) * snap;
  // Rounded to kill the float dust that `Math.floor(v / 0.25) * 0.25` leaves,
  // so the same cell always stringifies to the same cache key.
  const fix = (v: number) => Number(v.toFixed(4));
  return [fix(floor(w)), fix(floor(Math.max(-85, s))), fix(ceil(e)), fix(ceil(Math.min(85, n)))];
}

/** A closed ring of [lng, lat] pairs, as ArcGIS and GeoJSON both spell it. */
export type Ring = number[][];

/** Twice the signed area of a ring — sign gives winding, magnitude gives size. */
function signedDoubleArea(ring: Ring): number {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i] as [number, number];
    const [xj, yj] = ring[j] as [number, number];
    sum += xj * yi - xi * yj;
  }
  return sum;
}

/**
 * A point to hang a label on for a multi-ring polygon.
 *
 * Uses the **area** centroid of the largest ring, not the mean of its vertices:
 * lake outlines are digitised unevenly, so a vertex mean drifts towards
 * whichever shore was traced in most detail. Holes (islands) are ignored — they
 * only matter for a lake shaped like a ring, which is rare enough not to pay
 * a point-in-polygon test for on every label.
 *
 * Returns null for degenerate input (no ring, or a zero-area sliver).
 */
export function polygonLabelPoint(rings: Ring[]): { lng: number; lat: number } | null {
  let best: Ring | null = null;
  let bestArea = 0;
  for (const ring of rings) {
    if (ring.length < 3) continue;
    const area = Math.abs(signedDoubleArea(ring));
    if (area > bestArea) {
      bestArea = area;
      best = ring;
    }
  }
  if (!best || bestArea === 0) return null;

  let cx = 0;
  let cy = 0;
  for (let i = 0, j = best.length - 1; i < best.length; j = i++) {
    const [xi, yi] = best[i] as [number, number];
    const [xj, yj] = best[j] as [number, number];
    const cross = xj * yi - xi * yj;
    cx += (xj + xi) * cross;
    cy += (yj + yi) * cross;
  }
  const scale = 3 * signedDoubleArea(best);
  return { lng: cx / scale, lat: cy / scale };
}
