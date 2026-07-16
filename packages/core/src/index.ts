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

/**
 * Offline region packs (Phase 6): pre-built per-region bundles the Android app
 * downloads for offline use. Built out-of-band by infrastructure/packs/
 * build-pack.sh into `<dataDir>/packs/<id>/` next to a `pack.json` manifest;
 * the backend lists manifests at /api/regions and serves the files under
 * /packs/<id>/<file> (range requests supported).
 */

/** One downloadable file inside a region pack; `path` is relative to the pack dir. */
export interface RegionPackFile {
  path: string;
  bytes: number;
}

export interface RegionPackManifest {
  id: string;
  /** Human-readable region name, e.g. "Oslo". */
  name: string;
  bbox: BBox;
  /** Monotonic content version — bump on rebuild so clients see updates. */
  version: number;
  /** Unix ms timestamp of the pack build. */
  builtAt: number;
  files: {
    /** Vector basemap, a .pmtiles archive (MapLibre Native reads it via pmtiles://file://…). */
    basemap?: RegionPackFile;
    /** Offline search database: SQLite with an FTS5 `places` index. */
    search?: RegionPackFile;
    /** Offline routing tiles: a Valhalla tile extract (.tar, read in place). */
    routing?: RegionPackFile;
    /** Map assets (glyphs + sprites) as a zip, for offline label/icon rendering. */
    assets?: RegionPackFile;
  };
}

/** GET /api/regions */
export interface RegionsResponse {
  regions: RegionPackManifest[];
}

/**
 * GET /api/app/version — newest Android APK available for self-update.
 * Backed by `<dataDir>/app/version.json` + the .apk it names.
 */
export interface AppVersionResponse {
  /** Android versionCode — monotonic integer clients compare against their own. */
  versionCode: number;
  /** Human-readable version, e.g. "0.2.0". */
  versionName: string;
  /** Server-relative URL of the APK, e.g. "/app/atlas-0.2.0.apk". */
  apkUrl: string;
  bytes: number;
}

// ---- Place styling (favorites/pins icons + colors) ----

/**
 * The colour palette offered for places/pins. Stored on each place as the hex
 * string itself (rendering stays a trivial `['get','color']`); the palette here
 * is only what the pickers present. Shared so web and Android show one set.
 */
export const PLACE_COLORS = [
  '#e11d48', // red
  '#f97316', // orange
  '#f59e0b', // amber
  '#16a34a', // green
  '#0d9488', // teal
  '#2563eb', // blue
  '#7c3aed', // violet
  '#db2777', // pink
  '#475569', // slate
] as const;

/** Emoji icons offered for places/pins (stored verbatim as the place's icon). */
export const PLACE_ICONS = [
  '📍',
  '⭐',
  '🏠',
  '🏢',
  '🍽️',
  '☕',
  '🏔️',
  '🏕️',
  '🏖️',
  '🅿️',
  '⛽',
  '⚠️',
  '❤️',
  '🎣',
  '🚲',
  '🐟',
] as const;

/** Defaults for a freshly saved place (also the storage column defaults). */
export const DEFAULT_PLACE_COLOR = '#e11d48';
export const DEFAULT_PLACE_ICON = '📍';

// ---- Place / folder visibility (hide/show on the map) ----

/** Minimal folder shape for visibility resolution — folders nest via `parentId`. */
export interface VisibilityFolder {
  parentId: string | null;
  visible: boolean;
}

/**
 * Whether a folder is effectively visible: false if it or any ancestor folder
 * is hidden. Unknown ids (dangling parents) are treated as visible. Guards
 * against cyclic parent chains.
 */
export function collectionIsVisible(
  id: string | null,
  folders: ReadonlyMap<string, VisibilityFolder>,
): boolean {
  const seen = new Set<string>();
  let cur = id;
  while (cur !== null) {
    if (seen.has(cur)) break; // defensive: never loop on a cyclic chain
    seen.add(cur);
    const folder = folders.get(cur);
    if (!folder) break; // dangling parent — treat the rest of the chain as shown
    if (!folder.visible) return false;
    cur = folder.parentId;
  }
  return true;
}

/**
 * Effective visibility of a place on the map: hidden when its own flag is off,
 * or when any folder in its collection ancestry is hidden.
 */
export function placeIsVisible(
  place: { visible: boolean; collectionId: string | null },
  folders: ReadonlyMap<string, VisibilityFolder>,
): boolean {
  return place.visible && collectionIsVisible(place.collectionId, folders);
}
