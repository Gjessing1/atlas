import {
  useWeatherGrid,
  useWeatherMaps,
  type PotentialView,
  type WeatherMapsController,
} from '@atlas/app-hooks';
import { WEATHER_WARNINGS_ID, weatherGridLabels } from '@atlas/conditions';
import { useMemo } from 'react';
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
  return { maps, opacity: active?.opacity ?? 0.8, labels };
}

const WARNINGS_REFRESH_MS = 5 * 60_000;

/** MET's live warning areas and badges while the Weather warnings layer is on. */
export function useWeatherWarnings(
  overlays: ActiveOverlay[],
  origin: string,
): VectorOverlayData | null {
  return useVectorOverlay(overlays, origin, WEATHER_WARNINGS_ID, WARNINGS_REFRESH_MS);
}
