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

/**
 * A route plan in shareable form: the stops the user placed, not the routed
 * geometry — the recipient re-routes them. Stop labels are deliberately left
 * out; they would dominate the URL and the coordinates are the plan.
 *
 * `profile` stays a plain string here because core knows nothing about the
 * routing engine; the app validates it against its own profile list.
 */
export interface RoutePlanState {
  profile: string;
  points: LatLng[];
  /** Round-trip loop length in km — set only for a one-anchor loop plan. */
  roundTripKm?: number;
}

/** Shareable map view: camera position, an optional dropped pin, an optional route plan. */
export interface MapViewState {
  center: LatLng;
  zoom: number;
  pin?: LatLng;
  route?: RoutePlanState;
}

const round = (n: number, decimals: number): number => {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
};

/**
 * Encode a map view as a URL hash, e.g. `#map=12.3/59.91384/10.75234` with an
 * optional `&pin=<lat>/<lng>` and an optional
 * `&route=<profile>/<lat>,<lng>/<lat>,<lng>…` (plus `&loop=<km>` for a round
 * trip). Coordinates keep 5 decimals (~1 m).
 */
export function encodeMapHash(state: MapViewState): string {
  const c = state.center;
  let hash = `#map=${round(state.zoom, 2)}/${round(c.lat, 5)}/${round(c.lng, 5)}`;
  if (state.pin) hash += `&pin=${round(state.pin.lat, 5)}/${round(state.pin.lng, 5)}`;
  const plan = state.route;
  if (plan && plan.points.length > 0 && /^[a-z_-]+$/.test(plan.profile)) {
    const points = plan.points.map((p) => `${round(p.lat, 5)},${round(p.lng, 5)}`).join('/');
    hash += `&route=${plan.profile}/${points}`;
    if (plan.roundTripKm !== undefined) hash += `&loop=${round(plan.roundTripKm, 2)}`;
  }
  return hash;
}

/** Parse the `&route=…`/`&loop=…` part of a hash; null when absent/malformed. */
function decodeRoutePlan(hash: string): RoutePlanState | null {
  const match = /[#&]route=([a-z_-]+)((?:\/-?[0-9.]+,-?[0-9.]+)+)/.exec(hash);
  if (!match) return null;
  const points: LatLng[] = [];
  for (const pair of match[2]!.split('/').filter(Boolean)) {
    const [lat, lng] = pair.split(',').map(Number);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    points.push({ lat: lat!, lng: lng! });
  }
  if (points.length === 0) return null;

  const plan: RoutePlanState = { profile: match[1]!, points };
  const loopMatch = /[#&]loop=([0-9.]+)/.exec(hash);
  if (loopMatch) {
    const km = Number(loopMatch[1]);
    // A loop has exactly one anchor; more points mean the link is inconsistent,
    // and the ordinary A→B→C reading of them is the safer one.
    if (Number.isFinite(km) && km > 0 && points.length === 1) plan.roundTripKm = km;
  }
  return plan;
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
  const plan = decodeRoutePlan(hash);
  if (plan) state.route = plan;
  return state;
}

/**
 * Parse a full shared/deep-link URL into a map view. Accepts every form Atlas
 * produces or registers: `https://…/#map=…` (web share links) and
 * `atlas://map=…` / `atlas:#map=…` (the Android scheme). Null when the URL
 * carries no `map=` fragment.
 */
export function decodeMapLink(url: string): MapViewState | null {
  const hashIndex = url.indexOf('#');
  // No explicit hash: treat everything after the scheme as the fragment, so
  // `atlas://map=…` parses like `#map=…`.
  const hash = hashIndex >= 0 ? url.slice(hashIndex) : '#' + url.replace(/^[a-z+.-]+:\/{0,2}/i, '');
  return decodeMapHash(hash);
}

/**
 * Layer ids of the OpenFreeMap Liberty style that render the OpenMapTiles
 * `poi` source layer — the tap/click targets for POI info popups. Shared so
 * web and Android query the same set (see infrastructure/tiles/fetch-map-assets.sh).
 */
export const POI_LAYER_IDS = ['poi_r20', 'poi_r7', 'poi_r1', 'poi_transit'];

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

/**
 * Parse a search query that is nothing but a coordinate pair, in decimal
 * degrees: "59.9139, 10.7522", "59.9139 10.7522", optional hemisphere letters
 * before or after each number ("N 59.9139 E 10.7522", "59.9139S, 10.7522W")
 * and optional degree signs. Latitude always comes first. Null when the text
 * isn't a pure coordinate pair or is out of range — geocoding proceeds then.
 */
export function parseCoordinateQuery(text: string): LatLng | null {
  const m =
    /^\s*([NS])?\s*([+-]?\d{1,3}(?:[.,]\d+)?)\s*°?\s*([NS])?\s*[,;\s]\s*([EW])?\s*([+-]?\d{1,3}(?:[.,]\d+)?)\s*°?\s*([EW])?\s*$/i.exec(
      text,
    );
  if (!m) return null;
  const [, latPre, latRaw, latPost, lngPre, lngRaw, lngPost] = m;
  // At most one hemisphere letter per number (prefix or suffix, not both).
  if ((latPre && latPost) || (lngPre && lngPost)) return null;
  const hemi = (raw: string, letter: string | undefined, negative: string): number | null => {
    const value = Number(raw.replace(',', '.'));
    if (!Number.isFinite(value)) return null;
    if (!letter) return value;
    if (value < 0) return null; // "-59.9 S" is contradictory
    return letter.toUpperCase() === negative ? -value : value;
  };
  const lat = hemi(latRaw!, latPre || latPost, 'S');
  const lng = hemi(lngRaw!, lngPre || lngPost, 'W');
  if (lat === null || lng === null) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

/**
 * The SearchResult for a query parsed by {@link parseCoordinateQuery} — shared
 * so web and Android present typed-in coordinates identically.
 */
export function coordinateSearchResult(p: LatLng): SearchResult {
  return {
    name: `${round(p.lat, 5)}, ${round(p.lng, 5)}`,
    label: 'Coordinates',
    position: { lat: p.lat, lng: p.lng },
  };
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
 * Match saved places against a search query — the route planner's stop search
 * shows these alongside geocoder results so a favorite can be picked directly
 * as a stop. Case-insensitive; whole-name prefix matches rank first, then
 * word-prefix and substring matches, in the input order.
 */
export function matchPlacesByName<T extends { name: string }>(
  places: T[],
  query: string,
  limit = 5,
): T[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return [];
  const prefix: T[] = [];
  const rest: T[] = [];
  for (const place of places) {
    const name = place.name.toLowerCase();
    if (name.startsWith(q)) prefix.push(place);
    else if (name.includes(q)) rest.push(place);
  }
  return [...prefix, ...rest].slice(0, limit);
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

// ---- Overlay layer catalog (backend layer registry + WMS proxy) ----

/**
 * One overlay layer as the client sees it. This is the *stripped* public
 * shape: upstream URLs, WMS layer names, versions and tokens stay on the
 * backend (the Layer → LayerMeta split) — clients only ever talk to
 * `/api/overlay/:id/…`.
 */
export interface LayerMeta {
  id: string;
  title: string;
  /** One-line description shown in the layer panel. */
  description: string;
  /** Panel group heading ("Terrain", "Water & depth", …). */
  group: string;
  /** Attribution shown on the map while the layer is visible. */
  attribution: string;
  /** Source/metadata link (Geonorge kartkatalog) for the panel. */
  metadataUrl?: string;
  /** Below this zoom the upstream draws nothing useful — clients skip requests and show a zoom hint. */
  minzoom?: number;
  /** Request cap: the map overzooms beyond it instead of hitting the upstream. */
  maxzoom: number;
  /** Default raster opacity (user-adjustable per device). */
  defaultOpacity: number;
  /** Whether `/api/overlay/:id/identify` answers tap-to-identify queries. */
  identify: boolean;
  /** Coverage caveat surfaced in the panel ("blank ≠ broken"). */
  coverageNote?: string;
  /** Activity profiles this layer belongs to (absent = general purpose). */
  profiles?: string[];
}

/** GET /api/layers */
export interface LayersResponse {
  layers: LayerMeta[];
}

/**
 * GET /api/overlay/:id/identify — cleaned upstream attributes per feature
 * (noise keys filtered by the backend). Values are display-ready strings.
 */
export interface OverlayIdentifyResponse {
  results: Record<string, string>[];
}

/**
 * Per-device overlay panel state, stored as JSON under the device-local
 * setting `local.layers.state` (never syncs — like all `local.` keys).
 */
export type OverlayStateMap = Record<string, { on: boolean; opacity?: number }>;

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

// ---- System status (GET /api/status) ----

/**
 * Health of one upstream Atlas depends on. `ok` = last probe succeeded;
 * `degraded` = currently failing but has worked before (usually serving a
 * stale/cached copy); `down` = failing and never succeeded this run;
 * `unknown` = not probed yet (no real traffic has exercised it).
 */
export type UpstreamHealth = 'ok' | 'degraded' | 'down' | 'unknown';

/**
 * One upstream service or data source. Probes piggyback on real proxy traffic
 * (recorded in the proxy layer) rather than active polling, so `unknown` simply
 * means nothing has touched it since boot — not that it is broken.
 */
export interface UpstreamStatus {
  id: string;
  label: string;
  /** Display grouping, e.g. "Routing", "Overlays". */
  group: string;
  health: UpstreamHealth;
  /** Epoch ms of the last successful probe, or null. */
  lastSuccess: number | null;
  /** Epoch ms of the last failed probe, or null. */
  lastFailure: number | null;
  /** Last failure message (upstream error / HTTP status), or null. */
  message: string | null;
  /** Extra context, e.g. "map data from 2026-07-12", "3 archives". */
  detail: string | null;
}

/**
 * GET /api/status — per-upstream health for the settings/status page. Answers
 * "why is this blank?" without SSHing into the box.
 */
export interface SystemStatus {
  app: string;
  gitSha: string;
  /** Epoch ms this snapshot was taken. */
  generatedAt: number;
  /** Worst health across all sources (unknown sources don't drag it down). */
  overall: UpstreamHealth;
  sources: UpstreamStatus[];
}

// ---- Point elevation (GET /api/elevation) ----

/**
 * GET /api/elevation?lat=..&lon=.. — terrain height at a single point, proxied
 * from Kartverket's Høydedata point service. Enriches a dropped pin / saved
 * place without any raster pipeline. `elevationM` is null outside coverage
 * (Norway only — the point is on the sea or off the national model).
 */
export interface ElevationResponse {
  /** Metres above sea level, or null when the point has no coverage. */
  elevationM: number | null;
  /** Upstream data source label (e.g. "Nasjonal høydemodell"), when given. */
  source?: string;
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
  '⛺',
  '🌲',
  '🍄',
  '🦌',
  '🎿',
  '🛶',
  '🏊',
  '⚓',
  '🚉',
  '✈️',
  '🏥',
  '🛒',
  '🏫',
  '⛪',
  '📷',
  '🔧',
] as const;

/** Defaults for a freshly saved place (also the storage column defaults). */
export const DEFAULT_PLACE_COLOR = '#e11d48';
export const DEFAULT_PLACE_ICON = '📍';

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

// ---- Units & clock (Atlas is metric / 24-hour everywhere) ----

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
 * Clock time as HH:MM, 24-hour, always — in the device's local timezone.
 *
 * Hand-formatted rather than via toLocaleTimeString: an en-US device renders
 * AM/PM in nav banners and ETAs, and `hour12: false` is not a reliable fix —
 * some ICU builds return "24:05" for midnight, and Hermes ships its own Intl.
 * Atlas is 24-hour everywhere, so this must not depend on locale or engine.
 */
export function fmtClock(epochMs: number): string {
  const d = new Date(epochMs);
  const pad = (n: number) => `${n}`.padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Short weekday plus 24-hour clock, e.g. "Sat 18:00" — for forecast steps that
 * span more than a day. The weekday stays locale-derived (it is a translatable
 * word, not a number format); only the time is pinned.
 */
export function fmtDayClock(epochMs: number): string {
  const weekday = new Date(epochMs).toLocaleDateString([], { weekday: 'short' });
  return `${weekday} ${fmtClock(epochMs)}`;
}

// ---- Map profiles (per-activity map setup) ----

/**
 * A curated activity profile: what the user is doing on the map right now.
 *
 * Deliberately a short fixed list, not a settings tree — the point is a one-tap
 * switch. A profile chooses the *default* travel mode for new routes and
 * decides which contextual overlays are offered; the route planner still shows
 * every travel mode, so a profile never traps the user.
 *
 * `routing` stays a plain string for the same reason `RoutePlanState.profile`
 * does: core knows nothing about the routing engine, and the app narrows it
 * with `isRoutingProfile` before any request goes out. `null` means the profile
 * expresses no opinion (Explore) or the engine has no matching costing (Ski).
 */
export interface MapProfile {
  id: string;
  label: string;
  icon: string;
  routing: string | null;
  /**
   * `LayerMeta.profiles` tags this profile surfaces. Kept explicit rather than
   * matching on `id`, because the two vocabularies genuinely differ — the
   * hiking layers are tagged `hiking` while the travel mode is `hike`, and
   * `bike` lining up on both sides is a coincidence, not a rule.
   */
  layerTags: string[];
}

export const MAP_PROFILES: readonly MapProfile[] = [
  { id: 'explore', label: 'Explore', icon: '🧭', routing: null, layerTags: [] },
  { id: 'drive', label: 'Drive', icon: '🚗', routing: 'car', layerTags: [] },
  { id: 'bike', label: 'Cycle', icon: '🚲', routing: 'bike', layerTags: ['bike'] },
  { id: 'hike', label: 'Hike', icon: '🥾', routing: 'hike', layerTags: ['hiking'] },
  { id: 'ski', label: 'Ski', icon: '⛷️', routing: null, layerTags: ['ski'] },
];

/** The profile Atlas starts in, and the fallback for an unknown stored id. */
export const DEFAULT_MAP_PROFILE = 'explore';

/** Narrow an untrusted string (a stored setting, a share link) to a known profile. */
export function isMapProfile(value: unknown): value is string {
  return typeof value === 'string' && MAP_PROFILES.some((p) => p.id === value);
}

/** Look up a profile by id, falling back to the default for anything unknown. */
export function mapProfile(id: string): MapProfile {
  return MAP_PROFILES.find((p) => p.id === id) ?? MAP_PROFILES[0]!;
}

/**
 * Whether an overlay belongs in the panel for a profile.
 *
 * Untagged layers are general purpose and always offered. A tagged layer is
 * contextual and stays hidden until its profile is picked — that is what keeps
 * the catalog short, and it is why Wave 2 layers carry tags at all.
 */
export function layerInProfile(meta: Pick<LayerMeta, 'profiles'>, profileId: string): boolean {
  if (!meta.profiles || meta.profiles.length === 0) return true;
  const tags = mapProfile(profileId).layerTags;
  return meta.profiles.some((tag) => tags.includes(tag));
}

/** The catalog narrowed to a profile, keeping the server's display order. */
export function layersForProfile(catalog: readonly LayerMeta[], profileId: string): LayerMeta[] {
  return catalog.filter((meta) => layerInProfile(meta, profileId));
}
