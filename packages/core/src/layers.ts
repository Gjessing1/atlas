/** Overlay layer catalog: the client-side layer registry and its map style. */

import type { LatLng } from './geo.js';

/**
 * Layer ids of the OpenFreeMap Liberty style that render the OpenMapTiles
 * `poi` source layer — the tap/click targets for POI info popups. Shared so
 * web and Android query the same set (see infrastructure/tiles/fetch-map-assets.sh).
 *
 * `atlas-outdoor-poi` is Atlas's own layer (`applyMapAppearance`), included
 * because the cabins, shelters and ramps it draws are *handed over* to it — the
 * base layers filter those subclasses out, so without this a cabin would be the
 * one POI on the map you could see but not tap. It only exists on the outdoor
 * profiles; both call sites tolerate an absent layer id.
 */
export const POI_LAYER_IDS = ['poi_r20', 'poi_r7', 'poi_r1', 'poi_transit', 'atlas-outdoor-poi'];

/**
 * Substitute the `{origin}` placeholders in a self-hosted map style template
 * (see infrastructure/tiles/fetch-map-assets.sh) with the actual origin the
 * app is served from, e.g. `https://atlas.gjessing.io` or a dev server.
 */
export function resolveStyleTemplate(template: string, origin: string): string {
  return template.replaceAll('{origin}', origin);
}

/**
 * Where the backend serves the outdoor overlay archive
 * (infrastructure/tiles/outdoor-schema.yml), as a MapLibre tile template.
 *
 * Safe to hand to `applyMapAppearance` unconditionally: the route answers 204
 * for an archive that has not been built, and never falls back to basemap
 * tiles (`OVERLAY_AREAS` in backend/src/tiles-api.ts), so a server without one
 * simply renders no outdoor overlay.
 */
export function outdoorTilesUrl(origin: string): string {
  return `${origin}/api/tiles/outdoor/{z}/{x}/{y}.pbf`;
}

/**
 * One overlay layer as the client sees it. This is the *stripped* public
 * shape: upstream URLs, WMS layer names, versions and tokens stay on the
 * backend (the Layer → LayerMeta split) — clients only ever talk to
 * `/api/overlay/:id/…`.
 */
export interface LayerMeta {
  id: string;
  /**
   * Monotonic render revision. Bump whenever this layer's upstream, styles or
   * proxy rendering changes; clients append it to tile URLs and the backend
   * includes it in its disk-cache path, invalidating every cache in one move.
   */
  rev: number;
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
  /**
   * Present when the layer is vector data rather than raster tiles: clients
   * fetch its whole coverage once as GeoJSON from `/api/overlay/:id/features`
   * (see overlayFeaturesUrl) and style it client-side, keyed on the layer id.
   * Raster-only clients must not request tiles for these entries. Deployed
   * pre-vector bundles are safe by construction rather than by checking this
   * field: every vector layer is profile-tagged, and no profile in their core
   * carries those tags, so the entry never surfaces there.
   */
  vector?: boolean;
  /**
   * Present when `/api/overlay/:id/labels` can draw a number directly on the
   * map for this layer — the value a raster tile cannot show because it lives
   * in the upstream's attributes rather than its symbology (a lake's maximum
   * depth). Clients that render it fetch per viewport; clients that don't
   * simply ignore the field.
   */
  labels?: {
    /** Below this zoom the labels are too dense to read, so they are skipped. */
    minzoom: number;
    /** Unit suffix to draw after the number, e.g. "m". */
    unit: string;
  };
}

/** GET /api/layers */
export interface LayersResponse {
  layers: LayerMeta[];
}

/** Cache-revisioned raster URL used by web and Android. */
export function overlayTileUrl(origin: string, meta: Pick<LayerMeta, 'id' | 'rev'>): string {
  // `rev ?? 1` keeps an Android client's last cached pre-revision catalog
  // usable during an offline start immediately after upgrading.
  const rev = Number.isInteger(meta.rev) && meta.rev > 0 ? meta.rev : 1;
  return (
    `${origin}/api/overlay/${encodeURIComponent(meta.id)}/{z}/{x}/{y}.png` +
    `?v=${encodeURIComponent(String(rev))}`
  );
}

/**
 * Cache-revisioned GeoJSON URL for a vector overlay (`LayerMeta.vector`).
 * The whole coverage in one response — the vector layers are curated small
 * (hundreds of features), so viewport tiling would only add moving parts.
 */
export function overlayFeaturesUrl(origin: string, meta: Pick<LayerMeta, 'id' | 'rev'>): string {
  const rev = Number.isInteger(meta.rev) && meta.rev > 0 ? meta.rev : 1;
  return (
    `${origin}/api/overlay/${encodeURIComponent(meta.id)}/features` +
    `?v=${encodeURIComponent(String(rev))}`
  );
}

/**
 * GET /api/overlay/:id/identify — cleaned upstream attributes per feature
 * (noise keys filtered by the backend). Values are display-ready strings.
 */
export interface OverlayIdentifyResponse {
  results: Record<string, string>[];
}

/** One overlay's answer to "what is here?", ready for a client to render. */
export interface OverlayIdentifyGroup {
  /** The overlay's title — a single tap can hit several, so each answer says whose it is. */
  title: string;
  /** Cleaned, display-ready attributes (the backend has already dropped the noise). */
  properties: Record<string, string>;
}

/** The identify endpoint for one overlay at one point. `origin` is '' on the web. */
export function overlayIdentifyUrl(origin: string, id: string, at: LatLng, zoom: number): string {
  return (
    `${origin}/api/overlay/${encodeURIComponent(id)}/identify` +
    `?lat=${at.lat}&lng=${at.lng}&zoom=${Math.round(zoom)}`
  );
}

/**
 * Ask every identify-capable overlay what sits under a tap, in parallel.
 *
 * Overlays that are switched off are not asked, and an overlay that errors,
 * answers slowly-and-then-fails, or simply has nothing there contributes
 * nothing: most taps are navigation, not questions, so a failed identify must
 * never become an error the user has to dismiss. An empty array therefore means
 * "no answer", not "something went wrong".
 */
export async function identifyOverlays(
  origin: string,
  visible: readonly LayerMeta[],
  at: LatLng,
  zoom: number,
): Promise<OverlayIdentifyGroup[]> {
  const targets = visible.filter((meta) => meta.identify);
  if (targets.length === 0) return [];
  const settled = await Promise.allSettled(
    targets.map(async (meta): Promise<OverlayIdentifyGroup[]> => {
      const res = await fetch(overlayIdentifyUrl(origin, meta.id, at, zoom));
      if (!res.ok) return [];
      const body = (await res.json()) as OverlayIdentifyResponse;
      return body.results.map((properties) => ({ title: meta.title, properties }));
    }),
  );
  return settled.flatMap((s) => (s.status === 'fulfilled' ? s.value : []));
}

/**
 * GET /api/overlay/:id/labels?bbox=w,s,e,n — point labels to draw over the
 * raster, as GeoJSON so both maps can hand it straight to a symbol layer.
 */
export interface OverlayLabel {
  type: 'Feature';
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties: {
    /** Ready-to-draw text, unit included ("21.5 m"). */
    label: string;
    /** The bare number, for clients that want to restyle or filter. */
    value: number;
    /** Feature name where the upstream has one ("Verkensvannet"). */
    name?: string;
  };
}

export interface OverlayLabelsResponse {
  type: 'FeatureCollection';
  features: OverlayLabel[];
}

/**
 * Per-device overlay panel state, stored as JSON under the device-local
 * setting `local.layers.state` (never syncs — like all `local.` keys).
 */
export type OverlayStateMap = Record<string, { on: boolean; opacity?: number }>;
