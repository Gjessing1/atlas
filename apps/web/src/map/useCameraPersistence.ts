import type { MapViewState } from '@atlas/core';
import type maplibregl from 'maplibre-gl';
import { useEffect } from 'react';

/** Where the camera is remembered between visits. */
const LAST_VIEW_SETTING = 'lastView';

export interface CameraSettings {
  status: string;
  getSetting: (key: string) => Promise<string | null>;
  setSetting: (key: string, value: string) => void;
}

/** Parse a persisted camera; null when absent or malformed. */
export function parseView(raw: string | null): MapViewState | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { center?: { lat?: number; lng?: number }; zoom?: number };
    const { lat, lng } = v.center ?? {};
    if (![lat, lng, v.zoom].every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
    return { center: { lat: lat!, lng: lng! }, zoom: v.zoom! };
  } catch {
    return null;
  }
}

/**
 * Auto-saves the camera, and restores it on startup when the URL carried no
 * view hash — a share link always wins over where the user last happened to be.
 *
 * `startedAt` is the view the map was created with, and the restore only fires
 * while the camera still sits exactly there. That is the one honest signal that
 * the user has not moved yet: the URL hash is no use, because the map echoes
 * the camera into it on load, and jumping a map someone has already panned is
 * worse than not restoring at all.
 */
export function useCameraPersistence(
  map: maplibregl.Map | null,
  settings: CameraSettings,
  startedAt: MapViewState,
  restore: boolean,
): void {
  const { status, getSetting, setSetting } = settings;
  useEffect(() => {
    if (!map || status !== 'ready') return;
    if (restore) {
      void getSetting(LAST_VIEW_SETTING).then((raw) => {
        const view = parseView(raw);
        if (!view) return;
        const center = map.getCenter();
        const untouched =
          Math.abs(map.getZoom() - startedAt.zoom) < 0.01 &&
          Math.abs(center.lat - startedAt.center.lat) < 1e-6 &&
          Math.abs(center.lng - startedAt.center.lng) < 1e-6;
        if (untouched) map.jumpTo({ center: view.center, zoom: view.zoom });
      });
    }
    const save = () => {
      const center = map.getCenter();
      setSetting(
        LAST_VIEW_SETTING,
        JSON.stringify({ center: { lat: center.lat, lng: center.lng }, zoom: map.getZoom() }),
      );
    };
    map.on('moveend', save);
    return () => {
      map.off('moveend', save);
    };
  }, [map, status, getSetting, setSetting, startedAt, restore]);
}
