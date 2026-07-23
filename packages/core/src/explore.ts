import { haversineM, type LatLng } from './geo.js';
import type { SearchResult } from './search.js';

export type ExploreCategoryId = 'food' | 'coffee' | 'sights' | 'nature' | 'shops' | 'essentials';

export interface ExploreCategory {
  id: ExploreCategoryId;
  label: string;
  /** Principal OSM tags understood by both Photon and the offline pack DB. */
  osmTags: readonly string[];
}

/** A deliberately short browse vocabulary, shared by web, Android and backend. */
export const EXPLORE_CATEGORIES: readonly ExploreCategory[] = [
  {
    id: 'food',
    label: 'Food',
    osmTags: ['amenity/restaurant', 'amenity/fast_food', 'amenity/food_court'],
  },
  { id: 'coffee', label: 'Coffee', osmTags: ['amenity/cafe'] },
  {
    id: 'sights',
    label: 'Sights',
    osmTags: ['tourism/attraction', 'tourism/museum', 'historic/monument', 'tourism/viewpoint'],
  },
  {
    id: 'nature',
    label: 'Nature',
    osmTags: ['natural/peak', 'natural/beach', 'leisure/nature_reserve', 'tourism/picnic_site'],
  },
  {
    id: 'shops',
    label: 'Shops',
    osmTags: ['shop/supermarket', 'shop/convenience', 'shop/mall'],
  },
  {
    id: 'essentials',
    label: 'Essentials',
    osmTags: ['amenity/fuel', 'amenity/pharmacy', 'amenity/hospital', 'amenity/toilets'],
  },
];

export function isExploreCategory(value: unknown): value is ExploreCategoryId {
  return typeof value === 'string' && EXPLORE_CATEGORIES.some((category) => category.id === value);
}

export function exploreCategory(id: ExploreCategoryId): ExploreCategory {
  return EXPLORE_CATEGORIES.find((category) => category.id === id)!;
}

/** Rank and deduplicate nearby POIs, enforcing the visible-area radius. */
export function rankExploreResults(
  results: readonly SearchResult[],
  center: LatLng,
  radiusM: number,
  limit = 20,
): SearchResult[] {
  const seen = new Set<string>();
  return results
    .map((result) => ({ result, distanceM: haversineM(center, result.position) }))
    .filter(({ result, distanceM }) => {
      if (distanceM > radiusM) return false;
      const key = `${normalise(result.name)}@${result.position.lat.toFixed(5)},${result.position.lng.toFixed(5)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.distanceM - b.distanceM || a.result.name.localeCompare(b.result.name))
    .slice(0, limit)
    .map(({ result, distanceM }) => ({ ...result, distanceM }));
}

function normalise(value: string): string {
  return value.trim().toLocaleLowerCase();
}
