import type { StopGeocodeFn } from '@atlas/app-hooks';
import { useCallback } from 'react';

import type { LocalPack } from '../regions/packs';
import { geoSearch, type SearchBias } from '../search/geoSearch';

/**
 * Geocoding for the stop searches: the server's Photon proxy when reachable,
 * the downloaded packs' FTS index when it isn't — so a stop can be searched
 * for with no network at all. Viewport bias applies only to the free stop
 * search; an along-route search is already constrained by the route's bbox.
 *
 * The planner shares this search seam across its stop controls.
 */
export function useGeocode(packs: LocalPack[], getBias: SearchBias): StopGeocodeFn {
  return useCallback(
    async ({ text, bbox, limit, signal, transit }) => {
      return geoSearch(packs, text, bbox ? undefined : getBias, {
        bbox,
        limit,
        signal,
        transit,
      });
    },
    [packs, getBias],
  );
}
