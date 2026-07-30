/**
 * Places: their styling, folder visibility rollup, and the place card — one
 * card for pins, saved places, POIs and search hits.
 */

import { haversineM, type LatLng } from './geo.js';
import { fmtCoords, fmtDistanceM } from './format.js';
import type { OverlayIdentifyGroup } from './layers.js';

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

/** Where the thing the card is describing came from. */
export type PlaceSource = 'pin' | 'place' | 'poi' | 'search';

/**
 * The subject of a place card, normalised across the four ways a user can
 * point at somewhere: a dropped pin, a saved place, a POI tapped on the map,
 * and a picked search result.
 *
 * Everything downstream (title, subtitle, which actions apply) is derived from
 * this one shape, which is the point — before it, web had three ad-hoc popups
 * that offered different actions for the same underlying "a spot on the map".
 */
export interface PlaceTarget {
  source: PlaceSource;
  position: LatLng;
  /** Display name. Absent only for a bare dropped pin, where coordinates stand in. */
  name?: string;
  /** Category or address line shown under the name. */
  category?: string;
  /** Postal/street address, kept distinct from a POI category. */
  address?: string;
  /** Set when the target *is* a saved place — the card then offers Edit, not Save. */
  placeId?: string;
  /** Exact National Stop Register identity, when the target came from Entur search. */
  transitStopId?: string;
  /**
   * What the visible overlays say sits here (tap-to-identify: a lake's surveyed
   * depth, a parcel's number). Arrives *after* the card opens — the network
   * round trip must never delay the actions — so it is set on an existing
   * target rather than being part of what opens one.
   */
  identify?: readonly OverlayIdentifyGroup[];
}

/**
 * A readable category from OpenMapTiles POI feature properties, e.g.
 * `{class: 'restaurant', subclass: 'fast_food'}` → "Restaurant · Fast food".
 *
 * Underscores become spaces and only the first word is capitalised — these are
 * OSM tag values, not prose, and title-casing them ("Fast Food") reads like a
 * brand. A subclass equal to the class or to the name adds nothing and is dropped.
 */
export function poiCategoryLabel(
  props: Record<string, unknown>,
  name?: string,
): string | undefined {
  const humanise = (v: unknown): string | null => {
    if (typeof v !== 'string' || v.length === 0) return null;
    if (v === name) return null;
    const text = v.replaceAll('_', ' ');
    return text[0]!.toUpperCase() + text.slice(1);
  };
  const parts: string[] = [];
  for (const key of ['class', 'subclass']) {
    const part = humanise(props[key]);
    if (part && !parts.includes(part)) parts.push(part);
  }
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

/** What the card shows as its heading: the name, or the coordinates for a bare pin. */
export function placeTargetTitle(target: PlaceTarget): string {
  return target.name?.trim() || fmtCoords(target.position);
}

/**
 * The line under the heading: category and distance from a reference point
 * (the user's location, or the map centre), whichever of them exist. Empty
 * string when neither does — the caller can then skip the element entirely.
 */
export function placeTargetSubtitle(target: PlaceTarget, from?: LatLng | null): string {
  const parts: string[] = [];
  if (target.address) parts.push(target.address);
  if (target.category) parts.push(target.category);
  if (from) parts.push(`${fmtDistanceM(haversineM(from, target.position))} away`);
  return parts.join(' · ');
}

/**
 * The saved place at a position, if there is one — so a POI or pin the user has
 * already saved offers "Edit" instead of a second, duplicate "Save".
 *
 * Matching is by proximity rather than name: the same café is the same café
 * whether it was saved from a search hit, a POI tap or a dropped pin, and those
 * three routes rarely agree on a name. 30 m is wide enough to survive that
 * disagreement in position and narrow enough not to swallow the shop next door.
 */
export function savedPlaceAt<T extends { lat: number; lng: number }>(
  places: readonly T[],
  position: LatLng,
  radiusM = 30,
): T | undefined {
  let best: T | undefined;
  let bestM = radiusM;
  for (const place of places) {
    const d = haversineM(position, { lat: place.lat, lng: place.lng });
    if (d <= bestM) {
      best = place;
      bestM = d;
    }
  }
  return best;
}
