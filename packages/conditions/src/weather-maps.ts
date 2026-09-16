/**
 * Time-addressed weather-map data shared by the backend and both clients.
 *
 * The raster colours are produced by MET Norway's public yr-maps service. The
 * scales below are deliberately client-owned presentation data: every client
 * shows the same units, stops and explanation beside those pixels, while the
 * backend remains the only component that knows the upstream tile URLs.
 */

export type WeatherMapLayerId =
  'precipitation' | 'temperature' | 'wind' | 'clouds' | 'sea-temperature';

export type WeatherMapFrameKind = 'observation' | 'nowcast' | 'forecast';

export interface WeatherMapLegendStop {
  /** Short label drawn under the scale. */
  label: string;
  color: string;
}

export interface WeatherMapLayerSpec {
  id: WeatherMapLayerId;
  title: string;
  description: string;
  unit: string;
  legend: readonly WeatherMapLegendStop[];
}

export interface WeatherMapFrame {
  /** Opaque, URL-safe server id. */
  id: string;
  /** Forecast/observation validity in ISO-8601 UTC. */
  time: string;
  kind: WeatherMapFrameKind;
  /** Same-origin path template. The shared hook makes it absolute on Android. */
  tilePath: string;
}

export interface WeatherMapLayer extends WeatherMapLayerSpec {
  bounds: readonly [number, number, number, number];
  minzoom: number;
  maxzoom: number;
  frames: WeatherMapFrame[];
}

export interface WeatherMapsResponse {
  layers: WeatherMapLayer[];
  attribution: string;
  /** Why lightning is not silently offered as though it were another public tile set. */
  lightning: {
    available: false;
    reason: string;
  };
}

export const WEATHER_MAP_LAYER_SPECS: readonly WeatherMapLayerSpec[] = [
  {
    id: 'precipitation',
    title: 'Precipitation',
    description: 'Radar history, short nowcast, then forecast',
    unit: 'mm/h',
    legend: [
      { label: '0.1', color: '#b7e3ff' },
      { label: '1', color: '#4aa8ed' },
      { label: '3', color: '#2464c4' },
      { label: '10', color: '#7b3fb2' },
      { label: '30', color: '#e33b33' },
      { label: '50+', color: '#ffb21c' },
    ],
  },
  {
    id: 'temperature',
    title: 'Temperature',
    description: 'Air temperature forecast',
    unit: '°C',
    legend: [
      { label: '−30', color: '#57278f' },
      { label: '−20', color: '#315cc5' },
      { label: '−10', color: '#2aa9dc' },
      { label: '0', color: '#65cba5' },
      { label: '10', color: '#d8d95a' },
      { label: '20', color: '#f4a13b' },
      { label: '30+', color: '#c93b45' },
    ],
  },
  {
    id: 'wind',
    title: 'Wind',
    description: 'Wind speed and direction',
    unit: 'm/s',
    // The same colour-blind-conscious progression Yr describes for its wind map.
    legend: [
      { label: '<2', color: '#d8e3b4' },
      { label: '5', color: '#a7cea1' },
      { label: '8', color: '#79ccac' },
      { label: '11', color: '#3cbebe' },
      { label: '14', color: '#13a8d6' },
      { label: '21', color: '#4b87ea' },
      { label: '29', color: '#7b57ed' },
      { label: '33+', color: '#4d0a6c' },
    ],
  },
  {
    id: 'clouds',
    title: 'Clouds',
    description: 'Total cloud cover forecast',
    unit: '%',
    legend: [
      { label: '0', color: '#ffffff' },
      { label: '25', color: '#dce5ed' },
      { label: '50', color: '#aebdca' },
      { label: '75', color: '#778b9c' },
      { label: '100', color: '#3d5061' },
    ],
  },
  {
    id: 'sea-temperature',
    title: 'Sea',
    description: 'Sea-surface temperature forecast',
    unit: '°C',
    legend: [
      { label: '<0', color: '#332787' },
      { label: '5', color: '#285bc0' },
      { label: '10', color: '#1ea5c9' },
      { label: '15', color: '#5fc67c' },
      { label: '20', color: '#e6c83f' },
      { label: '25+', color: '#e55b3f' },
    ],
  },
] as const;

export function weatherMapLayerSpec(id: WeatherMapLayerId): WeatherMapLayerSpec {
  return WEATHER_MAP_LAYER_SPECS.find((layer) => layer.id === id)!;
}
