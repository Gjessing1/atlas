import type { ActiveOverlay } from './useOverlays';
import { useVectorOverlay, type VectorOverlayData } from './useVectorOverlay';

/** Catalog id of the Statskog storviltjaktfelt vector overlay. */
export const STATSKOG_JAKTFELT_ID = 'statskog-jaktfelt';

/** The jaktfelt coverage ready for MapScene's GeoJSON source, plus its opacity. */
export type HuntingFields = VectorOverlayData;

/**
 * The Statskog hunting-fields coverage while the `statskog-jaktfelt` vector
 * overlay is on (Android twin of the web's useHuntingFieldsLayer): 922
 * polygons, server-simplified to ~4.4 MB, in one country-sized fetch. The fetch
 * discipline itself lives in `useVectorOverlay`, shared with the cameras.
 */
export function useHuntingFields(overlays: ActiveOverlay[], origin: string): HuntingFields | null {
  return useVectorOverlay(overlays, origin, STATSKOG_JAKTFELT_ID);
}
