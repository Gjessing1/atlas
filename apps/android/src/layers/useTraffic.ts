import type { ActiveOverlay } from './useOverlays';
import { useVectorOverlay, type VectorOverlayData } from './useVectorOverlay';

export const TRAFFIC_ID = 'traffic';
const REFRESH_MS = 3 * 60_000;

/** Current NPRA DATEX markers while the driving traffic layer is enabled. */
export function useTraffic(overlays: ActiveOverlay[], origin: string): VectorOverlayData | null {
  return useVectorOverlay(overlays, origin, TRAFFIC_ID, REFRESH_MS);
}
