import { haversineM, type BBox, type LatLng } from '@atlas/core';

const EARTH_RADIUS_M = 6_371_008.8;
const METERS_PER_DEGREE_LAT = 111_320;

/** Default width of the place-search corridor on either side of a route. */
export const ROUTE_SEARCH_CORRIDOR_M = 5_000;

/**
 * Distance from a point to the closest route segment, in metres.
 *
 * Route geometries are dense enough that an equirectangular projection around
 * the candidate is both stable and much cheaper than constructing geodesics
 * for every segment. Degenerate one-point paths still get an honest answer.
 */
export function distanceToRouteM(point: LatLng, route: readonly LatLng[]): number {
  if (route.length === 0) return Infinity;
  if (route.length === 1) return haversineM(point, route[0]!);

  const lat0 = (point.lat * Math.PI) / 180;
  const cosLat = Math.max(Math.cos(lat0), 1e-6);
  const project = (p: LatLng): { x: number; y: number } => {
    // Take the short longitude delta across the antimeridian.
    const dLng = (((p.lng - point.lng + 540) % 360) - 180) * (Math.PI / 180);
    return {
      x: dLng * cosLat * EARTH_RADIUS_M,
      y: (p.lat - point.lat) * (Math.PI / 180) * EARTH_RADIUS_M,
    };
  };

  let bestSquared = Infinity;
  for (let i = 1; i < route.length; i++) {
    const a = project(route[i - 1]!);
    const b = project(route[i]!);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSquared = dx * dx + dy * dy;
    const t =
      lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, -(a.x * dx + a.y * dy) / lengthSquared));
    const x = a.x + t * dx;
    const y = a.y + t * dy;
    bestSquared = Math.min(bestSquared, x * x + y * y);
  }
  return Math.sqrt(bestSquared);
}

/**
 * Photon-compatible route bounds, padded by the corridor width. Returns null
 * for an empty geometry. The clients still apply the precise polyline filter;
 * this box only keeps the geocoder query local and reasonably small.
 */
export function routeSearchBounds(
  route: LatLng[],
  paddingM = ROUTE_SEARCH_CORRIDOR_M,
): BBox | null {
  if (route.length === 0) return null;
  let minLat = 90;
  let maxLat = -90;
  let minLng = 180;
  let maxLng = -180;
  for (const p of route) {
    minLat = Math.min(minLat, p.lat);
    maxLat = Math.max(maxLat, p.lat);
    minLng = Math.min(minLng, p.lng);
    maxLng = Math.max(maxLng, p.lng);
  }

  const latPad = Math.max(paddingM, 0) / METERS_PER_DEGREE_LAT;
  const centerLat = (minLat + maxLat) / 2;
  const lngPad = Math.min(
    180,
    Math.max(paddingM, 0) /
      (METERS_PER_DEGREE_LAT * Math.max(Math.cos((centerLat * Math.PI) / 180), 1e-6)),
  );
  return {
    sw: { lat: Math.max(-90, minLat - latPad), lng: Math.max(-180, minLng - lngPad) },
    ne: { lat: Math.min(90, maxLat + latPad), lng: Math.min(180, maxLng + lngPad) },
  };
}

/** Photon expects minLon,minLat,maxLon,maxLat. */
export function photonBbox(bounds: BBox): string {
  return `${bounds.sw.lng},${bounds.sw.lat},${bounds.ne.lng},${bounds.ne.lat}`;
}
