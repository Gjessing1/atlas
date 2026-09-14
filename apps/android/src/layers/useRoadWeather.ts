import type { ActiveOverlay } from './useOverlays';
import { useVectorOverlay, type VectorOverlayData } from './useVectorOverlay';

export const ROAD_WEATHER_ID = 'road-weather';
const REFRESH_MS = 3 * 60_000;

/** Current NPRA road-surface readings while the Road weather layer is enabled. */
export function useRoadWeather(
  overlays: ActiveOverlay[],
  origin: string,
): VectorOverlayData | null {
  return useVectorOverlay(overlays, origin, ROAD_WEATHER_ID, REFRESH_MS);
}
