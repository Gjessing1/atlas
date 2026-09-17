import { haversineM, type LatLng } from './geo.js';
import type { SearchResult } from './search.js';

export type ExploreCategoryId =
  | 'food'
  | 'coffee'
  | 'sights'
  | 'nature'
  | 'shops'
  | 'essentials'
  | 'fuel'
  | 'charging'
  | 'supermarket'
  | 'rest-area'
  | 'parking'
  | 'cabins'
  | 'boat-access'
  | 'viewpoints'
  | 'gates';

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
  // Dedicated driving-stop categories: the mid-navigation "add a stop" flow
  // asks for exactly these, and a driver hunting fuel must not wade through
  // pharmacies to find it.
  { id: 'fuel', label: 'Gas', osmTags: ['amenity/fuel'] },
  { id: 'charging', label: 'Charging', osmTags: ['amenity/charging_station'] },
  { id: 'supermarket', label: 'Groceries', osmTags: ['shop/supermarket', 'shop/convenience'] },
  {
    id: 'rest-area',
    label: 'Rest areas',
    osmTags: ['highway/rest_area', 'highway/services', 'tourism/picnic_site'],
  },
  {
    id: 'parking',
    label: 'Parking & trailheads',
    osmTags: ['amenity/parking', 'information/trailhead'],
  },
  {
    id: 'cabins',
    label: 'Cabins & shelters',
    osmTags: ['tourism/wilderness_hut', 'tourism/alpine_hut', 'tourism/chalet', 'amenity/shelter'],
  },
  {
    id: 'boat-access',
    label: 'Boat access',
    osmTags: ['leisure/slipway', 'waterway/boatyard'],
  },
  {
    id: 'viewpoints',
    label: 'Viewpoints',
    osmTags: ['tourism/viewpoint', 'natural/peak'],
  },
  {
    id: 'gates',
    label: 'Road gates',
    osmTags: ['barrier/gate', 'barrier/lift_gate', 'barrier/swing_gate'],
  },
];

const CATEGORIES_BY_ID = new Map(EXPLORE_CATEGORIES.map((category) => [category.id, category]));

const PROFILE_CATEGORY_IDS: Readonly<Record<string, readonly ExploreCategoryId[]>> = {
  explore: ['food', 'coffee', 'sights', 'nature', 'shops', 'essentials'],
  drive: ['food', 'coffee', 'fuel', 'charging', 'supermarket', 'rest-area'],
  bike: ['coffee', 'food', 'parking', 'viewpoints', 'essentials'],
  hike: ['parking', 'cabins', 'viewpoints', 'nature'],
  run: ['parking', 'viewpoints', 'nature', 'coffee'],
  ski: ['parking', 'cabins', 'viewpoints'],
  fishhunt: ['parking', 'boat-access', 'cabins', 'viewpoints', 'gates'],
  curiosities: ['sights', 'nature', 'viewpoints', 'parking'],
};

/** The nearby questions that make sense for the activity currently on the map. */
export function exploreCategoriesForProfile(profileId: string): readonly ExploreCategory[] {
  return (PROFILE_CATEGORY_IDS[profileId] ?? PROFILE_CATEGORY_IDS['explore']!).map((id) =>
    CATEGORIES_BY_ID.get(id)!,
  );
}

/**
 * The browse radius both clients ask for, in metres. Web measures the map's own
 * half-diagonal and Android derives one from zoom and screen size, but the
 * bounds are a property of the *question* — below the floor a browse returns
 * nothing in open country, above the ceiling it stops being "this area" and
 * starts being a national query the upstreams will not answer well.
 */
export const EXPLORE_RADIUS_MIN_M = 500;
export const EXPLORE_RADIUS_MAX_M = 50_000;

export function clampExploreRadiusM(radiusM: number): number {
  if (!Number.isFinite(radiusM)) return EXPLORE_RADIUS_MIN_M;
  return Math.min(EXPLORE_RADIUS_MAX_M, Math.max(EXPLORE_RADIUS_MIN_M, radiusM));
}

export function isExploreCategory(value: unknown): value is ExploreCategoryId {
  return typeof value === 'string' && EXPLORE_CATEGORIES.some((category) => category.id === value);
}

export function exploreCategory(id: ExploreCategoryId): ExploreCategory {
  return CATEGORIES_BY_ID.get(id)!;
}

/**
 * Numbered map markers in the exact order used by the Explore result list.
 * Results within a finger-width at close zoom are spread around their shared
 * centre with a short leader line. At ordinary zoom the source's clustering
 * still folds them together; once the final cluster opens, every result has a
 * distinct hit target instead of occupying the same pixels.
 */
export function exploreResultsFeatureCollection(results: readonly SearchResult[]) {
  const closeGroups: number[][] = [];
  results.forEach((result, index) => {
    const group = closeGroups.find((memberIndexes) =>
      memberIndexes.some(
        (memberIndex) => haversineM(results[memberIndex]!.position, result.position) <= 12,
      ),
    );
    if (group) group.push(index);
    else closeGroups.push([index]);
  });
  const displayed = new Map<number, LatLng>();
  for (const group of closeGroups) {
    if (group.length < 2) continue;
    const centre = group.reduce(
      (sum, index) => ({
        lat: sum.lat + results[index]!.position.lat / group.length,
        lng: sum.lng + results[index]!.position.lng / group.length,
      }),
      { lat: 0, lng: 0 },
    );
    const radiusDeg = 0.00018;
    const lngScale = Math.max(Math.cos((centre.lat * Math.PI) / 180), 0.2);
    group.forEach((index, slot) => {
      const angle = (2 * Math.PI * slot) / group.length - Math.PI / 2;
      displayed.set(index, {
        lat: centre.lat + Math.sin(angle) * radiusDeg,
        lng: centre.lng + (Math.cos(angle) * radiusDeg) / lngScale,
      });
    });
  }
  return {
    type: 'FeatureCollection' as const,
    features: results.flatMap((result, index) => {
      const shown = displayed.get(index) ?? result.position;
      const point = {
        type: 'Feature' as const,
        properties: { index, label: String(index + 1), name: result.name },
        geometry: {
          type: 'Point' as const,
          coordinates: [shown.lng, shown.lat],
        },
      };
      if (!displayed.has(index)) return [point];
      return [
        {
          type: 'Feature' as const,
          properties: { spiderLeg: true },
          geometry: {
            type: 'LineString' as const,
            coordinates: [
              [result.position.lng, result.position.lat],
              [shown.lng, shown.lat],
            ],
          },
        },
        point,
      ];
    }),
  };
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
