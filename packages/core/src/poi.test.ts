import { describe, expect, it } from 'vitest';

import {
  encodePoiCategories,
  overpassPoiQuery,
  overpassPoiResults,
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

  it('gives every visible category at least one concrete OSM selector', () => {
    for (const category of POI_CATEGORIES) {
      expect(category.selectors.length, category.label).toBeGreaterThan(0);
      expect(category.marker.length, category.label).toBeGreaterThan(0);
    }
    expect(POI_CATEGORIES.find((item) => item.id === 'fuel')?.label).toBe('Gas stations');
    expect(POI_CATEGORIES.find((item) => item.id === 'health')?.label).toBe('Pharmacies');
  });

  it('builds a bounded category query and maps complete OSM details', () => {
    const query = overpassPoiQuery([10.7, 59.8, 10.8, 60], ['coffee']);
    expect(query).toContain('cafe');
    expect(query).not.toContain('charging_station');
    const results = overpassPoiResults(
      [
        {
          type: 'way',
          id: 7,
          center: { lat: 59.91, lon: 10.75 },
          tags: {
            amenity: 'cafe',
            name: 'Kaffebaren',
            'addr:street': 'Testgata',
            'addr:housenumber': '2',
            'addr:postcode': '0001',
            'addr:city': 'Oslo',
            'contact:phone': '+47 12 34 56 78',
            opening_hours: 'Mo-Fr 08:00-16:00',
            'contact:website': 'https://example.com',
          },
        },
      ],
      { lat: 59.91, lng: 10.75 },
    );
    expect(results[0]).toMatchObject({
      id: 'way/7',
      category: 'Cafes',
      address: 'Testgata 2, 0001 Oslo',
      phone: '+47 12 34 56 78',
      openingHours: 'Mo-Fr 08:00-16:00',
      website: 'https://example.com',
      osmUrl: 'https://www.openstreetmap.org/way/7',
    });
  });
});
