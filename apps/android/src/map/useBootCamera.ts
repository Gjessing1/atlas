import { decodeMapLink, type LatLng } from '@atlas/core';
import type { CameraRef } from '@maplibre/maplibre-react-native';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Dimensions, Linking } from 'react-native';
import type { RefObject } from 'react';

import { labelCellFor } from '../layers/useOverlayLabels';
import { DEFAULT_VIEW } from './MapScene';

/** Settings key for the persisted camera (device-local — `local.` never syncs). */
const CAMERA_SETTING = 'local.map.camera';
/** How long the camera must sit still before it is written back. */
const PERSIST_DEBOUNCE_MS = 800;

export interface MapView {
  center: LatLng;
  zoom: number;
}

export interface BootCameraSettings {
  status: string;
  getSetting: (key: string) => Promise<string | null>;
  setSetting: (key: string, value: string) => void;
}

export interface BootCamera {
  /**
   * Where the map should open. Null until resolved — the app holds at the
   * loading screen so the very first frame is already in the right place
   * (no flash of the default view before jumping).
   */
  initialView: MapView | null;
  /** Latest settled camera — feeds the search bias, share links and restyles. */
  viewRef: RefObject<MapView | null>;
  /** Rounded zoom, for controls that offer "zoom in to z14+" hints. */
  mapZoom: number;
  /** Snapped viewport key for on-map overlay labels (see labelCellFor). */
  labelCell: string | null;
  onViewChange: (view: MapView) => void;
  /** Viewport bias for geocoding (web parity: SearchBox sends lat/lon). */
  getBias: () => Promise<LatLng | null>;
}

/** Parse a persisted camera setting; null when absent or malformed. */
export function parseCameraSetting(raw: string | null): MapView | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { lat?: number; lng?: number; zoom?: number };
    if (![v.lat, v.lng, v.zoom].every((n) => typeof n === 'number' && Number.isFinite(n)))
      return null;
    return { center: { lat: v.lat!, lng: v.lng! }, zoom: v.zoom! };
  } catch {
    return null;
  }
}

/**
 * Decides where the map opens, keeps track of where it is now, and remembers
 * that for next launch.
 *
 * A `#map=` launch link (share link or `atlas:` deep link) always wins over the
 * persisted view: someone who tapped a link to a place means to see that place.
 * Links arriving while the app is already running fly there instead. Either way
 * a pin in the link is handed to `onLinkPin`, so the app can show its card.
 */
export function useBootCamera(
  settings: BootCameraSettings,
  cameraRef: RefObject<CameraRef | null>,
  onLinkPin: (pin: LatLng) => void,
): BootCamera {
  const { status, getSetting, setSetting } = settings;
  const [initialView, setInitialView] = useState<MapView | null>(null);
  const [mapZoom, setMapZoom] = useState(DEFAULT_VIEW.zoom);
  const [labelCell, setLabelCell] = useState<string | null>(null);
  const viewRef = useRef<MapView | null>(null);
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Through a ref: the deep-link subscription is set up once, and must not be
  // torn down and rebuilt whenever the app re-renders with a fresh callback.
  const onLinkPinRef = useRef(onLinkPin);
  onLinkPinRef.current = onLinkPin;

  // Resolve the boot camera once storage has settled.
  useEffect(() => {
    if (status === 'loading' || initialView !== null) return;
    let cancelled = false;
    void (async () => {
      const launch = decodeMapLink((await Linking.getInitialURL().catch(() => null)) ?? '');
      if (cancelled) return;
      if (launch) {
        setInitialView({ center: launch.center, zoom: launch.zoom });
        if (launch.pin) onLinkPinRef.current(launch.pin);
        return;
      }
      const saved = parseCameraSetting(await getSetting(CAMERA_SETTING));
      if (!cancelled) setInitialView(saved ?? DEFAULT_VIEW);
    })();
    return () => {
      cancelled = true;
    };
  }, [status, initialView, getSetting]);

  // #map= links arriving while the app is running: fly there, pin included.
  useEffect(() => {
    const sub = Linking.addEventListener('url', ({ url }) => {
      const view = decodeMapLink(url);
      if (!view) return;
      if (view.pin) onLinkPinRef.current(view.pin);
      cameraRef.current?.flyTo({
        center: [view.center.lng, view.center.lat],
        zoom: view.zoom,
        duration: 900,
      });
    });
    return () => sub.remove();
  }, [cameraRef]);

  // Track the settled camera and persist it (debounced) as the boot view.
  const onViewChange = useCallback(
    (view: MapView) => {
      viewRef.current = view;
      setMapZoom(Math.round(view.zoom));
      setLabelCell(labelCellFor(view.center, view.zoom, Dimensions.get('window')));
      if (persistTimer.current) clearTimeout(persistTimer.current);
      persistTimer.current = setTimeout(() => {
        setSetting(
          CAMERA_SETTING,
          JSON.stringify({
            lat: Number(view.center.lat.toFixed(5)),
            lng: Number(view.center.lng.toFixed(5)),
            zoom: Number(view.zoom.toFixed(2)),
          }),
        );
      }, PERSIST_DEBOUNCE_MS);
    },
    [setSetting],
  );

  const getBias = useCallback(async () => viewRef.current?.center ?? null, []);

  return { initialView, viewRef, mapZoom, labelCell, onViewChange, getBias };
}
