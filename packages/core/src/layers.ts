/** Overlay layer catalog: the client-side layer registry and its map style. */

import type { LatLng } from './geo.js';
import type { LngLatBbox } from './geoproject.js';

/** Live Regobs ice observations, drawn as viewport-fetched point markers. */
export const ICE_OBSERVATIONS_ID = 'ice-observations';

export type IceObservationKind = 'open-water' | 'danger' | 'ice' | 'observation';
export type IceObservationAge = 'fresh' | 'recent' | 'older' | 'stale';

/** Display-ready properties carried by every live ice-observation point. */
export interface IceObservationProperties {
  regId: number;
  kind: IceObservationKind;
  label: string;
  observedAt: string;
  observer?: string;
  summary?: string;
  age: IceObservationAge;
  markerColor: string;
  symbol: string;
  sourceUrl: string;
}

export interface IceObservationFeature {
  type: 'Feature';
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties: IceObservationProperties;
}

export interface IceObservationsResponse {
  type: 'FeatureCollection';
  features: IceObservationFeature[];
}

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

/** One selectable value of a `LayerOption`. */
export interface LayerOptionChoice {
  /** Stored and sent to the backend. Restricted to `[a-z0-9-]` (see LayerOption). */
  value: string;
  label: string;
  /**
   * One line saying what picking this actually changes. The picker is the only
   * place a layer can teach what it is tuned for, so a choice that needs no
   * explanation is a sign the option itself is unclear.
   */
  caption?: string;
}

/**
 * A per-layer variant the user picks in the panel — the species a wildlife
 * layer draws, and (next) the target a derived potential surface is tuned for.
 *
 * Generic on purpose: options are declared as data in the backend catalog,
 * carried in the tile URL, and rendered as chips by both clients, so the next
 * layer that needs a variant needs no second mechanism. The client never
 * invents a value: everything it can send is listed here, which is also what
 * makes the value safe to use in a cache path (see `layerOptionSignature`).
 */
export interface LayerOption {
  /** Query-parameter and setting key, e.g. `species`. `[a-z0-9-]` only. */
  key: string;
  label: string;
  /** Used when the device has never chosen, and for any value not listed. */
  defaultValue: string;
  choices: LayerOptionChoice[];
}

/**
 * Resolve a device's stored choices against a layer's declared options: one
 * entry per option, unknown keys dropped and unknown values replaced by the
 * default. Both clients and the backend run untrusted input through this, so
 * the result only ever contains values the catalog itself declared.
 */
export function normalizeLayerOptions(
  options: readonly LayerOption[] | undefined,
  chosen: Readonly<Record<string, string | undefined>> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const option of options ?? []) {
    const want = chosen?.[option.key];
    out[option.key] = option.choices.some((c) => c.value === want) ? want! : option.defaultValue;
  }
  return out;
}

/**
 * A short, stable string identifying a set of resolved option values — used as
 * a disk-cache path segment on the backend and as part of the map source id on
 * both clients, so switching species swaps the source instead of quietly
 * reusing the old tiles.
 *
 * Safe as a path segment only because `normalizeLayerOptions` has already
 * reduced the values to declared choices; never build one from raw query input.
 */
export function layerOptionSignature(values: Readonly<Record<string, string>>): string {
  return Object.keys(values)
    .sort()
    .map((key) => `${key}-${values[key]}`)
    .join('_');
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
  /**
   * Variants the user picks per device (see `LayerOption`). A layer without
   * options behaves exactly as before — every helper here no-ops on `undefined`,
   * so an older client simply gets the layer's default variant.
   */
  options?: LayerOption[];
  /**
   * Present when this layer is a **derived potential surface** (ROADMAP § N5):
   * its tiles come from the derive service at `/api/potential/…`, keyed by the
   * layer's `target` option, rather than from the overlay proxy. `overlayTileUrl`
   * is the one place that branches on it, so a client that renders catalog rows
   * needs no second code path.
   *
   * It carries the ramp because a derived surface's colours are the model's
   * opinion, not the panel's: shipping the words and the swatches together as
   * data keeps two clients from disagreeing about what "Promising water" looks
   * like, and lets the vocabulary change (a fisher casts, a hunter looks)
   * without a client release.
   */
  derived?: {
    /**
     * Which language the surface speaks — a fisher casts, a hunter looks. It
     * mirrors `@atlas/potential`'s `SurfaceVocabulary`, restated here because
     * core sits below the engine and must not depend on it.
     */
    vocabulary: 'fishing' | 'hunt';
    /** The ramp, coolest first. */
    legend: { key: string; label: string; color: string }[];
  };
}

/** GET /api/layers */
export interface LayersResponse {
  layers: LayerMeta[];
}

/** The `&key=value` tail a layer's resolved options add to a proxy URL. */
function optionQuery(
  meta: Pick<LayerMeta, 'options'>,
  chosen: Readonly<Record<string, string | undefined>> | undefined,
): string {
  const values = normalizeLayerOptions(meta.options, chosen);
  return Object.entries(values)
    .map(([key, value]) => `&${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('');
}

/**
 * Cache-revisioned raster URL used by web and Android.
 *
 * A derived layer is served by the derive service instead, with its target in
 * the path and **no cache-busting parameter**: re-deriving a cell rewrites the
 * same URL, and that route answers `no-cache` with a content ETag so the client
 * revalidates rather than being pinned to a surface that has since been rebuilt.
 */
export function overlayTileUrl(
  origin: string,
  meta: Pick<LayerMeta, 'id' | 'rev' | 'options' | 'derived'>,
  chosen?: Readonly<Record<string, string | undefined>>,
): string {
  // `rev ?? 1` keeps an Android client's last cached pre-revision catalog
  // usable during an offline start immediately after upgrading.
  const rev = Number.isInteger(meta.rev) && meta.rev > 0 ? meta.rev : 1;
  if (meta.derived) {
    const target = normalizeLayerOptions(meta.options, chosen)['target'] ?? '';
    return (
      `${origin}/api/potential/${encodeURIComponent(meta.id)}/${encodeURIComponent(target)}` +
      `/{z}/{x}/{y}.png`
    );
  }
  return (
    `${origin}/api/overlay/${encodeURIComponent(meta.id)}/{z}/{x}/{y}.png` +
    `?v=${encodeURIComponent(String(rev))}${optionQuery(meta, chosen)}`
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
 * Cache-revisioned, viewport-scoped URL for live Regobs ice observations.
 *
 * Unlike the curated vector overlays above, this is a rolling observation feed:
 * fetching all of Norway would be both slow and stale immediately. Both clients
 * derive the same bbox from their settled camera and hand the response straight
 * to a GeoJSON source.
 */
export function iceObservationsUrl(
  origin: string,
  meta: Pick<LayerMeta, 'id' | 'rev'>,
  bbox: LngLatBbox,
): string {
  const rev = Number.isInteger(meta.rev) && meta.rev > 0 ? meta.rev : 1;
  return (
    `${origin}/api/overlay/${encodeURIComponent(meta.id)}/features` +
    `?bbox=${bbox.join(',')}&v=${encodeURIComponent(String(rev))}`
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

/**
 * The identify endpoint for one overlay at one point. `origin` is '' on the web.
 *
 * The layer's options ride along so a tap answers for what is actually drawn:
 * a wildlife layer filtered to big game must not answer with the seabird area
 * underneath, or the filter reads as a lie.
 */
export function overlayIdentifyUrl(
  origin: string,
  meta: Pick<LayerMeta, 'id' | 'options'>,
  at: LatLng,
  zoom: number,
  chosen?: Readonly<Record<string, string | undefined>>,
): string {
  return (
    `${origin}/api/overlay/${encodeURIComponent(meta.id)}/identify` +
    `?lat=${at.lat}&lng=${at.lng}&zoom=${Math.round(zoom)}${optionQuery(meta, chosen)}`
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
  /** The device's chosen options per layer id, for layers that declare any. */
  optionsFor?: (meta: LayerMeta) => Record<string, string> | undefined,
): Promise<OverlayIdentifyGroup[]> {
  const targets = visible.filter((meta) => meta.identify);
  if (targets.length === 0) return [];
  const settled = await Promise.allSettled(
    targets.map(async (meta): Promise<OverlayIdentifyGroup[]> => {
      const res = await fetch(overlayIdentifyUrl(origin, meta, at, zoom, optionsFor?.(meta)));
      if (!res.ok) return [];
      const body = (await res.json()) as OverlayIdentifyResponse;
      return body.results.map((properties) => ({ title: meta.title, properties }));
    }),
  );
  return settled.flatMap((s) => (s.status === 'fulfilled' ? s.value : []));
}

/** Trimmed string, or null for anything that is not usable text. */
function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/**
 * Regobs timestamps carry the observer's local offset. Preserve the date and
 * clock they submitted rather than silently converting it to the viewer's
 * timezone — the timestamp is evidence about the observation, not a countdown.
 */
export function formatIceObservationTime(value: unknown): string | null {
  const text = str(value);
  if (!text) return null;
  const iso = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})?/.exec(
    text,
  );
  return iso ? `${iso[1]} ${iso[2]}${iso[3] ? ` ${iso[3]}` : ''}` : text;
}

/**
 * A tapped Regobs marker as a shared identify group. The marker's shape says
 * report type, its colour says age, and this card supplies the exact submitted
 * date/time plus the useful human context.
 */
export function iceObservationIdentify(
  properties: Record<string, unknown> | null | undefined,
): OverlayIdentifyGroup | null {
  if (!properties) return null;
  const observed = formatIceObservationTime(properties['observedAt']);
  if (!observed) return null;
  const rows: Record<string, string> = {
    Observed: observed,
    Type: str(properties['label']) ?? 'Ice observation',
  };
  const observer = str(properties['observer']);
  const summary = str(properties['summary']);
  const source = str(properties['sourceUrl']);
  if (observer) rows['Observer'] = observer;
  if (summary) rows['Details'] = summary;
  if (source) rows['Regobs'] = source;
  return { title: str(properties['label']) ?? 'Ice observation', properties: rows };
}

/**
 * A tapped Statskog *jaktfelt* polygon as an identify group: the field's name
 * is the heading, the species it is opened for and Statskog's remarks are the
 * rows.
 *
 * Both clients draw this coverage themselves, so the answer is a local
 * hit-test rather than a server round trip — but *what the answer says* is one
 * thing, here, rather than a popup builder on web and a group builder on
 * Android that agreed only by accident.
 */
export function huntingFieldIdentify(
  properties: Record<string, unknown> | null | undefined,
): OverlayIdentifyGroup | null {
  if (!properties) return null;
  const rows: Record<string, string> = {};
  const species = str(properties['Art']);
  const remarks = str(properties['Merknad']);
  if (species) rows['Species'] = species;
  if (remarks) rows['Remarks'] = remarks;
  return { title: str(properties['Feltnavn']) ?? 'Hunting field', properties: rows };
}

/**
 * A tapped ATK camera as an identify group. The heading says *which kind* of
 * enforcement it is, because a fixed camera and an average-speed section are
 * driven differently; the row is Vegvesen's own name for it.
 */
export function speedCameraIdentify(
  properties: Record<string, unknown> | null | undefined,
): OverlayIdentifyGroup | null {
  if (!properties) return null;
  const name = str(properties['name']);
  return {
    title: properties['kind'] === 'point' ? 'Speed camera' : 'Average speed control',
    properties: name ? { Name: name } : {},
  };
}

/**
 * How much of an identify answer a place card shows: at most this many
 * overlays, and this many attributes from each.
 *
 * The caps live here rather than in the two cards because they had drifted —
 * Android showed 3 × 6, the web popup 4 × 8, so the same tap on the same lake
 * described it differently depending on the device. A cap is a layout decision,
 * but *which* cap is a product one, and there is only one product.
 */
export const IDENTIFY_CARD_GROUPS = 3;
export const IDENTIFY_CARD_ROWS = 6;

/** One overlay's answer, cut to what a card has room for. */
export interface IdentifyCardGroup {
  readonly title: string;
  /** `[label, value]` pairs in the upstream's own order. */
  readonly rows: readonly (readonly [string, string])[];
}

/**
 * The identify answers a place card should render, capped and flattened.
 *
 * A group with no rows is kept, not dropped: the heading is often the whole
 * answer — an unnamed ATK site is still "Speed camera", and a hunting field
 * with no remarks is still that field.
 */
export function identifyCardGroups(
  groups: readonly OverlayIdentifyGroup[],
): readonly IdentifyCardGroup[] {
  return groups.slice(0, IDENTIFY_CARD_GROUPS).map((group) => ({
    title: group.title,
    rows: Object.entries(group.properties).slice(0, IDENTIFY_CARD_ROWS) as (readonly [
      string,
      string,
    ])[],
  }));
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
 *
 * Every field is optional because the map records only what the user has
 * actually said. Visibility and opacity are keyed per profile
 * (`<profile>:<layer>`) while a layer's `options` are keyed by the bare layer
 * id — a variant belongs to the layer, not to the activity you view it in — so
 * an entry can genuinely carry a chosen species and nothing else. Writing a
 * fabricated `on: false` alongside it would switch the layer off in any profile
 * that has it on by default.
 */
export type OverlayStateMap = Record<
  string,
  { on?: boolean; opacity?: number; options?: Record<string, string> }
>;
