import { describe, expect, it } from 'vitest';
import { isExploreCategory, rankExploreResults } from './explore.js';

describe('explore categories', () => {
  it('narrows ids', () => {
    expect(isExploreCategory('coffee')).toBe(true);
    expect(isExploreCategory('anything')).toBe(false);
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
