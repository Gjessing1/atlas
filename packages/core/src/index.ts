/**
 * `@atlas/core` — shared domain types and utilities, imported by both apps and
 * the backend.
 *
 * This file is the package's barrel and nothing else: every symbol lives in a
 * domain module beside it, and every consumer keeps importing from
 * `@atlas/core`. Add new shared concepts to the module they belong to (or a new
 * one re-exported here), not to this file — it used to be a 941-line catch-all,
 * which is how nine unrelated domains ended up sharing one test file.
 */

export const APP_NAME = 'Atlas';

export * from './api.js';
export * from './format.js';
export * from './explore.js';
export * from './geo.js';
export * from './inatur.js';
export * from './layers.js';
export * from './maphash.js';
export * from './nav-widgets.js';
export * from './packs.js';
export * from './places.js';
export * from './place-content.js';
export * from './profiles.js';
export * from './recent-searches.js';
export * from './routelabels.js';
export * from './search.js';
export * from './share.js';
export * from './wiki-language.js';

export {
  applyMapAppearance,
  DEFAULT_MAP_STYLE_OVERRIDES,
  isThemeMode,
  sanitizeMapStyleOverrides,
  type ColorScheme,
  type MapAppearance,
  type MapStyleOverrides,
  type ThemeMode,
} from './appearance.js';
export {
  bboxToUtm33,
  polygonLabelPoint,
  snapLabelBbox,
  viewportBbox,
  wgs84ToUtm33,
  OVERLAY_LABEL_SNAP_DEG,
  type LngLatBbox,
  type Ring,
} from './geoproject.js';
