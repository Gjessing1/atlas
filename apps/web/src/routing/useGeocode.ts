import type { LatLng, SearchResult } from '@atlas/core';
import type { StopGeocodeFn } from '@atlas/app-hooks';
import { fetchTransitStops, mergeTransitSearchResults } from '@atlas/transit';
import { useCallback } from 'react';

/**
 * Geocoding for the stop search: the same-origin Photon proxy, biased towards
 * the current viewport so a typed street resolves near where the user is
 * looking. Browsing for stops *on the route* does not come through here — it is
 * a category query against the explore endpoint (see AlongRouteStops).
 *
 * Lives in its own module because the route planner is no longer the only
 * surface that picks a stop: the commute board's From / Via / To use the same
 * seam, and a second copy of "rank Entur stops ahead of addresses" is how the
 * two would start disagreeing about what a stop is.
 */
export function useGeocode(getBias: () => LatLng | null): StopGeocodeFn {
  return useCallback(
    async ({ text, bbox, limit, signal, transit }) => {
      const params = new URLSearchParams({ q: text });
      if (limit !== undefined) params.set('limit', String(limit));
      const bias = bbox ? null : getBias();
      if (bbox) params.set('bbox', bbox);
      else if (bias) {
        params.set('lat', String(bias.lat));
        params.set('lon', String(bias.lng));
      }
      const general = async (): Promise<SearchResult[]> => {
        const res = await fetch(`/api/search?${params}`, { signal });
        if (!res.ok) throw new Error(`search: HTTP ${res.status}`);
        return ((await res.json()) as { results: SearchResult[] }).results;
      };
      if (!transit) return { results: await general(), offline: false };

      const [stops, addresses] = await Promise.allSettled([
        fetchTransitStops(text, { signal, bias, limit }),
        general(),
      ]);
      if (stops.status === 'rejected' && addresses.status === 'rejected') {
        throw new Error('online search unavailable');
      }
      return {
        results: mergeTransitSearchResults(
          stops.status === 'fulfilled' ? stops.value : [],
          addresses.status === 'fulfilled' ? addresses.value : [],
          limit ?? 8,
        ),
        offline: false,
      };
    },
    [getBias],
  );
}
