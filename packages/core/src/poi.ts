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
    selectors: [{ key: 'amenity', values: ['pharmacy'] }],
  },
  {
    id: 'banks',
    label: 'Bank / ATM',
    marker: '$',
    selectors: [{ key: 'amenity', values: ['bank', 'atm'] }],
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
    selectors: [{ key: 'amenity', values: ['post_office', 'post_box', 'parcel_locker'] }],
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
  type?: 'node' | 'way' | 'relation';
  id?: number;
  lat?: number;
  lon?: number;
  center?: { lat?: number; lon?: number };
  tags?: Record<string, string>;
}

function selectorMatches(tags: Record<string, string>, selector: PoiTagSelector): boolean {
  const value = tags[selector.key];
  return value !== undefined && (!selector.values || selector.values.includes(value));
}

function resultCategory(
  tags: Record<string, string>,
  categories: readonly PoiCategory[],
): PoiCategory | undefined {
  return categories.find((category) =>
    category.selectors.some((selector) => selectorMatches(tags, selector)),
  );
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

/** Parse full-tag Overpass elements into display-ready, contact-aware POIs. */
export function overpassPoiResults(
  elements: readonly OverpassPoiElement[],
  center: LatLng,
  categoryIds: readonly PoiCategoryId[] = [],
): PoiResult[] {
  const categories: readonly PoiCategory[] = categoryIds.length
    ? categoryIds.map(poiCategory)
    : POI_CATEGORIES;
  const seen = new Set<string>();
  const results: PoiResult[] = [];
  for (const element of elements) {
    const tags = element.tags ?? {};
    const category = resultCategory(tags, categories);
    const lat = element.lat ?? element.center?.lat;
    const lng = element.lon ?? element.center?.lon;
    if (!category || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const type = element.type;
    const id = element.id;
    const stableId = type && Number.isFinite(id) ? `${type}/${id}` : `${lat}/${lng}`;
    if (seen.has(stableId)) continue;
    seen.add(stableId);
    const name = firstTag(tags, 'name', 'brand', 'operator') ?? category.label.replace(/s$/, '');
    const address = poiAddress(tags);
    const phone = firstTag(tags, 'contact:phone', 'phone');
    const openingHours = firstTag(tags, 'opening_hours');
    const website = firstTag(tags, 'contact:website', 'website', 'url');
    results.push({
      id: stableId,
      name,
      position: { lat: lat!, lng: lng! },
      categoryId: category.id,
      category: category.label,
      marker: category.marker,
      ...(address ? { address } : {}),
      ...(phone ? { phone } : {}),
      ...(openingHours ? { openingHours } : {}),
      ...(website ? { website } : {}),
      ...(type && Number.isFinite(id)
        ? { osmUrl: `https://www.openstreetmap.org/${type}/${id}` }
        : {}),
      distanceM: haversineM(center, { lat: lat!, lng: lng! }),
    });
  }
  return results.sort(
    (a, b) => (a.distanceM ?? 0) - (b.distanceM ?? 0) || a.name.localeCompare(b.name),
  );
}

function overpassSelector(selector: PoiTagSelector): string {
  const key = JSON.stringify(selector.key);
  if (!selector.values) return `[${key}]`;
  const values = selector.values.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return `[${key}~${JSON.stringify(`^(${values.join('|')})$`)}]`;
}

/** A bounded Overpass QL query; the backend is the only caller that sends it upstream. */
export function overpassPoiQuery(
  bbox: LngLatBbox,
  categories: readonly PoiCategoryId[],
  limit = 300,
): string {
  const selected: readonly PoiCategory[] = categories.length
    ? categories.map(poiCategory)
    : POI_CATEGORIES;
  const selectors = new Map<string, PoiTagSelector>();
  for (const category of selected) {
    for (const selector of category.selectors) {
      const key = `${selector.key}/${selector.values?.join('|') ?? '*'}`;
      selectors.set(key, selector);
    }
  }
  const [west, south, east, north] = bbox;
  const box = `${south},${west},${north},${east}`;
  const clauses = [...selectors.values()].map(
    (selector) => `nwr${overpassSelector(selector)}(${box});`,
  );
  return `[out:json][timeout:15];(${clauses.join('')});out center tags ${Math.max(1, Math.min(500, limit))};`;
}

/** Viewport URL shared by web and Android. */
export function poiViewportUrl(
  origin: string,
  bbox: LngLatBbox,
  categories: readonly PoiCategoryId[],
): string {
  const params = new URLSearchParams({ bbox: bbox.join(',') });
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
