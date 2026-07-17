import { describe, expect, it } from 'vitest';
import {
  bboxContains,
  collectionIsVisible,
  decodeMapHash,
  encodeMapHash,
  markerScaleForZoom,
  matchPlacesByName,
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
