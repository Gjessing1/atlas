import { describe, expect, it } from 'vitest';

import {
  encodePoiCategories,
  mergePoiResults,
  overpassPoiTileQuery,
  overpassPoiTileResults,
  parsePoiCategories,
  parsePoiTileKey,
  POI_CATEGORIES,
  poiTileBbox,
  poiTileKey,
  poiTileParent,
  poiResultsFeatureCollection,
  poiTilesForBbox,
  poiViewportTiles,
  togglePoiCategory,
  type OverpassPoiElement,
  type PoiResult,
  type PoiTilePair,
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

  it('asks for the tags pharmacies, ATMs and post counters actually carry in Norway', () => {
    const selectors = (id: string) =>
      POI_CATEGORIES.find((item) => item.id === id)!.selectors.map(
        (selector) => `${selector.key}=${'values' in selector ? selector.values.join('|') : '*'}`,
      );
    expect(selectors('health')).toEqual(['amenity=pharmacy', 'healthcare=pharmacy']);
    expect(selectors('banks')).toEqual(['amenity=bank|atm', 'atm=yes']);
    expect(selectors('post')).toContain('post_office=post_partner|bureau');
  });
});

const OSLO: PoiTilePair['tile'] = { z: 14, x: 8681, y: 4766 };

describe('POI tiles', () => {
  it('covers a view with the tiles that contain it, and names them round-trip', () => {
    const bbox = [10.74, 59.9, 10.76, 59.915] as const;
    const tiles = poiTilesForBbox([...bbox], 14);
    expect(tiles.length).toBeGreaterThan(1);
    const west = Math.min(...tiles.map((tile) => poiTileBbox(tile)[0]));
    const north = Math.max(...tiles.map((tile) => poiTileBbox(tile)[3]));
    expect(west).toBeLessThanOrEqual(bbox[0]);
    expect(north).toBeGreaterThanOrEqual(bbox[3]);
    for (const tile of tiles) expect(parsePoiTileKey(poiTileKey(tile))).toEqual(tile);
  });

  it('fetches at the map zoom, coarser only when a huge screen would need too many tiles', () => {
    const phone = poiViewportTiles([10.74, 59.905, 10.755, 59.92], 14.6);
    expect(new Set(phone.map((tile) => tile.z))).toEqual(new Set([14]));
    expect(phone.length).toBeLessThanOrEqual(6);
    const wall = poiViewportTiles([10, 59.5, 11.9, 60.4], 13);
    expect(wall.length).toBeLessThanOrEqual(64);
    expect(wall[0]!.z).toBeLessThan(13);
  });

  it('rejects tile keys outside the fetchable zooms or the grid', () => {
    expect(parsePoiTileKey('14/8681/4766')).toEqual(OSLO);
    expect(parsePoiTileKey('5/1/1')).toBeNull();
    expect(parsePoiTileKey('14/99999/1')).toBeNull();
    expect(parsePoiTileKey('14/1/x')).toBeNull();
    expect(poiTileParent(OSLO)).toEqual({ z: 13, x: 4340, y: 2383 });
    expect(poiTileParent({ z: 9, x: 271, y: 148 })).toBeNull();
  });
});

describe('Overpass tile queries', () => {
  const pairs: PoiTilePair[] = [
    { tile: OSLO, category: 'food' },
    { tile: OSLO, category: 'health' },
    { tile: { ...OSLO, x: OSLO.x + 1 }, category: 'banks' },
  ];

  it('scans each OSM key once and gives every pair its own limit and marker', () => {
    const query = overpassPoiTileQuery(pairs, 50);
    // food, health and banks all live under `amenity`: one scan for the three.
    expect(query.match(/nwr\["amenity"~/g)).toHaveLength(1);
    expect(query).toContain('nwr["healthcare"="pharmacy"]');
    expect(query).toContain('nwr["atm"="yes"]');
    expect(query.match(/out center tags 51;/g)).toHaveLength(3);
    expect(query).toContain('make atlasblock block="2";out;');
  });

  it('splits a batched answer back into its pairs, flagging a truncated one', () => {
    const node = (id: number, tags: Record<string, string>): OverpassPoiElement => ({
      type: 'node',
      id,
      lat: 59.905,
      lon: 10.745,
      tags,
    });
    const marker = (block: number): OverpassPoiElement => ({
      type: 'atlasblock',
      id: block + 1,
      tags: { block: String(block) },
    });
    const answers = overpassPoiTileResults(
      [
        node(1, { amenity: 'restaurant', name: 'One' }),
        node(2, { amenity: 'restaurant', name: 'Two' }),
        node(3, { amenity: 'restaurant', name: 'Three' }),
        marker(0),
        {
          type: 'way',
          id: 7,
          center: { lat: 59.91, lon: 10.75 },
          tags: {
            amenity: 'pharmacy',
            name: 'Apotek 1',
            'addr:street': 'Testgata',
            'addr:housenumber': '2',
            'addr:postcode': '0001',
            'addr:city': 'Oslo',
            'contact:phone': '+47 12 34 56 78',
            opening_hours: 'Mo-Fr 08:00-16:00',
            'contact:website': 'https://example.com',
          },
        },
        marker(1),
        marker(2),
      ],
      pairs,
      2,
    );
    expect(
      answers.map((answer) => [answer.category, answer.results.length, answer.complete]),
    ).toEqual([
      ['food', 2, false],
      ['health', 1, true],
      ['banks', 0, true],
    ]);
    expect(answers[1]!.results[0]).toMatchObject({
      id: 'way/7',
      category: 'Pharmacies',
      address: 'Testgata 2, 0001 Oslo',
      phone: '+47 12 34 56 78',
      openingHours: 'Mo-Fr 08:00-16:00',
      website: 'https://example.com',
      osmUrl: 'https://www.openstreetmap.org/way/7',
    });
  });

  it('names an unnamed place by what it is, not by a mangled category label', () => {
    const marker = (block: number): OverpassPoiElement => ({
      type: 'atlasblock',
      id: block + 1,
      tags: { block: String(block) },
    });
    const answers = overpassPoiTileResults(
      [
        { type: 'node', id: 1, lat: 59.9, lon: 10.7, tags: { leisure: 'slipway' } },
        marker(0),
        { type: 'node', id: 2, lat: 59.9, lon: 10.7, tags: { amenity: 'post_box' } },
        marker(1),
        // An ATM in a kiosk matched only `atm=yes`; "Yes" names nothing.
        { type: 'node', id: 3, lat: 59.9, lon: 10.7, tags: { shop: 'kiosk', atm: 'yes' } },
        marker(2),
      ],
      [
        { tile: OSLO, category: 'boat-access' },
        { tile: OSLO, category: 'post' },
        { tile: OSLO, category: 'banks' },
      ],
    );
    expect(answers.map((answer) => answer.results[0]!.name)).toEqual([
      'Slipway',
      'Post box',
      'Bank / ATM',
    ]);
  });

  it('refuses an answer that stopped early instead of reading it as empty', () => {
    expect(() => overpassPoiTileResults([], pairs)).toThrow(/missing block 0/);
  });
});

describe('mergePoiResults', () => {
  const place = (id: string, categoryId: PoiResult['categoryId'], lat: number): PoiResult => ({
    id,
    name: id,
    position: { lat, lng: 10.75 },
    categoryId,
    category: categoryId,
    marker: 'x',
  });

  it('lets a sparse category keep its places when a dense one fills the limit', () => {
    const restaurants = Array.from({ length: 750 }, (_, i) =>
      place(`r${i}`, 'food', 59.9 + i / 1e5),
    );
    const pharmacies = Array.from({ length: 30 }, (_, i) =>
      place(`p${i}`, 'health', 59.91 + i / 1e4),
    );
    const merged = mergePoiResults([restaurants, pharmacies], [10.7, 59.8, 10.8, 60], 300);
    expect(merged).toHaveLength(300);
    expect(merged.filter((result) => result.categoryId === 'health')).toHaveLength(30);
  });

  it('keeps only what is in view, once, nearest first', () => {
    const merged = mergePoiResults(
      [
        [place('a', 'food', 59.95), place('far', 'food', 61)],
        [place('a', 'banks', 59.95), place('b', 'banks', 59.9)],
      ],
      [10.7, 59.8, 10.8, 60],
    );
    expect(merged.map((result) => result.id)).toEqual(['b', 'a']);
    expect(merged[0]!.distanceM).toBeGreaterThanOrEqual(0);
  });

  it('puts stable identity and category ids on map features', () => {
    const collection = poiResultsFeatureCollection([place('node/7', 'food', 59.9)]);
    expect(collection.features[0]?.properties).toMatchObject({
      id: 'node/7',
      categoryId: 'food',
    });
  });
});
