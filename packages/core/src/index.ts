export const APP_NAME = 'Atlas';

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

/** Shareable map view: camera position plus an optional dropped pin. */
export interface MapViewState {
  center: LatLng;
  zoom: number;
  pin?: LatLng;
}

const round = (n: number, decimals: number): number => {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
};

/**
 * Encode a map view as a URL hash, e.g. `#map=12.3/59.91384/10.75234` with an
 * optional `&pin=<lat>/<lng>`. Coordinates keep 5 decimals (~1 m).
 */
export function encodeMapHash(state: MapViewState): string {
  const c = state.center;
  let hash = `#map=${round(state.zoom, 2)}/${round(c.lat, 5)}/${round(c.lng, 5)}`;
  if (state.pin) hash += `&pin=${round(state.pin.lat, 5)}/${round(state.pin.lng, 5)}`;
  return hash;
}

/** Parse a `#map=…` hash produced by {@link encodeMapHash}; null when absent/malformed. */
export function decodeMapHash(hash: string): MapViewState | null {
  const match = /(?:^|[#&])map=([0-9.-]+)\/([0-9.-]+)\/([0-9.-]+)/.exec(hash);
  if (!match) return null;
  const [zoom, lat, lng] = match.slice(1).map(Number);
  if (![zoom, lat, lng].every(Number.isFinite)) return null;

  const state: MapViewState = { center: { lat: lat!, lng: lng! }, zoom: zoom! };
  const pinMatch = /[#&]pin=([0-9.-]+)\/([0-9.-]+)/.exec(hash);
  if (pinMatch) {
    const [pinLat, pinLng] = pinMatch.slice(1).map(Number);
    if (Number.isFinite(pinLat) && Number.isFinite(pinLng)) {
      state.pin = { lat: pinLat!, lng: pinLng! };
    }
  }
  return state;
}

/** A geocoding result in app terms, decoupled from the Photon wire format. */
export interface SearchResult {
  /** Primary display name, e.g. "Preikestolen". */
  name: string;
  /** Disambiguation line: street, city, region, country. */
  label: string;
  position: LatLng;
  /** OSM key/value, e.g. "tourism/attraction" — drives result icons later. */
  kind?: string;
}

/** The subset of a Photon GeoJSON feature Atlas consumes. */
export interface PhotonFeature {
  geometry?: { type?: string; coordinates?: number[] };
  properties?: {
    name?: string;
    street?: string;
    housenumber?: string;
    postcode?: string;
    city?: string;
    state?: string;
    country?: string;
    osm_key?: string;
    osm_value?: string;
  };
}

/**
 * Map a Photon geocoding feature to a SearchResult, or null when the feature
 * has no usable point geometry or name. The label collects the address parts
 * that aren't already the name, most specific first.
 */
export function photonFeatureToSearchResult(feature: PhotonFeature): SearchResult | null {
  const [lng, lat] = feature.geometry?.coordinates ?? [];
  if (typeof lng !== 'number' || typeof lat !== 'number') return null;

  const p = feature.properties ?? {};
  const street = p.street && p.housenumber ? `${p.street} ${p.housenumber}` : p.street;
  const name = p.name || street;
  if (!name) return null;

  const labelParts: string[] = [];
  for (const part of [street, p.city, p.state, p.country]) {
    if (part && part !== name && !labelParts.includes(part)) labelParts.push(part);
  }

  return {
    name,
    label: labelParts.join(', '),
    position: { lat, lng },
    kind: p.osm_key && p.osm_value ? `${p.osm_key}/${p.osm_value}` : undefined,
  };
}

/**
 * Substitute the `{origin}` placeholders in a self-hosted map style template
 * (see infrastructure/tiles/fetch-map-assets.sh) with the actual origin the
 * app is served from, e.g. `https://atlas.gjessing.io` or a dev server.
 */
export function resolveStyleTemplate(template: string, origin: string): string {
  return template.replaceAll('{origin}', origin);
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
