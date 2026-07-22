/** Overlay layer catalog: the client-side layer registry and its map style. */

/**
 * Layer ids of the OpenFreeMap Liberty style that render the OpenMapTiles
 * `poi` source layer — the tap/click targets for POI info popups. Shared so
 * web and Android query the same set (see infrastructure/tiles/fetch-map-assets.sh).
 */
export const POI_LAYER_IDS = ['poi_r20', 'poi_r7', 'poi_r1', 'poi_transit'];

/**
 * Substitute the `{origin}` placeholders in a self-hosted map style template
 * (see infrastructure/tiles/fetch-map-assets.sh) with the actual origin the
 * app is served from, e.g. `https://atlas.gjessing.io` or a dev server.
 */
export function resolveStyleTemplate(template: string, origin: string): string {
  return template.replaceAll('{origin}', origin);
}

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

/**
 * GET /api/overlay/:id/identify — cleaned upstream attributes per feature
 * (noise keys filtered by the backend). Values are display-ready strings.
 */
export interface OverlayIdentifyResponse {
  results: Record<string, string>[];
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
