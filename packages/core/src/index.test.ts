import { describe, expect, it } from 'vitest';
import {
  bboxContains,
  collectionIsVisible,
  coordinateSearchResult,
  decodeMapHash,
  decodeMapLink,
  encodeMapHash,
  markerScaleForZoom,
  matchPlacesByName,
  parseCoordinateQuery,
  photonFeatureToSearchResult,
  placeIsVisible,
  resolveStyleTemplate,
  type BBox,
  type PhotonFeature,
  type VisibilityFolder,
} from './index.js';

describe('map hash', () => {
  it('round-trips camera and pin', () => {
    const state = {
      center: { lat: 59.91384, lng: 10.75234 },
      zoom: 12.3,
      pin: { lat: 58.99, lng: 6.19 },
    };
    expect(encodeMapHash(state)).toBe('#map=12.3/59.91384/10.75234&pin=58.99/6.19');
    expect(decodeMapHash(encodeMapHash(state))).toEqual(state);
  });

  it('round-trips without a pin', () => {
    const state = { center: { lat: -33.9, lng: 151.2 }, zoom: 5 };
    expect(decodeMapHash(encodeMapHash(state))).toEqual(state);
  });

  it('limits coordinate precision', () => {
    expect(encodeMapHash({ center: { lat: 1.123456789, lng: 2.987654321 }, zoom: 7.777777 })).toBe(
      '#map=7.78/1.12346/2.98765',
    );
  });

  it('rejects hashes without a map view', () => {
    expect(decodeMapHash('')).toBeNull();
    expect(decodeMapHash('#pin=1/2')).toBeNull();
    expect(decodeMapHash('#map=abc/1/2')).toBeNull();
  });

  it('round-trips a route plan', () => {
    const state = {
      center: { lat: 59.91384, lng: 10.75234 },
      zoom: 12.3,
      route: {
        profile: 'bike',
        points: [
          { lat: 59.91, lng: 10.75 },
          { lat: 60.79, lng: 10.69 },
          { lat: -1.5, lng: -33.25 },
        ],
      },
    };
    expect(encodeMapHash(state)).toBe(
      '#map=12.3/59.91384/10.75234&route=bike/59.91,10.75/60.79,10.69/-1.5,-33.25',
    );
    expect(decodeMapHash(encodeMapHash(state))).toEqual(state);
  });

  it('round-trips a round-trip plan', () => {
    const state = {
      center: { lat: 59.91, lng: 10.75 },
      zoom: 10,
      route: { profile: 'foot', points: [{ lat: 59.91, lng: 10.75 }], roundTripKm: 12.5 },
    };
    expect(encodeMapHash(state)).toBe('#map=10/59.91/10.75&route=foot/59.91,10.75&loop=12.5');
    expect(decodeMapHash(encodeMapHash(state))).toEqual(state);
  });

  it('drops a loop length that contradicts a multi-stop plan', () => {
    const plan = decodeMapHash(
      '#map=10/59.91/10.75&route=car/59.91,10.75/60.1,10.9&loop=12',
    )?.route;
    expect(plan?.points).toHaveLength(2);
    expect(plan?.roundTripKm).toBeUndefined();
  });

  it('ignores a malformed or empty route segment', () => {
    expect(decodeMapHash('#map=10/59.91/10.75&route=car')?.route).toBeUndefined();
    expect(decodeMapHash('#map=10/59.91/10.75&route=car/abc,def')?.route).toBeUndefined();
    expect(decodeMapHash('#map=10/59.91/10.75')?.route).toBeUndefined();
  });

  it('omits a plan with no stops or an unusable profile', () => {
    const view = { center: { lat: 1, lng: 2 }, zoom: 5 };
    expect(encodeMapHash({ ...view, route: { profile: 'car', points: [] } })).toBe('#map=5/1/2');
    expect(
      encodeMapHash({ ...view, route: { profile: 'car&pin=9/9', points: [{ lat: 3, lng: 4 }] } }),
    ).toBe('#map=5/1/2');
  });
});

describe('decodeMapLink', () => {
  const state = { center: { lat: 59.91, lng: 10.75 }, zoom: 13, pin: { lat: 59.9, lng: 10.7 } };
  const hash = encodeMapHash(state);

  it('parses web share links and scheme deep links alike', () => {
    expect(decodeMapLink(`https://atlas.example/${hash}`)).toEqual(state);
    expect(decodeMapLink(`atlas://${hash.slice(1)}`)).toEqual(state);
    expect(decodeMapLink(`atlas:${hash}`)).toEqual(state);
  });

  it('rejects URLs without a map fragment', () => {
    expect(decodeMapLink('https://atlas.example/')).toBeNull();
    expect(decodeMapLink('atlas://remap=1/2/3')).toBeNull();
  });
});

describe('photonFeatureToSearchResult', () => {
  const feature: PhotonFeature = {
    geometry: { type: 'Point', coordinates: [6.19, 58.99] },
    properties: {
      name: 'Preikestolen',
      city: 'Strand',
      state: 'Rogaland',
      country: 'Norway',
      osm_key: 'tourism',
      osm_value: 'attraction',
    },
  };

  it('maps a POI feature', () => {
    expect(photonFeatureToSearchResult(feature)).toEqual({
      name: 'Preikestolen',
      label: 'Strand, Rogaland, Norway',
      position: { lat: 58.99, lng: 6.19 },
      kind: 'tourism/attraction',
    });
  });

  it('falls back to street + housenumber as the name', () => {
    const address = photonFeatureToSearchResult({
      geometry: { type: 'Point', coordinates: [10.75, 59.91] },
      properties: { street: 'Karl Johans gate', housenumber: '1', city: 'Oslo' },
    });
    expect(address?.name).toBe('Karl Johans gate 1');
    expect(address?.label).toBe('Oslo');
  });

  it('rejects features without geometry or name', () => {
    expect(photonFeatureToSearchResult({ properties: { name: 'x' } })).toBeNull();
    expect(
      photonFeatureToSearchResult({ geometry: { type: 'Point', coordinates: [1, 2] } }),
    ).toBeNull();
  });

  it('does not repeat the name in the label', () => {
    const city = photonFeatureToSearchResult({
      geometry: { type: 'Point', coordinates: [10.39, 63.43] },
      properties: { name: 'Trondheim', city: 'Trondheim', country: 'Norway' },
    });
    expect(city?.label).toBe('Norway');
  });
});

describe('resolveStyleTemplate', () => {
  it('substitutes every {origin} placeholder', () => {
    const template =
      '{"glyphs":"{origin}/assets/fonts","tiles":"pmtiles://{origin}/tiles/no.pmtiles"}';
    expect(resolveStyleTemplate(template, 'https://atlas.example')).toBe(
      '{"glyphs":"https://atlas.example/assets/fonts","tiles":"pmtiles://https://atlas.example/tiles/no.pmtiles"}',
    );
  });

  it('leaves templates without placeholders untouched', () => {
    expect(resolveStyleTemplate('{"version":8}', 'https://x')).toBe('{"version":8}');
  });
});

describe('bboxContains', () => {
  const norway: BBox = { sw: { lat: 57.9, lng: 4.5 }, ne: { lat: 71.2, lng: 31.2 } };

  it('contains a point inside', () => {
    expect(bboxContains(norway, { lat: 59.91, lng: 10.75 })).toBe(true); // Oslo
  });

  it('excludes a point outside', () => {
    expect(bboxContains(norway, { lat: 48.85, lng: 2.35 })).toBe(false); // Paris
  });

  it('includes the boundary', () => {
    expect(bboxContains(norway, { lat: 57.9, lng: 4.5 })).toBe(true);
  });
});

describe('place / folder visibility', () => {
  // root (visible) → sub (visible); away (hidden)
  const folders = new Map<string, VisibilityFolder>([
    ['root', { parentId: null, visible: true }],
    ['sub', { parentId: 'root', visible: true }],
    ['away', { parentId: null, visible: false }],
    ['under-away', { parentId: 'away', visible: true }],
  ]);

  it('shows a place whose own flag and folder chain are all visible', () => {
    expect(placeIsVisible({ visible: true, collectionId: 'sub' }, folders)).toBe(true);
    expect(placeIsVisible({ visible: true, collectionId: null }, folders)).toBe(true);
  });

  it('hides a place with its own flag off regardless of folder', () => {
    expect(placeIsVisible({ visible: false, collectionId: 'root' }, folders)).toBe(false);
  });

  it('hides a place when an ancestor folder is hidden', () => {
    expect(placeIsVisible({ visible: true, collectionId: 'away' }, folders)).toBe(false);
    expect(placeIsVisible({ visible: true, collectionId: 'under-away' }, folders)).toBe(false);
  });

  it('treats a dangling parent id as visible', () => {
    expect(collectionIsVisible('ghost', folders)).toBe(true);
  });

  it('does not loop on a cyclic parent chain', () => {
    const cyclic = new Map<string, VisibilityFolder>([
      ['a', { parentId: 'b', visible: true }],
      ['b', { parentId: 'a', visible: true }],
    ]);
    expect(collectionIsVisible('a', cyclic)).toBe(true);
  });
});

describe('matchPlacesByName', () => {
  const places = [
    { name: 'Home' },
    { name: 'Cabin at Norefjell' },
    { name: 'Office (Oslo)' },
    { name: 'Grandma' },
    { name: 'Homebrew shop' },
  ];

  it('ranks whole-name prefix matches before substring matches', () => {
    expect(matchPlacesByName(places, 'home').map((p) => p.name)).toEqual(['Home', 'Homebrew shop']);
    expect(matchPlacesByName(places, 'norefjell').map((p) => p.name)).toEqual([
      'Cabin at Norefjell',
    ]);
  });

  it('is case-insensitive and trims the query', () => {
    expect(matchPlacesByName(places, '  OSLO ').map((p) => p.name)).toEqual(['Office (Oslo)']);
  });

  it('returns nothing for an empty query and respects the limit', () => {
    expect(matchPlacesByName(places, '   ')).toEqual([]);
    expect(matchPlacesByName(places, 'o', 2)).toHaveLength(2);
  });
});

describe('markerScaleForZoom', () => {
  it('keeps full size at city zooms and clamps when far out', () => {
    expect(markerScaleForZoom(12)).toBe(1);
    expect(markerScaleForZoom(16)).toBe(1);
    expect(markerScaleForZoom(7)).toBe(0.5);
    expect(markerScaleForZoom(3)).toBe(0.5);
  });

  it('shrinks monotonically between the clamp zooms', () => {
    expect(markerScaleForZoom(9.5)).toBe(0.75);
    expect(markerScaleForZoom(11)).toBeGreaterThan(markerScaleForZoom(10));
    expect(markerScaleForZoom(10)).toBeGreaterThan(markerScaleForZoom(8));
  });
});

describe('parseCoordinateQuery', () => {
  it('parses decimal degrees with comma or space separators', () => {
    expect(parseCoordinateQuery('59.9139, 10.7522')).toEqual({ lat: 59.9139, lng: 10.7522 });
    expect(parseCoordinateQuery('59.9139 10.7522')).toEqual({ lat: 59.9139, lng: 10.7522 });
    expect(parseCoordinateQuery('  -33.9 ; 151.2 ')).toEqual({ lat: -33.9, lng: 151.2 });
  });

  it('parses hemisphere letters before or after each number', () => {
    expect(parseCoordinateQuery('N 59.9139 E 10.7522')).toEqual({ lat: 59.9139, lng: 10.7522 });
    expect(parseCoordinateQuery('59.9139S, 10.7522W')).toEqual({ lat: -59.9139, lng: -10.7522 });
    expect(parseCoordinateQuery('59.9139° N, 10.7522° E')).toEqual({
      lat: 59.9139,
      lng: 10.7522,
    });
  });

  it('parses decimal commas', () => {
    expect(parseCoordinateQuery('59,9139 10,7522')).toEqual({ lat: 59.9139, lng: 10.7522 });
  });

  it('rejects text, partial pairs and out-of-range values', () => {
    expect(parseCoordinateQuery('Oslo')).toBeNull();
    expect(parseCoordinateQuery('Storgata 59')).toBeNull();
    expect(parseCoordinateQuery('59.9139')).toBeNull();
    expect(parseCoordinateQuery('91, 10')).toBeNull();
    expect(parseCoordinateQuery('59, 181')).toBeNull();
    expect(parseCoordinateQuery('-59.9 S, 10.7 E')).toBeNull();
  });

  it('builds the shared coordinate result', () => {
    expect(coordinateSearchResult({ lat: 59.913912345, lng: 10.7522 })).toEqual({
      name: '59.91391, 10.7522',
      label: 'Coordinates',
      position: { lat: 59.913912345, lng: 10.7522 },
    });
  });
});
