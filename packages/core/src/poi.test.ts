import { describe, expect, it } from 'vitest';

import {
  encodePoiCategories,
  parsePoiCategories,
  POI_CATEGORIES,
  togglePoiCategory,
} from './poi.js';

describe('POI categories', () => {
  it('keeps groceries, shops and museums as independent practical filters', () => {
    expect(POI_CATEGORIES.map((category) => category.id)).toEqual(
      expect.arrayContaining(['groceries', 'shops', 'museums']),
    );
  });

  it('uses an empty selection for All and sanitizes stored ids in display order', () => {
    expect(parsePoiCategories(undefined)).toEqual([]);
    expect(parsePoiCategories('museums,unknown,groceries,museums')).toEqual([
      'groceries',
      'museums',
    ]);
    expect(encodePoiCategories(['museums', 'groceries'])).toBe('groceries,museums');
  });

  it('returns to All when the last focused pill is disabled', () => {
    expect(togglePoiCategory([], 'groceries')).toEqual(['groceries']);
    expect(togglePoiCategory(['groceries'], 'groceries')).toEqual([]);
  });
});
