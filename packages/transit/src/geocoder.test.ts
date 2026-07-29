import type { SearchResult } from '@atlas/core';
import { describe, expect, it, vi } from 'vitest';

import { fetchTransitStops } from './client.js';
import {
  isTransitStopId,
  mergeTransitSearchResults,
  parseEnturGeocoderResponse,
} from './geocoder.js';

const response = {
  type: 'FeatureCollection',
  features: [
    {
      geometry: { type: 'Point', coordinates: [10.753051, 59.910357] },
      properties: {
        id: 'NSR:StopPlace:59872',
        name: 'Oslo S',
        label: 'Oslo S, Oslo',
        layer: 'venue',
        category: ['onstreetBus', 'railStation'],
        locality: 'Oslo',
      },
    },
    {
      geometry: { type: 'Point', coordinates: [10.75, 59.91] },
      properties: {
        id: 'openstreetmap:address:123',
        name: 'Not a stop',
        label: 'Not a stop, Oslo',
        layer: 'address',
      },
    },
  ],
};

describe('parseEnturGeocoderResponse', () => {
  it('keeps exact NSR stop identity and drops non-stop features', () => {
    expect(parseEnturGeocoderResponse(response)).toEqual([
      {
        name: 'Oslo S',
        label: 'Bus · Train · Oslo',
        position: { lat: 59.910357, lng: 10.753051 },
        kind: 'public_transport/onstreetBus',
        transitStopId: 'NSR:StopPlace:59872',
      },
    ]);
  });

  it('rejects malformed ids and coordinates defensively', () => {
    expect(
      parseEnturGeocoderResponse({
        features: [
          {
            geometry: { type: 'Point', coordinates: [10, 200] },
            properties: {
              id: 'NSR:StopPlace:1',
              name: 'Impossible',
              layer: 'venue',
            },
          },
          {
            geometry: { type: 'Point', coordinates: [10, 60] },
            properties: { id: 'not-an-id', name: 'Unpinned', layer: 'venue' },
          },
        ],
      }),
    ).toEqual([]);
    expect(isTransitStopId('NSR:StopPlace:59872')).toBe(true);
    expect(isTransitStopId('NSR:Quay:123')).toBe(false);
  });
});

describe('mergeTransitSearchResults', () => {
  it('ranks stops first and removes the nearby Photon duplicate', () => {
    const stop = parseEnturGeocoderResponse(response)[0]!;
    const general: SearchResult[] = [
      { name: 'Oslo S', label: 'Oslo', position: { lat: 59.9104, lng: 10.7531 } },
      { name: 'Oslo City', label: 'Oslo', position: { lat: 59.912, lng: 10.751 } },
    ];
    expect(mergeTransitSearchResults([stop], general).map((result) => result.name)).toEqual([
      'Oslo S',
      'Oslo City',
    ]);
  });

  it('keeps same-named stops in different places', () => {
    const stop = parseEnturGeocoderResponse(response)[0]!;
    const distant: SearchResult = {
      name: 'Oslo S',
      label: 'Somewhere else',
      position: { lat: 60.5, lng: 10.7 },
    };
    expect(mergeTransitSearchResults([stop], [distant])).toHaveLength(2);
  });
});

describe('fetchTransitStops', () => {
  it('uses the Atlas proxy with limit and viewport bias', async () => {
    let seen = '';
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      seen = String(input);
      return new Response(
        JSON.stringify({
          results: [
            {
              name: 'Oslo S',
              label: 'Oslo',
              position: { lat: 59.910357, lng: 10.753051 },
              transitStopId: 'NSR:StopPlace:59872',
            },
          ],
        }),
        { status: 200 },
      );
    });

    const results = await fetchTransitStops('Oslo S', {
      baseUrl: 'https://atlas.example',
      limit: 4,
      bias: { lat: 59.91, lng: 10.75 },
      fetchImpl,
    });

    const url = new URL(seen);
    expect(url.pathname).toBe('/api/transit/stops');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      q: 'Oslo S',
      limit: '4',
      lat: '59.91',
      lon: '10.75',
    });
    expect(results[0]?.transitStopId).toBe('NSR:StopPlace:59872');
  });
});
