import { describe, expect, it } from 'vitest';
import {
  coordinateSearchResult,
  matchPlacesByName,
  parseAddressQuery,
  savedPlaceResults,
  parseCoordinateQuery,
  photonFeatureToSearchResult,
  photonSearchResults,
  type PhotonFeature,
} from './index.js';

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
      address: 'Strand, Rogaland, Norway',
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
    expect(address?.address).toBe('Karl Johans gate 1, Oslo');
  });

  it('shows the postcode and the county, so a near-miss is visible', () => {
    // The live case: a query for "Alfheim 7 1387 Asker" matches 1384.
    const address = photonFeatureToSearchResult({
      geometry: { type: 'Point', coordinates: [10.4364, 59.8339] },
      properties: {
        street: 'Alfheim',
        housenumber: '7',
        postcode: '1384',
        city: 'Asker',
        county: 'Akershus',
        country: 'Norge',
      },
    });
    expect(address?.label).toBe('1384 Asker, Akershus, Norge');
    expect(address?.address).toBe('Alfheim 7, 1384 Asker, Akershus, Norge');
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

  it('keeps the postcode when the place would only repeat the name', () => {
    const city = photonFeatureToSearchResult({
      geometry: { type: 'Point', coordinates: [10.39, 63.43] },
      properties: { name: 'Trondheim', postcode: '7010', city: 'Trondheim', country: 'Norge' },
    });
    expect(city?.label).toBe('7010, Norge');
  });
});

describe('parseAddressQuery', () => {
  it('reads a pasted postal address', () => {
    expect(parseAddressQuery('Dælimosen 57, 1359 Eiksmarka')).toEqual({
      query: 'Dælimosen 57, 1359 Eiksmarka',
      postcode: '1359',
      houseNumber: '57',
      // Loosen one constraint at a time: the postcode first, then the number.
      fallbacks: ['Dælimosen 57, Eiksmarka', 'Dælimosen Eiksmarka'],
    });
  });

  it('reads a letter suffix and an address with no postcode', () => {
    expect(parseAddressQuery('Storgata 10A Oslo')).toMatchObject({
      houseNumber: '10A',
      fallbacks: ['Storgata Oslo'],
    });
    expect(parseAddressQuery('Storgata 10A Oslo').postcode).toBeUndefined();
  });

  it('leaves an ordinary place query alone', () => {
    expect(parseAddressQuery('  Preikestolen ')).toEqual({
      query: 'Preikestolen',
      fallbacks: [],
    });
  });

  it('never offers an empty or duplicate fallback', () => {
    // A bare postcode has nothing left once it is dropped.
    expect(parseAddressQuery('1359').fallbacks).toEqual([]);
    expect(parseAddressQuery('Storgata 10').fallbacks).toEqual(['Storgata']);
  });
});

describe('photonSearchResults', () => {
  const street = (postcode: string): PhotonFeature => ({
    geometry: { type: 'Point', coordinates: [10.74, 59.91] },
    properties: { name: 'Karl Johans gate', postcode, city: 'Oslo', country: 'Norge' },
  });
  const house: PhotonFeature = {
    geometry: { type: 'Point', coordinates: [10.75, 59.91] },
    properties: {
      street: 'Karl Johans gate',
      housenumber: '22',
      postcode: '0026',
      city: 'Oslo',
      country: 'Norge',
    },
  };

  it('floats the typed house number above postcode-matching street segments', () => {
    // Photon's own order: three segments of the street first, the house last.
    const results = photonSearchResults(
      [street('0159'), street('0154'), street('0153'), house],
      parseAddressQuery('Karl Johans gate 22, 0159 Oslo'),
    );
    expect(results[0]?.name).toBe('Karl Johans gate 22');
  });

  it('collapses one street returned as several postal segments', () => {
    // The postcode is in the label but must not be in the collapse key, or one
    // street through three postal areas becomes three rows to the same place.
    const results = photonSearchResults([street('0159'), street('0154'), street('0153')]);
    expect(results).toHaveLength(1);
    expect(results[0]?.label).toBe('0159 Oslo, Norge');
  });

  it('keeps photon order within a tier and drops unusable features', () => {
    const results = photonSearchResults(
      [{ properties: { name: 'broken' } }, street('0154'), house],
      parseAddressQuery('Karl Johans gate Oslo'),
    );
    expect(results.map((r) => r.name)).toEqual(['Karl Johans gate', 'Karl Johans gate 22']);
  });

  it('collapses onto the segment the user actually typed', () => {
    const results = photonSearchResults(
      [street('0154'), street('0159')],
      parseAddressQuery('Karl Johans gate 0159 Oslo'),
    );
    // One street, so one row — but it must be the postcode that was asked for,
    // not whichever segment Photon happened to return first.
    expect(results).toHaveLength(1);
    expect(results[0]?.label).toBe('0159 Oslo, Norge');
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

describe('savedPlaceResults', () => {
  const places = [
    { name: 'Bogdan og Ada', lat: 59.91, lng: 10.75, notes: 'Storgata 1, Oslo' },
    { name: 'Cabin', lat: 60.15, lng: 9.55, notes: '' },
    { name: 'Dentist', lat: 59.92, lng: 10.71, notes: 'Kirkeveien 12' },
  ];

  it('finds a saved place by name — the hit no geocoder can produce', () => {
    expect(savedPlaceResults(places, 'bogdan')).toEqual([
      { name: 'Bogdan og Ada', label: 'Saved place', position: { lat: 59.91, lng: 10.75 } },
    ]);
  });

  it('also matches notes, where addresses get pasted today', () => {
    expect(savedPlaceResults(places, 'kirkeveien').map((r) => r.name)).toEqual(['Dentist']);
  });

  it('matches and labels a saved place by its first-class address', () => {
    const result = savedPlaceResults(
      [
        {
          name: 'Office',
          address: 'Karl Johans gate 1, Oslo',
          notes: '',
          lat: 59.91,
          lng: 10.75,
        },
      ],
      'johans',
    );
    expect(result).toEqual([
      {
        name: 'Office',
        label: 'Karl Johans gate 1, Oslo',
        address: 'Karl Johans gate 1, Oslo',
        position: { lat: 59.91, lng: 10.75 },
      },
    ]);
  });

  it('answers "show me my stands" from the tags the app itself writes', () => {
    const stands = [
      { name: 'Elgpost nord', lat: 61.1, lng: 9.2, tags: ['hunt', 'spot', 'stand'] },
      { name: 'Elgpost sør', lat: 61.0, lng: 9.3, tags: ['hunt', 'spot', 'stand'] },
      ...places,
    ];
    expect(savedPlaceResults(stands, 'stand').map((r) => r.name)).toEqual([
      'Elgpost nord',
      'Elgpost sør',
    ]);
  });

  it('ranks a tag match above the free-text fields, and a name above both', () => {
    const mixed = [
      { name: 'Notes hit', lat: 59, lng: 10, notes: 'left the boat by the stand' },
      { name: 'Tagged', lat: 59, lng: 10, tags: ['stand'] },
      { name: 'Standplass', lat: 59, lng: 10, notes: '' },
    ];
    expect(savedPlaceResults(mixed, 'stand').map((r) => r.name)).toEqual([
      'Standplass',
      'Tagged',
      'Notes hit',
    ]);
  });

  it('ranks name matches above notes matches', () => {
    const withNotesHit = [{ name: 'Ferry', lat: 59, lng: 10, notes: 'near the cabin' }, ...places];
    expect(savedPlaceResults(withNotesHit, 'cabin').map((r) => r.name)).toEqual(['Cabin', 'Ferry']);
  });

  it('returns nothing for an empty query and respects the limit', () => {
    expect(savedPlaceResults(places, '  ')).toEqual([]);
    expect(savedPlaceResults(places, 'a', 2)).toHaveLength(2);
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
