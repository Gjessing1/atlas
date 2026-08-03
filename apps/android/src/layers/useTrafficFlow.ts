import type { ActiveOverlay } from './useOverlays';
import { useVectorOverlay, type VectorOverlayData } from './useVectorOverlay';

export const TRAFFIC_FLOW_ID = 'traffic-flow';
/** NPRA republishes every five minutes; the backend caches for one. */
const REFRESH_MS = 2 * 60_000;

/** How the measured NPRA corridors are running, while the flow layer is on. */
export function useTrafficFlow(
  overlays: ActiveOverlay[],
  origin: string,
): VectorOverlayData | null {
  return useVectorOverlay(overlays, origin, TRAFFIC_FLOW_ID, REFRESH_MS);
}
