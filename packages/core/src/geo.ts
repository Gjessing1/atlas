/**
 * Geometry and geography: coordinate types, distance, bounding boxes, Web
 * Mercator scaling, and the GeoJSON shapes the map scenes feed to their
 * sources.
 */

/** WGS84 coordinate. */
export interface LatLng {
  lat: number;
  lng: number;
}

/** Geographic bounding box (south-west / north-east corners). */
export interface BBox {
  sw: LatLng;
  ne: LatLng;
}

/** Great-circle distance between two points in meters (haversine, WGS84 mean radius). */
export function haversineM(a: LatLng, b: LatLng): number {
  const R = 6371008.8;
  const toRad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toRad;
  const dLng = (b.lng - a.lng) * toRad;
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h = sinLat * sinLat + Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * sinLng * sinLng;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Whether a point lies inside a bounding box (inclusive). Does not handle antimeridian-crossing boxes. */
export function bboxContains(bbox: BBox, point: LatLng): boolean {
  return (
    point.lat >= bbox.sw.lat &&
    point.lat <= bbox.ne.lat &&
    point.lng >= bbox.sw.lng &&
    point.lng <= bbox.ne.lng
  );
}

// ---- Map GeoJSON helpers (line sources shared by the app map scenes) ----

/** A route/track line as a GeoJSON Feature, from [lng, lat] coordinate pairs. */
export function lineStringFeature(coords: number[][]) {
  return {
    type: 'Feature' as const,
    properties: {},
    geometry: { type: 'LineString' as const, coordinates: coords },
  };
}

/** Named bounding-box outlines (e.g. offline-pack coverage rectangles). */
export function bboxOutlinesFeatureCollection(items: { name: string; bbox: BBox }[]) {
  return {
    type: 'FeatureCollection' as const,
    features: items.map(({ name, bbox: { sw, ne } }) => ({
      type: 'Feature' as const,
      properties: { name },
      geometry: {
        type: 'LineString' as const,
        coordinates: [
          [sw.lng, sw.lat],
          [ne.lng, sw.lat],
          [ne.lng, ne.lat],
          [sw.lng, ne.lat],
          [sw.lng, sw.lat],
        ],
      },
    })),
  };
}

// ---- Map marker scaling ----

/**
 * Screen-size scale factor for place/pin markers at a given zoom. Markers keep
 * full size at city zooms and shrink linearly to half size when zoomed out to
 * region/country level, so a screenful of saved pins doesn't blanket the map.
 * Shared by web (CSS var) and Android (view transform) so both platforms agree.
 */
export function markerScaleForZoom(zoom: number): number {
  const full = 12; // full size from this zoom in
  const min = 7; // fully shrunk from this zoom out
  const minScale = 0.5;
  if (zoom >= full) return 1;
  if (zoom <= min) return minScale;
  return minScale + ((zoom - min) / (full - min)) * (1 - minScale);
}

/**
 * Web Mercator ground resolution at a latitude and zoom, in metres per pixel.
 * Uses 512 px tiles, matching MapLibre's zoom convention on both web and
 * native — a 256 px assumption would be off by exactly one zoom level.
 */
export function metersPerPixel(lat: number, zoom: number): number {
  const EQUATOR_M = 40075016.686;
  return (EQUATOR_M * Math.cos((lat * Math.PI) / 180)) / (512 * Math.pow(2, zoom));
}

/** A scale bar's rounded length: the distance it represents and its pixel width. */
export interface ScaleBar {
  meters: number;
  widthPx: number;
  label: string;
}

/**
 * Pick the largest "nice" round distance that fits within `maxWidthPx`, mirroring
 * MapLibre's 1/2/3/5/10 × 10^n stepping so the web control and the hand-drawn
 * native bar agree. Always metric: Atlas never renders feet or miles, whatever
 * the device locale says (MapLibre Native's own ScaleBarPlugin does, which is
 * why Android draws its own).
 */
export function scaleBarFor(lat: number, zoom: number, maxWidthPx: number): ScaleBar {
  const mpp = metersPerPixel(lat, zoom);
  const maxMeters = mpp * maxWidthPx;
  const magnitude = Math.pow(10, Math.floor(Math.log10(maxMeters)));
  const rel = maxMeters / magnitude;
  const step = rel >= 10 ? 10 : rel >= 5 ? 5 : rel >= 3 ? 3 : rel >= 2 ? 2 : 1;
  const meters = step * magnitude;
  return {
    meters,
    widthPx: meters / mpp,
    label: meters >= 1000 ? `${meters / 1000} km` : `${meters} m`,
  };
}

/**
 * Decode a Google/Valhalla-encoded polyline to `[lat, lng]` pairs.
 *
 * One codec, two precisions in Atlas: Valhalla emits precision 6, while the
 * classic Google encoding used by Entur's journey planner is precision 5.
 * Passing the wrong one silently lands the geometry off the coast of Africa,
 * so callers state it rather than relying on a default.
 */
export function decodePolyline(encoded: string, precision = 6): [number, number][] {
  const factor = 10 ** precision;
  const coords: [number, number][] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  while (index < encoded.length) {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;
    result = 0;
    shift = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;
    coords.push([lat / factor, lng / factor]);
  }
  return coords;
}
