/** One user-facing slice of the OSM points carried by Atlas's map sources. */
export interface PoiCategory {
  id: PoiCategoryId;
  label: string;
}

/**
 * The deliberately practical POI filter vocabulary shared by both maps.
 *
 * These are presentation categories, not a claim that OSM has one matching
 * tag for each: the style pass maps them onto OpenMapTiles class/subclass
 * values and Atlas's smaller outdoor schema. Keep the labels short because
 * they live in a horizontally scrolling pill row over the map.
 */
export const POI_CATEGORIES = [
  { id: 'food', label: 'Food' },
  { id: 'coffee', label: 'Coffee' },
  { id: 'groceries', label: 'Groceries' },
  { id: 'shops', label: 'Shops' },
  { id: 'museums', label: 'Museums' },
  { id: 'sights', label: 'Sights' },
  { id: 'nature', label: 'Nature' },
  { id: 'health', label: 'Health' },
  { id: 'banks', label: 'Bank / ATM' },
  { id: 'toilets', label: 'Toilets' },
  { id: 'post', label: 'Post' },
  { id: 'playgrounds', label: 'Playgrounds' },
  { id: 'camping', label: 'Camping' },
  { id: 'fuel', label: 'Fuel' },
  { id: 'charging', label: 'Charging' },
  { id: 'parking', label: 'Parking' },
  { id: 'cabins', label: 'Cabins' },
  { id: 'viewpoints', label: 'Viewpoints' },
  { id: 'boat-access', label: 'Boat access' },
] as const;

export type PoiCategoryId = (typeof POI_CATEGORIES)[number]['id'];

const POI_CATEGORY_IDS = new Set<string>(POI_CATEGORIES.map((category) => category.id));

/** Persisted option key within the profile-scoped POI layer state. */
export const POI_CATEGORIES_OPTION = 'categories';

/**
 * Decode the comma-separated profile preference. An empty/missing selection
 * means “All”, so first activation shows the complete POI layer and the user
 * only enters focused mode by pressing a category pill.
 */
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
