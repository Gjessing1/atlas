import { describe, expect, it } from 'vitest';
import {
  exploreCategoriesForProfile,
  exploreResultsFeatureCollection,
  isExploreCategory,
  rankExploreResults,
  sanitizeExploreShortcuts,
  exploreCategory,
} from './explore.js';

describe('explore categories', () => {
  it('narrows ids', () => {
    expect(isExploreCategory('coffee')).toBe(true);
    expect(isExploreCategory('boat-access')).toBe(true);
    expect(isExploreCategory('anything')).toBe(false);
  });

  it('offers each practical category as a distinct nearby query', () => {
    const expected = {
      pharmacy: 'amenity/pharmacy',
      'bank-atm': 'amenity/atm',
      toilets: 'amenity/toilets',
      campsite: 'tourism/camp_site',
      hardware: 'shop/hardware',
      'post-parcel': 'amenity/parcel_locker',
      playground: 'leisure/playground',
    } as const;
    for (const [id, tag] of Object.entries(expected)) {
      expect(exploreCategory(id as keyof typeof expected).osmTags).toContain(tag);
    }
    expect(exploreCategoriesForProfile('explore').map((item) => item.id)).toContain('supermarket');
    expect(
      sanitizeExploreShortcuts(['pharmacy', 'bogus', 'pharmacy', 'toilets'], 'explore'),
    ).toEqual(['pharmacy', 'toilets']);
    expect(sanitizeExploreShortcuts([], 'explore')).toEqual(
      exploreCategoriesForProfile('explore').map((item) => item.id),
    );
  });

  it('offers activity-specific questions and a safe fallback', () => {
    expect(exploreCategoriesForProfile('drive').map((category) => category.id)).toEqual([
      'food',
      'coffee',
      'fuel',
      'charging',
      'supermarket',
      'rest-area',
    ]);
    expect(exploreCategoriesForProfile('fishhunt').map((category) => category.id)).toEqual([
      'parking',
      'boat-access',
      'cabins',
      'viewpoints',
      'gates',
    ]);
    expect(exploreCategoriesForProfile('future-profile')).toEqual(
      exploreCategoriesForProfile('explore'),
    );
  });

  it('numbers map markers in the same order as the result list', () => {
    const collection = exploreResultsFeatureCollection([
      { name: 'First', label: '', position: { lat: 59.9, lng: 10.7 } },
      { name: 'Second', label: '', position: { lat: 60.1, lng: 11.2 } },
    ]);
    expect(collection.features.map((feature) => feature.properties)).toEqual([
      { index: 0, label: '1', name: 'First' },
      { index: 1, label: '2', name: 'Second' },
    ]);
    expect(collection.features[1]!.geometry.coordinates).toEqual([11.2, 60.1]);
  });

  it('spiderfies tightly overlapping results with leader lines', () => {
    const collection = exploreResultsFeatureCollection([
      { name: 'One', label: '', position: { lat: 59.9, lng: 10.7 } },
      { name: 'Two', label: '', position: { lat: 59.90002, lng: 10.70002 } },
    ]);
    const lines = collection.features.filter((feature) => feature.geometry.type === 'LineString');
    const points = collection.features.filter((feature) => feature.geometry.type === 'Point');
    expect(lines).toHaveLength(2);
    expect(points).toHaveLength(2);
    expect(points[0]!.geometry.coordinates).not.toEqual([10.7, 59.9]);
  });

  it('keeps only nearby unique results and orders by distance', () => {
    const center = { lat: 59.91, lng: 10.75 };
    const results = rankExploreResults(
      [
        { name: 'Far', label: '', position: { lat: 60.1, lng: 10.75 } },
        { name: 'Near', label: '', position: { lat: 59.9101, lng: 10.75 } },
        { name: 'Mid', label: '', position: { lat: 59.911, lng: 10.75 } },
        { name: 'Near', label: '', position: { lat: 59.9101, lng: 10.75 } },
      ],
      center,
      1_000,
    );
    expect(results.map((result) => result.name)).toEqual(['Near', 'Mid']);
    expect(results[0]!.distanceM).toBeGreaterThan(0);
  });
});
