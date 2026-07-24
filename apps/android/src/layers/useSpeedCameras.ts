import type { ActiveOverlay } from './useOverlays';
import { useVectorOverlay, type VectorOverlayData } from './useVectorOverlay';

/** Catalog id of the ATK speed-camera vector overlay (the Drive signature layer). */
export const SPEED_CAMERAS_ID = 'speed-cameras';

/** The camera coverage ready for MapScene's GeoJSON source, plus its opacity. */
export type SpeedCameras = VectorOverlayData;

/**
 * The ATK speed cameras while the `speed-cameras` vector overlay is on
 * (Android twin of the web's useSpeedCameraLayer). One country-sized fetch —
 * 446 point cameras and 73 average-speed sections, ~840 kB — small enough that
 * viewport tiling would only add moving parts.
 *
 * Independent of the *guidance* warnings, which have their own offline-first
 * path (`makeNvdbCameraTransport` reads a downloaded pack's `nvdb.sqlite`).
 * This is the map layer: it needs the network, like every other overlay.
 */
export function useSpeedCameras(overlays: ActiveOverlay[], origin: string): SpeedCameras | null {
  return useVectorOverlay(overlays, origin, SPEED_CAMERAS_ID);
}
