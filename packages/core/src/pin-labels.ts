/**
 * Pin labels: saved places drawn with their name under the pin, switched on per
 * folder or per tag.
 *
 * A pin alone says "something is here"; a group such as Family or Stands only
 * reads at a glance once each pin carries its name. Labelling every pin would
 * bury the map in text, and labelling one pin at a time is the chore this
 * exists to avoid — so the switch belongs to the *group*: a folder (and
 * everything under it, the same subtree rule a folder's visibility uses) or a
 * tag, across every folder that holds it.
 *
 * Stored as one synced setting rather than a column on the folder: a tag has
 * no record to carry a flag, and one mechanism for both keeps the rule in one
 * place. It is a view preference, so it travels in the settings half of an
 * export rather than on the records themselves.
 */

import { jsonSetting } from './persisted.js';

/** Which groups have their pins labelled. Tags compare case-insensitively. */
export interface PinLabelPrefs {
  readonly folders: readonly string[];
  readonly tags: readonly string[];
}

export const NO_PIN_LABELS: PinLabelPrefs = { folders: [], tags: [] };

const stringList = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
    : [];

/** Stored JSON → prefs; anything unusable reads as "nothing labelled". */
export function parsePinLabelPrefs(value: unknown): PinLabelPrefs | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  return { folders: stringList(raw['folders']), tags: stringList(raw['tags']) };
}

/** Synced: labelling Family on the laptop labels it on the phone. */
export const PIN_LABELS_SETTING = jsonSetting<PinLabelPrefs>({
  key: 'map.pinLabels',
  scope: 'synced',
  defaultValue: NO_PIN_LABELS,
  parse: parsePinLabelPrefs,
});

/** Whether this folder's own switch is on (not whether an ancestor's is). */
export function folderHasPinLabels(prefs: PinLabelPrefs, folderId: string): boolean {
  return prefs.folders.includes(folderId);
}

/** Whether this tag's switch is on, in any spelling. */
export function tagHasPinLabels(prefs: PinLabelPrefs, tag: string): boolean {
  const key = tag.trim().toLocaleLowerCase();
  return prefs.tags.some((candidate) => candidate.toLocaleLowerCase() === key);
}

export function toggleFolderPinLabels(prefs: PinLabelPrefs, folderId: string): PinLabelPrefs {
  return folderHasPinLabels(prefs, folderId)
    ? { ...prefs, folders: prefs.folders.filter((id) => id !== folderId) }
    : { ...prefs, folders: [...prefs.folders, folderId] };
}

export function toggleTagPinLabels(prefs: PinLabelPrefs, tag: string): PinLabelPrefs {
  const trimmed = tag.trim();
  if (!trimmed) return prefs;
  if (!tagHasPinLabels(prefs, trimmed)) return { ...prefs, tags: [...prefs.tags, trimmed] };
  const key = trimmed.toLocaleLowerCase();
  return { ...prefs, tags: prefs.tags.filter((t) => t.toLocaleLowerCase() !== key) };
}

/** Minimal folder shape: labels inherit down the tree via `parentId`. */
export interface PinLabelFolder {
  parentId: string | null;
}

/**
 * Whether a place's pin carries its name: one of its tags is switched on, or
 * its folder or any folder above it is. Guards against cyclic parent chains.
 */
export function placeHasPinLabel(
  place: { collectionId: string | null; tags: readonly string[] },
  prefs: PinLabelPrefs,
  folders: ReadonlyMap<string, PinLabelFolder>,
): boolean {
  if (prefs.tags.length > 0 && place.tags.some((tag) => tagHasPinLabels(prefs, tag))) return true;
  if (prefs.folders.length === 0) return false;
  const seen = new Set<string>();
  let current = place.collectionId;
  while (current !== null && !seen.has(current)) {
    if (prefs.folders.includes(current)) return true;
    seen.add(current);
    current = folders.get(current)?.parentId ?? null;
  }
  return false;
}

/**
 * The label points to draw, one per labelled place with a name.
 *
 * `rank` is the place's position in the list order the user arranged, and the
 * layer places labels in that order (`symbol-sort-key`): where two collide, the
 * one the user put higher in Collections keeps its name.
 *
 * Pass only places that are actually drawn — a label must never outlive its pin.
 */
export function pinLabelFeatures(
  places: readonly {
    id: string;
    name: string;
    lat: number;
    lng: number;
    collectionId: string | null;
    tags: readonly string[];
    sortIndex: number;
  }[],
  prefs: PinLabelPrefs,
  folders: ReadonlyMap<string, PinLabelFolder>,
): { type: 'FeatureCollection'; features: PinLabelFeature[] } {
  if (prefs.folders.length === 0 && prefs.tags.length === 0) {
    return { type: 'FeatureCollection', features: [] };
  }
  const labelled = places
    .filter((place) => place.name.trim() !== '' && placeHasPinLabel(place, prefs, folders))
    .sort((a, b) => a.sortIndex - b.sortIndex || a.name.localeCompare(b.name));
  return {
    type: 'FeatureCollection',
    features: labelled.map((place, rank) => ({
      type: 'Feature',
      id: place.id,
      geometry: { type: 'Point', coordinates: [place.lng, place.lat] },
      properties: { id: place.id, name: place.name.trim(), rank },
    })),
  };
}

export interface PinLabelFeature {
  type: 'Feature';
  id: string;
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties: { id: string; name: string; rank: number };
}

/**
 * Below this zoom no pin carries a name. At continent scale a folder's pins sit
 * on a few pixels, and whichever label survived collision would name one
 * arbitrary pin out of a pile.
 */
export const PIN_LABEL_MINZOOM = 5;

/**
 * The label layer's layout, shared so web and Android draw one design.
 *
 * Density is left to MapLibre's collision rather than a hand-rolled thinning
 * rule: a label that would overlap another is dropped, not stacked, so a dense
 * folder thins itself out zooming out and fills back in zooming in. Long names
 * wrap (`text-max-width`) instead of reserving a wide box that would knock out
 * every neighbour, and the text shrinks a little at regional zooms. Anchored
 * `top` with a small offset: the pin stands *above* its point, so the name
 * hangs below the tip and never covers the badge.
 */
export const PIN_LABEL_LAYOUT: {
  // Spelled out as mutable tuples (not `as const`) so both clients' MapLibre
  // layout types accept the object as is; core carries no style-spec types.
  'text-field': ['get', string];
  'text-font': string[];
  'text-size': ['interpolate', ['linear'], ['zoom'], number, number, number, number];
  'text-anchor': 'top';
  'text-offset': [number, number];
  'text-max-width': number;
  'text-padding': number;
  'symbol-sort-key': ['get', string];
} = {
  'text-field': ['get', 'name'],
  'text-font': ['Noto Sans Bold'],
  'text-size': ['interpolate', ['linear'], ['zoom'], 6, 10.5, 12, 12.5],
  'text-anchor': 'top',
  'text-offset': [0, 0.35],
  'text-max-width': 8,
  'text-padding': 3,
  'symbol-sort-key': ['get', 'rank'],
};

/** Dark text on a white halo — the same treatment as the POI result names. */
export const PIN_LABEL_PAINT: {
  'text-color': string;
  'text-halo-color': string;
  'text-halo-width': number;
} = {
  'text-color': '#172033',
  'text-halo-color': '#ffffff',
  'text-halo-width': 1.5,
};
