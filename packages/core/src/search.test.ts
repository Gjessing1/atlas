import { describe, expect, it } from 'vitest';
import {
  coordinateSearchResult,
  matchPlacesByName,
  savedPlaceResults,
  parseCoordinateQuery,
  photonFeatureToSearchResult,
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
