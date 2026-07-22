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

/** A [west, south, east, north] box in WGS84 degrees. */
export type LngLatBbox = [number, number, number, number];

// GRS80 / WGS84 — identical to the metre for our purposes.
const A = 6378137;
const F = 1 / 298.257223563;
const K0 = 0.9996;
const FALSE_EASTING = 500000;
/** UTM zone 33's central meridian. */
const LON0 = (15 * Math.PI) / 180;

/**
 * Forward transverse-Mercator to EPSG:25833, in metres. Accurate to well under
 * a metre across Norway, which is far more than a query envelope needs.
 */
export function wgs84ToUtm33(lng: number, lat: number): { x: number; y: number } {
  const e2 = F * (2 - F);
  const ep2 = e2 / (1 - e2);
  const phi = (lat * Math.PI) / 180;
  const lam = (lng * Math.PI) / 180;

  const sinPhi = Math.sin(phi);
  const cosPhi = Math.cos(phi);
  const tanPhi = Math.tan(phi);

  const n = A / Math.sqrt(1 - e2 * sinPhi * sinPhi);
  const t = tanPhi * tanPhi;
  const c = ep2 * cosPhi * cosPhi;
  const a = cosPhi * (lam - LON0);

  const m =
    A *
    ((1 - e2 / 4 - (3 * e2 * e2) / 64 - (5 * e2 * e2 * e2) / 256) * phi -
      ((3 * e2) / 8 + (3 * e2 * e2) / 32 + (45 * e2 * e2 * e2) / 1024) * Math.sin(2 * phi) +
      ((15 * e2 * e2) / 256 + (45 * e2 * e2 * e2) / 1024) * Math.sin(4 * phi) -
      ((35 * e2 * e2 * e2) / 3072) * Math.sin(6 * phi));

  const x =
    K0 *
      n *
      (a +
        ((1 - t + c) * a * a * a) / 6 +
        ((5 - 18 * t + t * t + 72 * c - 58 * ep2) * a ** 5) / 120) +
    FALSE_EASTING;
  const y =
    K0 *
    (m +
      n *
        tanPhi *
        ((a * a) / 2 +
          ((5 - t + 9 * c + 4 * c * c) * a ** 4) / 24 +
          ((61 - 58 * t + t * t + 600 * c - 330 * ep2) * a ** 6) / 720));

  return { x, y };
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
