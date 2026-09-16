import {
  useWeatherGrid,
  useWeatherMaps,
  type ActiveWeatherMapFrame,
  type PotentialView,
  type WeatherMapsController,
} from '@atlas/app-hooks';
import { WEATHER_FRAME_FADE, WEATHER_WARNINGS_ID, weatherGridLabels } from '@atlas/conditions';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useWindowDimensions } from 'react-native';

import type { ActiveOverlay } from './useOverlays';
import { useVectorOverlay, type VectorOverlayData } from './useVectorOverlay';

export interface WeatherLayers {
  /** The switched-on weather field's timeline (idle when none is on). */
  maps: WeatherMapsController;
  /** That field's opacity from the layer controls. */
  opacity: number;
  /**
   * Arrows with speeds for wind, numbers for the temperature fields, on a grid
   * over the settled viewport — what the web draws as particles and town
   * numbers. Null for the other fields.
   */
  labels: GeoJSON.FeatureCollection | null;
  /** The frames to mount, in the order they were first mounted (see useWeatherFrameStack). */
  stack: WeatherFrameLayer[];
  /** Feed MapLibre's render events here: they are how a frame is known to be loaded. */
  onRenderedFrame: (fully: boolean) => void;
}

export interface WeatherFrameLayer {
  frame: ActiveWeatherMapFrame;
  /** `shown` is drawn; `fading` is leaving over the next frame; `loading` waits unseen. */
  role: 'shown' | 'fading' | 'loading';
}

/**
 * How long a frame must have been mounted before a "fully rendered" map counts
 * for it: render events are delivered asynchronously, and one from a frame drawn
 * before the mount would otherwise vouch for tiles nobody had asked for yet.
 */
const MOUNT_SETTLE_MS = 400;
/** A frame that never finishes loading is shown after this, rather than never. */
const SHOW_ANYWAY_MS = 3_000;
const FADE_OUT_TOTAL_MS = WEATHER_FRAME_FADE.outDelayMs + WEATHER_FRAME_FADE.outMs;

/**
 * Which weather frames MapScene mounts, and how each is drawn — the Android
 * half of the web's useWeatherMapLayer.
 *
 * MapLibre Native cannot be asked whether one source has loaded, but it reports
 * every rendered frame and whether that frame was complete. A frame mounted a
 * moment ago, on a map whose latest render was complete, has its tiles. Until
 * then the picture before it stays up; after, the new one crossfades in over it
 * (WEATHER_FRAME_FADE). Play asks the same question before stepping.
 *
 * The stack keeps first-mount order: each frame is inserted beneath the weather
 * anchor, so mount order *is* the drawing order, and reordering React children
 * would make the native side remove and re-add sources — the blank flash this
 * exists to prevent.
 */
function useWeatherFrameStack(maps: WeatherMapsController) {
  const renderRef = useRef({ fully: false });
  const mountedAt = useRef(new Map<string, number>());
  const [shown, setShown] = useState<ActiveWeatherMapFrame | null>(null);
  const [fading, setFading] = useState<ActiveWeatherMapFrame[]>([]);
  const shownRef = useRef(shown);
  shownRef.current = shown;
  // One unmount timer per fading frame: a frame that fades, returns and fades
  // again must not be taken down by its first timer halfway through the second.
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach((timer) => clearTimeout(timer));
  }, []);

  const current = maps.frame;
  const wanted = useMemo(
    () => (current && maps.timeline ? [current, ...maps.upcoming] : []),
    [current, maps.timeline, maps.upcoming],
  );

  const ready = useCallback((frameId: string) => {
    const at = mountedAt.current.get(frameId);
    return at !== undefined && Date.now() - at >= MOUNT_SETTLE_MS && renderRef.current.fully;
  }, []);
  const { setFrameReadiness } = maps;
  useEffect(() => {
    setFrameReadiness(ready);
    return () => setFrameReadiness(null);
  }, [setFrameReadiness, ready]);

  // Show the wanted frame once it is ready, fading the one it replaces.
  const currentId = current?.id ?? null;
  useEffect(() => {
    if (!current) {
      setShown(null);
      setFading([]);
      return;
    }
    if (shownRef.current?.id === current.id) return;
    const since = Date.now();
    const swap = () => {
      const previous = shownRef.current;
      if (previous && !ready(current.id) && Date.now() - since < SHOW_ANYWAY_MS) return false;
      setShown(current);
      setFading((list) => [
        ...list.filter((f) => f.id !== current.id && f.id !== previous?.id),
        ...(previous && previous.id !== current.id ? [previous] : []),
      ]);
      if (previous) {
        clearTimeout(timers.current.get(previous.id));
        timers.current.set(
          previous.id,
          setTimeout(() => {
            timers.current.delete(previous.id);
            setFading((list) => list.filter((f) => f.id !== previous.id));
          }, FADE_OUT_TOTAL_MS + 50),
        );
      }
      return true;
    };
    if (swap()) return;
    const poll = setInterval(() => {
      if (swap()) clearInterval(poll);
    }, 100);
    return () => clearInterval(poll);
    // `current` changes identity with every catalog refresh; its id is what matters.
  }, [currentId, ready]);

  // First-mount order, kept across renders.
  const order = useRef<string[]>([]);
  const byId = new Map<string, WeatherFrameLayer>();
  for (const frame of wanted) byId.set(frame.id, { frame, role: 'loading' });
  for (const frame of fading) byId.set(frame.id, { frame, role: 'fading' });
  if (shown && current) byId.set(shown.id, { frame: shown, role: 'shown' });
  order.current = [
    ...order.current.filter((id) => byId.has(id)),
    ...[...byId.keys()].filter((id) => !order.current.includes(id)),
  ];
  const stack = order.current.map((id) => byId.get(id)!);
  const stackKey = order.current.join(',');

  useEffect(() => {
    const now = Date.now();
    const ids = new Set(stackKey.split(',').filter(Boolean));
    for (const id of ids) if (!mountedAt.current.has(id)) mountedAt.current.set(id, now);
    for (const id of [...mountedAt.current.keys()]) if (!ids.has(id)) mountedAt.current.delete(id);
  }, [stackKey]);

  const onRenderedFrame = useCallback((fully: boolean) => {
    renderRef.current.fully = fully;
  }, []);

  return { stack, onRenderedFrame };
}

/** Density of the label grid, in dp of screen per cell. */
const WIND_CELL_DP = 70;
const VALUE_CELL_DP = 95;

/**
 * The weather layers' state for MapScene and the dock — the Android half of the
 * web App's weather wiring. The timeline itself is the shared `useWeatherMaps`.
 */
export function useWeatherLayers(
  overlays: ActiveOverlay[],
  origin: string,
  viewport: PotentialView | null,
): WeatherLayers {
  const active = overlays.find((overlay) => overlay.meta.weather);
  const maps = useWeatherMaps(origin, active?.meta.weather?.layer ?? null);
  const window = useWindowDimensions();
  const wind = maps.layerId === 'wind';
  const values = maps.layerId === 'temperature' || maps.layerId === 'sea-temperature';
  const cell = wind ? WIND_CELL_DP : VALUE_CELL_DP;
  const w = viewport?.bbox[0];
  const s = viewport?.bbox[1];
  const e = viewport?.bbox[2];
  const n = viewport?.bbox[3];
  const gridViewport = useMemo(() => {
    if (w === undefined || s === undefined || e === undefined || n === undefined) return null;
    const west = Math.max(-180, w);
    const east = Math.min(180, e);
    const south = Math.max(-85, s);
    const north = Math.min(85, n);
    if (west >= east || south >= north) return null;
    return {
      bbox: [west, south, east, north] as [number, number, number, number],
      cols: Math.max(2, Math.min(60, Math.round(window.width / cell))),
      rows: Math.max(2, Math.min(60, Math.round(window.height / cell))),
    };
  }, [w, s, e, n, window.width, window.height, cell]);
  const grid = useWeatherGrid(origin, maps, gridViewport, wind || values);
  const labels = useMemo(() => (grid ? weatherGridLabels(grid) : null), [grid]);
  const { stack, onRenderedFrame } = useWeatherFrameStack(maps);
  return { maps, opacity: active?.opacity ?? 0.8, labels, stack, onRenderedFrame };
}

const WARNINGS_REFRESH_MS = 5 * 60_000;

/** MET's live warning areas and badges while the Weather warnings layer is on. */
export function useWeatherWarnings(
  overlays: ActiveOverlay[],
  origin: string,
): VectorOverlayData | null {
  return useVectorOverlay(overlays, origin, WEATHER_WARNINGS_ID, WARNINGS_REFRESH_MS);
}
