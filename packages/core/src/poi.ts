import { haversineM, type LatLng } from './geo.js';
import type { LngLatBbox } from './geoproject.js';
import type { PlaceTarget } from './places.js';

export interface PoiTagSelector {
  key: string;
  values?: readonly string[];
}

/** One user-facing slice of OpenStreetMap places. */
export interface PoiCategory {
  id: PoiCategoryId;
  label: string;
  /** Short, unambiguous marker text; the full label is always present in the list/card. */
  marker: string;
  /** OSM tags queried for this category. Every visible category has a real query. */
  selectors: readonly PoiTagSelector[];
}

/**
 * Practical, explicitly queried POI categories shared by both maps and the
 * backend. Unlike vector-style class guesses, these selectors are OSM tags:
 * choosing a category asks the source for it instead of hoping a tile retained
 * a matching symbol.
 */
export const POI_CATEGORIES = [
  {
    id: 'food',
    label: 'Restaurants',
    marker: 'R',
    selectors: [{ key: 'amenity', values: ['restaurant', 'fast_food', 'food_court'] }],
  },
  { id: 'coffee', label: 'Cafes', marker: 'C', selectors: [{ key: 'amenity', values: ['cafe'] }] },
  {
    id: 'groceries',
    label: 'Groceries',
    marker: 'G',
    selectors: [{ key: 'shop', values: ['supermarket', 'convenience', 'greengrocer', 'deli'] }],
  },
  { id: 'shops', label: 'Shops', marker: 'S', selectors: [{ key: 'shop' }] },
  {
    id: 'museums',
    label: 'Museums',
    marker: 'M',
    selectors: [
      { key: 'tourism', values: ['museum', 'gallery'] },
      { key: 'amenity', values: ['arts_centre'] },
    ],
  },
  {
    id: 'sights',
    label: 'Sights',
    marker: '★',
    selectors: [{ key: 'tourism', values: ['attraction'] }, { key: 'historic' }],
  },
  {
    id: 'nature',
    label: 'Nature',
    marker: 'N',
    selectors: [
      { key: 'natural', values: ['peak', 'beach', 'cave_entrance'] },
      { key: 'leisure', values: ['nature_reserve'] },
      { key: 'tourism', values: ['picnic_site'] },
    ],
  },
  {
    id: 'health',
    label: 'Pharmacies',
    marker: '+',
    // `healthcare=pharmacy` is the newer tag; some pharmacies carry only it.
    selectors: [
      { key: 'amenity', values: ['pharmacy'] },
      { key: 'healthcare', values: ['pharmacy'] },
    ],
  },
  {
    id: 'banks',
    label: 'Bank / ATM',
    marker: '$',
    // `atm=yes` is how an ATM inside a bank, shop or fuel station is mapped.
    selectors: [
      { key: 'amenity', values: ['bank', 'atm'] },
      { key: 'atm', values: ['yes'] },
    ],
  },
  {
    id: 'toilets',
    label: 'Toilets',
    marker: 'WC',
    selectors: [{ key: 'amenity', values: ['toilets'] }],
  },
  {
    id: 'post',
    label: 'Post / parcels',
    marker: 'P',
    // Norway's "Post i butikk" counters sit on the host shop as `post_office=post_partner`.
    selectors: [
      { key: 'amenity', values: ['post_office', 'post_box', 'parcel_locker'] },
      { key: 'post_office', values: ['post_partner', 'bureau'] },
    ],
  },
  {
    id: 'playgrounds',
    label: 'Playgrounds',
    marker: '▶',
    selectors: [{ key: 'leisure', values: ['playground'] }],
  },
  {
    id: 'camping',
    label: 'Camping',
    marker: '△',
    selectors: [{ key: 'tourism', values: ['camp_site', 'caravan_site'] }],
  },
  {
    id: 'fuel',
    label: 'Gas stations',
    marker: 'F',
    selectors: [{ key: 'amenity', values: ['fuel'] }],
  },
  {
    id: 'charging',
    label: 'EV charging',
    marker: '⚡',
    selectors: [{ key: 'amenity', values: ['charging_station'] }],
  },
  {
    id: 'parking',
    label: 'Parking',
    marker: 'P',
    selectors: [{ key: 'amenity', values: ['parking', 'bicycle_parking', 'motorcycle_parking'] }],
  },
  {
    id: 'cabins',
    label: 'Cabins / shelters',
    marker: 'H',
    selectors: [
      { key: 'tourism', values: ['wilderness_hut', 'alpine_hut', 'chalet'] },
      { key: 'amenity', values: ['shelter'] },
    ],
  },
  {
    id: 'viewpoints',
    label: 'Viewpoints',
    marker: 'V',
    selectors: [{ key: 'tourism', values: ['viewpoint'] }],
  },
  {
    id: 'boat-access',
    label: 'Boat access',
    marker: 'B',
    selectors: [
      { key: 'leisure', values: ['slipway', 'marina'] },
      { key: 'waterway', values: ['boatyard'] },
    ],
  },
] as const;

export type PoiCategoryId = (typeof POI_CATEGORIES)[number]['id'];

const CATEGORIES_BY_ID = new Map<string, PoiCategory>(
  POI_CATEGORIES.map((category) => [category.id, category]),
);
const POI_CATEGORY_IDS = new Set(CATEGORIES_BY_ID.keys());

export function isPoiCategoryId(value: unknown): value is PoiCategoryId {
  return typeof value === 'string' && POI_CATEGORY_IDS.has(value);
}

export function poiCategory(id: PoiCategoryId): PoiCategory {
  return CATEGORIES_BY_ID.get(id)!;
}

/** Persisted option key within the profile-scoped POI layer state. */
export const POI_CATEGORIES_OPTION = 'categories';

/** Empty/missing means “All”; stored ids are sanitised into display order. */
export function parsePoiCategories(value: string | undefined): PoiCategoryId[] {
  if (!value) return [];
  const chosen = new Set(value.split(',').filter((id) => POI_CATEGORY_IDS.has(id)));
  return POI_CATEGORIES.map((category) => category.id).filter((id) => chosen.has(id));
}

/** Stable display-order encoding; an empty string is the explicit “All” mode. */
export function encodePoiCategories(categories: readonly PoiCategoryId[]): string {
  const chosen = new Set(categories);
  return POI_CATEGORIES.map((category) => category.id)
    .filter((id) => chosen.has(id))
    .join(',');
}

/** Toggle one pill. Removing the last focused category returns to “All”. */
export function togglePoiCategory(
  categories: readonly PoiCategoryId[],
  id: PoiCategoryId,
): PoiCategoryId[] {
  const next = new Set(categories);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return POI_CATEGORIES.map((category) => category.id).filter((candidate) => next.has(candidate));
}

export interface PoiResult {
  id: string;
  name: string;
  position: LatLng;
  categoryId: PoiCategoryId;
  category: string;
  marker: string;
  address?: string;
  phone?: string;
  openingHours?: string;
  website?: string;
  osmUrl?: string;
  distanceM?: number;
}

export interface OverpassPoiElement {
  /** `node`/`way`/`relation`, or the block marker a batched query emits. */
  type?: string;
  id?: number;
  lat?: number;
  lon?: number;
  center?: { lat?: number; lon?: number };
  tags?: Record<string, string>;
}

function firstTag(tags: Record<string, string>, ...keys: string[]): string | undefined {
  return keys.map((key) => tags[key]?.trim()).find((value) => value);
}

/** Turn OSM address tags into one card/list line without duplicating locality fields. */
export function poiAddress(tags: Record<string, string>): string | undefined {
  const street = firstTag(tags, 'addr:place', 'addr:street');
  const house = firstTag(tags, 'addr:housenumber', 'addr:housename');
  const first = [street, house].filter(Boolean).join(' ');
  const postal = [firstTag(tags, 'addr:postcode'), firstTag(tags, 'addr:city')]
    .filter(Boolean)
    .join(' ');
  const parts = [first, postal, firstTag(tags, 'addr:country')].filter(Boolean);
  return parts.length ? [...new Set(parts)].join(', ') : undefined;
}

const OSM_TYPES = new Set(['node', 'way', 'relation']);

/**
 * What to call a place nobody named: the OSM value it matched, readable
 * ("post_box" → "Post box", "slipway" → "Slipway"). Parking, toilets, post
 * boxes and viewpoints are mostly unnamed, and a list of identical category
 * labels says less than what each one is.
 */
function unnamedLabel(tags: Record<string, string>, category: PoiCategory): string {
  const matched = category.selectors
    .map((selector) => tags[selector.key])
    .find((value) => value && value !== 'yes');
  const value = matched ?? category.label;
  return (value[0]!.toUpperCase() + value.slice(1)).replace(/_/g, ' ');
}

/** One full-tag Overpass element as a display-ready, contact-aware POI. */
export function poiResultFromElement(
  element: OverpassPoiElement,
  category: PoiCategory,
): PoiResult | null {
  const tags = element.tags ?? {};
  const lat = element.lat ?? element.center?.lat;
  const lng = element.lon ?? element.center?.lon;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const type = element.type && OSM_TYPES.has(element.type) ? element.type : undefined;
  const id = element.id;
  const osmId = type && Number.isFinite(id) ? `${type}/${id}` : undefined;
  const name = firstTag(tags, 'name', 'brand', 'operator') ?? unnamedLabel(tags, category);
  const address = poiAddress(tags);
  const phone = firstTag(tags, 'contact:phone', 'phone');
  const openingHours = firstTag(tags, 'opening_hours');
  const website = firstTag(tags, 'contact:website', 'website', 'url');
  return {
    id: osmId ?? `${lat}/${lng}`,
    name,
    position: { lat: lat!, lng: lng! },
    categoryId: category.id,
    category: category.label,
    marker: category.marker,
    ...(address ? { address } : {}),
    ...(phone ? { phone } : {}),
    ...(openingHours ? { openingHours } : {}),
    ...(website ? { website } : {}),
    ...(osmId ? { osmUrl: `https://www.openstreetmap.org/${osmId}` } : {}),
  };
}

// ---- tiles: the unit POIs are fetched and cached in ----
//
// A viewport is never sent upstream as-is. Each pan would be a new query that
// no cache could answer, and a stream of them is what got this host's address
// throttled and then refused by the public Overpass server. Instead a view is
// covered by fixed Web-Mercator tiles, and every (tile, category) pair is
// fetched once and cached on both ends: panning mostly re-reads pairs already
// held, and a category toggle asks only for the new category.

/** A Web-Mercator (slippy-map) tile. */
export interface PoiTile {
  z: number;
  x: number;
  y: number;
}

/**
 * Tile zooms POIs are fetched at. A tile at zoom z spans 512 screen px at map
 * zoom z (MapLibre's world is 512 px at zoom 0), so a phone view needs 2–6
 * tiles and a desktop one ~20; below 9 the view is not queryable at all.
 */
export const POI_TILE_MIN_ZOOM = 9;
export const POI_TILE_MAX_ZOOM = 15;
/** Most tiles one request may name; a 4K desktop view needs ~54. */
export const POI_MAX_TILES = 64;
/**
 * Places kept per tile and category. More than this and the tile holds a
 * sample, which the next zoom level's four tiles refine, the way vector tiles
 * thin out points; at street zoom only the densest categories ever reach it.
 */
export const POI_TILE_LIMIT = 50;
/** Pins and list rows shown for one view. */
export const POI_VIEW_LIMIT = 300;

const MAX_MERCATOR_LAT = 85.0511287798;
const RAD = Math.PI / 180;

function tileIndex(value: number, count: number): number {
  return Math.min(count - 1, Math.max(0, Math.floor(value * count)));
}

function tileXAt(lng: number, count: number): number {
  return tileIndex((lng + 180) / 360, count);
}

function tileYAt(lat: number, count: number): number {
  const phi = Math.min(MAX_MERCATOR_LAT, Math.max(-MAX_MERCATOR_LAT, lat)) * RAD;
  return tileIndex((1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2, count);
}

/** The tile zoom a map at `mapZoom` fetches POIs at. */
export function poiTileZoom(mapZoom: number): number {
  return Math.min(POI_TILE_MAX_ZOOM, Math.max(POI_TILE_MIN_ZOOM, Math.floor(mapZoom)));
}

export function poiTileKey(tile: PoiTile): string {
  return `${tile.z}/${tile.x}/${tile.y}`;
}

/** A `z/x/y` key back into a tile, or null when it is not a fetchable POI tile. */
export function parsePoiTileKey(key: string): PoiTile | null {
  const parts = key.split('/');
  if (parts.length !== 3 || parts.some((part) => !/^\d+$/.test(part))) return null;
  const [z, x, y] = parts.map(Number) as [number, number, number];
  if (z < POI_TILE_MIN_ZOOM || z > POI_TILE_MAX_ZOOM) return null;
  const count = 2 ** z;
  return x < count && y < count ? { z, x, y } : null;
}

/** The tile's [west, south, east, north] bounds. */
export function poiTileBbox({ z, x, y }: PoiTile): LngLatBbox {
  const count = 2 ** z;
  const lng = (tx: number) => (tx / count) * 360 - 180;
  const lat = (ty: number) => Math.atan(Math.sinh(Math.PI * (1 - (2 * ty) / count))) / RAD;
  return [lng(x), lat(y + 1), lng(x + 1), lat(y)];
}

/** The tile one zoom out that contains this one, or null at the coarsest POI zoom. */
export function poiTileParent({ z, x, y }: PoiTile): PoiTile | null {
  return z > POI_TILE_MIN_ZOOM ? { z: z - 1, x: Math.floor(x / 2), y: Math.floor(y / 2) } : null;
}

export function poiTilesForBbox([west, south, east, north]: LngLatBbox, z: number): PoiTile[] {
  const count = 2 ** z;
  const x0 = tileXAt(west, count);
  const x1 = tileXAt(east, count);
  const y0 = tileYAt(north, count);
  const y1 = tileYAt(south, count);
  const tiles: PoiTile[] = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) tiles.push({ z, x, y });
  return tiles;
}

/** The tiles covering a view, one zoom coarser while a very large screen would need too many. */
export function poiViewportTiles(bbox: LngLatBbox, mapZoom: number): PoiTile[] {
  for (let z = poiTileZoom(mapZoom); ; z--) {
    const tiles = poiTilesForBbox(bbox, z);
    if (tiles.length <= POI_MAX_TILES || z <= POI_TILE_MIN_ZOOM) return tiles;
  }
}

/** The categories a selection fetches: an empty selection (“All”) is every category. */
export function poiQueryCategories(categories: readonly PoiCategoryId[]): PoiCategoryId[] {
  return categories.length ? [...categories] : POI_CATEGORIES.map((category) => category.id);
}

/** One cache and query unit: the places of one category inside one tile. */
export interface PoiTilePair {
  tile: PoiTile;
  category: PoiCategoryId;
}

export function poiPairKey(tileKey: string, category: PoiCategoryId): string {
  return `${tileKey}|${category}`;
}

/** The answer for one pair. */
export interface PoiTileResults {
  /** `z/x/y`. */
  tile: string;
  category: PoiCategoryId;
  results: PoiResult[];
  /** False when the tile holds more than POI_TILE_LIMIT, so `results` are a sample. */
  complete: boolean;
}

function overpassSelector(selector: PoiTagSelector): string {
  const key = JSON.stringify(selector.key);
  if (!selector.values) return `[${key}]`;
  if (selector.values.length === 1) return `[${key}=${JSON.stringify(selector.values[0])}]`;
  const values = selector.values.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return `[${key}~${JSON.stringify(`^(${values.join('|')})$`)}]`;
}

/**
 * Overpass `make`s one of these after each block, so a batched answer splits
 * back into its pairs exactly — by position alone, a way on a tile edge or a
 * shop that is also an ATM would land in the wrong pair.
 */
const BLOCK_MARKER = 'atlasblock';

function overpassBox([west, south, east, north]: LngLatBbox): string {
  return [south, west, north, east].map((value) => Number(value.toFixed(7))).join(',');
}

/**
 * One Overpass QL query for many pairs. Each OSM key the batch needs is
 * scanned once over the batch's combined bounds — `amenity` once for
 * restaurants, pharmacies, banks and toilets together. Categories are then
 * filtered out of those sets, and tiles out of the categories, in memory.
 * Measured on a phone view of central Oslo with every category: one scan per
 * selector (~28) took 15.3 s on overpass-api.de; one per key (10) took 3.9 s.
 * The caller keeps a batch's tiles close together (see PoiSource), so the
 * combined bounds stay small.
 *
 * Every pair gets its own output limit: one shared limit is filled in OSM id
 * order, so 750 restaurants would crowd the 30 pharmacies of the same view out
 * of the answer. Asking for one more than the limit tells a complete pair from
 * a truncated one.
 */
export function overpassPoiTileQuery(
  pairs: readonly PoiTilePair[],
  limit = POI_TILE_LIMIT,
): string {
  const tileBoxes = pairs.map((pair) => poiTileBbox(pair.tile));
  const union: LngLatBbox = [
    Math.min(...tileBoxes.map((box) => box[0])),
    Math.min(...tileBoxes.map((box) => box[1])),
    Math.max(...tileBoxes.map((box) => box[2])),
    Math.max(...tileBoxes.map((box) => box[3])),
  ];
  const categories = [...new Set(pairs.map((pair) => pair.category))];
  // Per key, every value any category asks for; null once one asks for any value.
  const keys = new Map<string, Set<string> | null>();
  for (const category of categories) {
    for (const selector of poiCategory(category).selectors) {
      const known = keys.get(selector.key);
      if (!selector.values || known === null) keys.set(selector.key, null);
      else keys.set(selector.key, new Set([...(known ?? []), ...selector.values]));
    }
  }
  const keyIndex = [...keys.keys()];
  const scans = [...keys].map(
    ([key, values], index) =>
      `nwr${overpassSelector({ key, values: values ? [...values] : undefined })}(${overpassBox(union)})->.k${index};`,
  );
  const sets = categories.map((category, index) => {
    const filters = poiCategory(category)
      .selectors.map(
        (selector) => `nwr.k${keyIndex.indexOf(selector.key)}${overpassSelector(selector)};`,
      )
      .join('');
    return `(${filters})->.c${index};`;
  });
  const blocks = pairs.map(
    (pair, index) =>
      `nwr.c${categories.indexOf(pair.category)}(${overpassBox(tileBoxes[index]!)});` +
      `out center tags ${limit + 1};make ${BLOCK_MARKER} block="${index}";out;`,
  );
  return `[out:json][timeout:25];${scans.join('')}${sets.join('')}${blocks.join('')}`;
}

/**
 * Split an answer to `overpassPoiTileQuery` back into its pairs. Throws when a
 * block is missing (Overpass answers a timed-out query with a 200 and whatever
 * it had), because caching that as "nothing here" would hide real places.
 */
export function overpassPoiTileResults(
  elements: readonly OverpassPoiElement[],
  pairs: readonly PoiTilePair[],
  limit = POI_TILE_LIMIT,
): PoiTileResults[] {
  const answers: (PoiTileResults | undefined)[] = pairs.map(() => undefined);
  let block: OverpassPoiElement[] = [];
  for (const element of elements) {
    if (element.type !== BLOCK_MARKER) {
      block.push(element);
      continue;
    }
    const index = Number(element.tags?.['block']);
    const pair = pairs[index];
    if (pair) {
      const category = poiCategory(pair.category);
      const results = block
        .map((item) => poiResultFromElement(item, category))
        .filter((result): result is PoiResult => result !== null);
      answers[index] = {
        tile: poiTileKey(pair.tile),
        category: pair.category,
        results: results.slice(0, limit),
        complete: block.length <= limit,
      };
    }
    block = [];
  }
  const missing = answers.findIndex((answer) => !answer);
  if (missing >= 0) throw new Error(`Overpass answer is missing block ${missing}`);
  return answers as PoiTileResults[];
}

/**
 * The pins and list rows for one view: every pair's places inside the view,
 * nearest the centre first. Past `limit`, the categories take turns, so a
 * dense category cannot push a sparse one off the map.
 */
export function mergePoiResults(
  groups: readonly (readonly PoiResult[])[],
  bbox: LngLatBbox,
  limit = POI_VIEW_LIMIT,
): PoiResult[] {
  const [west, south, east, north] = bbox;
  const center = { lat: (south + north) / 2, lng: (west + east) / 2 };
  const seen = new Set<string>();
  const byCategory = new Map<PoiCategoryId, PoiResult[]>();
  for (const group of groups) {
    for (const result of group) {
      const { lat, lng } = result.position;
      if (lng < west || lng > east || lat < south || lat > north || seen.has(result.id)) continue;
      seen.add(result.id);
      const list = byCategory.get(result.categoryId) ?? [];
      list.push({ ...result, distanceM: haversineM(center, result.position) });
      byCategory.set(result.categoryId, list);
    }
  }
  const byDistance = (a: PoiResult, b: PoiResult) =>
    (a.distanceM ?? 0) - (b.distanceM ?? 0) || a.name.localeCompare(b.name);
  const lists = [...byCategory.values()].map((list) => list.sort(byDistance));
  const picked: PoiResult[] = [];
  for (let rank = 0; picked.length < limit; rank++) {
    const round = lists.filter((list) => rank < list.length).map((list) => list[rank]!);
    if (!round.length) break;
    picked.push(...round.slice(0, limit - picked.length));
  }
  return picked.sort(byDistance);
}

/** Tile request URL shared by web and Android. */
export function poiTilesUrl(
  origin: string,
  tiles: readonly PoiTile[],
  categories: readonly PoiCategoryId[],
): string {
  const params = new URLSearchParams({ tiles: tiles.map(poiTileKey).join(',') });
  if (categories.length) params.set('categories', encodePoiCategories(categories));
  return `${origin}/api/pois?${params}`;
}

/** Keep continent/world views from becoming accidental database scans. */
export function poiViewportIsQueryable(bbox: LngLatBbox, zoom: number): boolean {
  const [west, south, east, north] = bbox;
  return zoom >= 9 && east > west && north > south && east - west <= 2 && north - south <= 1.5;
}

/** The selected query pin opens the ordinary Atlas place card with full OSM details. */
export function poiResultTarget(result: PoiResult): PlaceTarget {
  return {
    source: 'poi',
    position: result.position,
    name: result.name,
    category: result.category,
    address: result.address,
    phone: result.phone,
    openingHours: result.openingHours,
    website: result.website,
    osmUrl: result.osmUrl,
  };
}

/** Numbered pins and list rows share the same stable ordering and index. */
export function poiResultsFeatureCollection(results: readonly PoiResult[]) {
  return {
    type: 'FeatureCollection' as const,
    features: results.map((result, index) => ({
      type: 'Feature' as const,
      properties: {
        index,
        label: String(index + 1),
        marker: result.marker,
        name: result.name,
        category: result.category,
      },
      geometry: {
        type: 'Point' as const,
        coordinates: [result.position.lng, result.position.lat],
      },
    })),
  };
}
