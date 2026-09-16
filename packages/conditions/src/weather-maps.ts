/**
 * Animated weather maps: what MET Norway's map tiles *mean*, and how Atlas
 * draws them.
 *
 * The tiles behind yr.no's map (prod.yr-maps.met.no) are not pictures. Each one
 * is a data raster whose channels encode a value, and a renderer is expected to
 * decode and colour it. Painting them as-is — which the first version of this
 * feature did — puts a flat red wash over the map for temperature and a black
 * sheet for radar. So the decoding lives here, once, with the calibration that
 * established it, and the backend uses it to paint tiles both clients can draw
 * as an ordinary raster (MapLibre Native has no custom shaders).
 *
 * The encodings were not documented upstream. Each was measured on 2026-09-16
 * by sampling the tile pixel under a point and comparing it with MET's own point
 * forecast for the same place and hour (locationforecast / oceanforecast):
 *
 * - **air-temperature** — `R − 128` °C, 8-bit, whole degrees. 15 of 16 cities
 *   (Cairo 157 → 29.7 °C, Longyearbyen 131 → 4.1 °C) within 1.5 °C; the miss was
 *   a mountain summit, which one 2.4 km pixel averages with its valleys.
 * - **sea-temperature** — `R / 4 − 2.5` °C, alpha 0 where the ocean model has no
 *   water (land, or outside its Nordic domain). Six sea points within 0.15 °C.
 * - **wind** — 16-bit: `(R − 32768)` and `(G − 32768)` are the eastward and
 *   northward components on a ±75 m/s scale. A least-squares fit over 216
 *   open-Atlantic samples gave 437.6 counts per m/s against 436.9 for ±75; over
 *   the Nordic model's domain the fit reads lower (416), which is that model's
 *   sharper local winds rather than a different scale. B is not wind.
 * - **cloud-area-fraction** — R, G, B are low, medium and high cloud, 0–200 for
 *   0–100 %. Combined with random overlap they reproduce MET's total cover
 *   (Madrid 11.7/4.7/1.6 % → 17 % vs 15.6 %).
 * - **precipitation-*** — not a value but six intensity classes in a fixed
 *   palette, black for dry and white for "outside radar coverage". The order was
 *   read off which classes border which across a whole global frame (black ↔
 *   palest ↔ … ↔ darkest blue ↔ purple, never skipping), and matches Yr's own
 *   legend for these pixels: light under 0.2 mm/h, heavy about 5, extreme over
 *   15. The classes in between carry no published threshold, so Atlas does not
 *   invent one.
 */

import {
  fmtClock,
  fmtDayLabel,
  polygonLabelPoint,
  type LatLng,
  type OverlayIdentifyGroup,
} from '@atlas/core';

import { windArrow } from './display.js';
import { compass16 } from './sun.js';

export type WeatherMapLayerId =
  'precipitation' | 'temperature' | 'wind' | 'clouds' | 'sea-temperature';

export const WEATHER_MAP_LAYER_IDS: readonly WeatherMapLayerId[] = [
  'precipitation',
  'wind',
  'temperature',
  'clouds',
  'sea-temperature',
];

export type WeatherMapFrameKind = 'observation' | 'nowcast' | 'forecast';

/**
 * A layer's timelines. Precipitation has two, as on Yr: **radar** is the last
 * 90 minutes observed plus the short nowcast, every 5 minutes, over the Nordic
 * radar network only; **forecast** is the model, hourly, for about three days,
 * everywhere. They are different products with different coverage, so they are
 * switched between rather than spliced.
 */
export type WeatherMapTimelineId = 'radar' | 'forecast';

/** The overlay-catalog row that switches a weather field on (`weather-wind`, …). */
export function weatherOverlayId(layer: WeatherMapLayerId): string {
  return `weather-${layer}`;
}

/** The weather-warnings overlay row (MET's CAP alerts, drawn as polygons). */
export const WEATHER_WARNINGS_ID = 'weather-warnings';

/**
 * The catalog's exclusivity key for the weather fields: two colour fields over
 * the same ground cannot both be read, so switching one on switches the others
 * off. Warnings are outlines and badges, so they are not in the group.
 */
export const WEATHER_FIELD_GROUP = 'weather-field';

/** Narrow an untrusted string (a catalog row's `weather.layer`) to a layer id. */
export function asWeatherMapLayerId(value: unknown): WeatherMapLayerId | null {
  return (WEATHER_MAP_LAYER_IDS as readonly unknown[]).includes(value)
    ? (value as WeatherMapLayerId)
    : null;
}

// ---------------------------------------------------------------- decoding ---

/** Air temperature, °C, from an `air-temperature` pixel's red channel. */
export function decodeTemperature(r: number): number {
  return r - 128;
}

/** Sea-surface temperature, °C, or null where the ocean model has no water. */
export function decodeSeaTemperature(r: number, a: number): number | null {
  return a === 0 ? null : r / 4 - 2.5;
}

/** Counts per m/s in a 16-bit wind channel: ±75 m/s over ±32768 (see top of file). */
const WIND_COUNTS_PER_MS = 32768 / 75;

export interface WindVector {
  /** Eastward component, m/s. */
  u: number;
  /** Northward component, m/s. */
  v: number;
}

/** Wind components from a 16-bit `wind` pixel. */
export function decodeWind(r16: number, g16: number): WindVector {
  return { u: (r16 - 32768) / WIND_COUNTS_PER_MS, v: (g16 - 32768) / WIND_COUNTS_PER_MS };
}

export function windSpeed({ u, v }: WindVector): number {
  return Math.hypot(u, v);
}

/** The bearing the wind blows *from*, degrees clockwise from north — how forecasts name it. */
export function windFromDeg({ u, v }: WindVector): number {
  return ((((Math.atan2(-u, -v) * 180) / Math.PI) % 360) + 360) % 360;
}

export interface CloudCover {
  low: number;
  medium: number;
  high: number;
  /** Total cover, %, combining the three decks with random overlap. */
  total: number;
}

export function decodeClouds(r: number, g: number, b: number): CloudCover {
  const low = Math.min(100, r / 2);
  const medium = Math.min(100, g / 2);
  const high = Math.min(100, b / 2);
  const total = 100 * (1 - (1 - low / 100) * (1 - medium / 100) * (1 - high / 100));
  return { low, medium, high, total };
}

/** MET's precipitation palette, lightest first; index + 1 is the level. */
const PRECIPITATION_PALETTE: readonly (readonly [number, number, number])[] = [
  [145, 228, 255],
  [94, 215, 255],
  [0, 170, 255],
  [0, 128, 255],
  [0, 85, 255],
  [122, 0, 135],
];

/** Highest precipitation level (extreme). */
export const PRECIPITATION_MAX_LEVEL = PRECIPITATION_PALETTE.length;

/**
 * A precipitation pixel as a level: 0 dry, 1 (light) … 6 (extreme), or null
 * where there is no data — outside radar coverage (white) or outside the tile's
 * dataset (transparent).
 *
 * Matched to the nearest palette colour rather than exactly, so a lossy or
 * resampled source still lands in a class instead of falling through as dry.
 */
export function decodePrecipitationLevel(r: number, g: number, b: number, a = 255): number | null {
  if (a === 0) return null;
  if (r > 240 && g > 240 && b > 240) return null;
  if (r < 16 && g < 16 && b < 16) return 0;
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  PRECIPITATION_PALETTE.forEach(([pr, pg, pb], index) => {
    const distance = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index + 1;
    }
  });
  return best;
}

/**
 * At or below this 2 m air temperature, precipitation is drawn and described as
 * snow or sleet. The precipitation tiles carry no phase, so it comes from the
 * temperature forecast for the same hour — hence "or sleet": near freezing the
 * surface temperature alone cannot tell the two apart.
 */
export const FROZEN_PRECIPITATION_MAX_C = 1;

// -------------------------------------------------------------- colouring ---

export interface RampStop {
  value: number;
  /** `#rrggbb`. */
  color: string;
}

/**
 * Air (and sea) temperature. Violet through blue below freezing with a hard
 * edge at 0 °C — the one boundary a reader looks for — then turquoise, mint and
 * chartreuse through the mild range, yellow to crimson in the heat.
 */
export const TEMPERATURE_RAMP: readonly RampStop[] = [
  { value: -40, color: '#1d0636' },
  { value: -30, color: '#3b0f70' },
  { value: -20, color: '#4631a8' },
  { value: -10, color: '#2d64d8' },
  { value: -5, color: '#4f97ec' },
  { value: -0.5, color: '#a9d8ff' },
  { value: 0, color: '#8ee0cf' },
  { value: 5, color: '#9fe8b0' },
  { value: 10, color: '#c9ef8c' },
  { value: 15, color: '#eef27a' },
  { value: 20, color: '#ffd84a' },
  { value: 25, color: '#ffa53a' },
  { value: 30, color: '#f25a2c' },
  { value: 35, color: '#c81e2e' },
  { value: 45, color: '#6d0a22' },
];

/**
 * Wind speed, m/s: calm turquoise, breeze green, strong-breeze yellow to amber,
 * gale magenta to crimson, storm purple — a progression that stays ordered for
 * the common colour-vision deficiencies because lightness carries it too.
 */
export const WIND_RAMP: readonly RampStop[] = [
  { value: 0, color: '#c6f1f2' },
  { value: 2, color: '#9fe3e6' },
  { value: 3, color: '#b4e9b6' },
  { value: 5, color: '#c8ec93' },
  { value: 8, color: '#dcec63' },
  { value: 9, color: '#f6e94a' },
  { value: 12, color: '#ffcb3d' },
  { value: 16, color: '#ff9429' },
  { value: 17, color: '#f0509a' },
  { value: 20, color: '#d2245f' },
  { value: 24, color: '#8e1f8c' },
  { value: 32, color: '#4a0f6b' },
];

/** Rain by level (1–6): sky blues for the common light classes, then green, amber, crimson. */
export const RAIN_COLORS: readonly string[] = [
  '#b8ecff',
  '#6fd4fa',
  '#2c9fe8',
  '#35c47a',
  '#f7b928',
  '#c0265f',
];

/** Snow and sleet by level: ice white through pastel pink and magenta to violet. */
export const SNOW_COLORS: readonly string[] = [
  '#eadcff',
  '#e3bdf7',
  '#f09bd8',
  '#df62bd',
  '#b8379f',
  '#6c1a86',
];

/** Level 1 is thin drizzle over a light map; a touch of transparency keeps it from reading as a sheet. */
const PRECIPITATION_ALPHA: readonly number[] = [0.72, 0.85, 0.92, 0.95, 0.95, 0.95];

function hexRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** The colour of a value on a ramp, linearly interpolated and clamped at both ends. */
export function rampRgb(ramp: readonly RampStop[], value: number): [number, number, number] {
  const first = ramp[0]!;
  const last = ramp[ramp.length - 1]!;
  if (value <= first.value) return hexRgb(first.color);
  if (value >= last.value) return hexRgb(last.color);
  for (let i = 1; i < ramp.length; i++) {
    const hi = ramp[i]!;
    if (value > hi.value) continue;
    const lo = ramp[i - 1]!;
    const t = (value - lo.value) / (hi.value - lo.value);
    const a = hexRgb(lo.color);
    const b = hexRgb(hi.color);
    return [
      Math.round(a[0] + (b[0] - a[0]) * t),
      Math.round(a[1] + (b[1] - a[1]) * t),
      Math.round(a[2] + (b[2] - a[2]) * t),
    ];
  }
  return hexRgb(last.color);
}

function toHex([r, g, b]: readonly number[]): string {
  return `#${[r, g, b].map((c) => c!.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Cloud cover as colour: clear sky is a thin dark veil and cloud brightens to
 * white. On a light basemap white alone is invisible, so darkening the gaps is
 * what makes the cloud read — the same trick as a satellite picture.
 */
export function cloudRgba(cover: CloudCover): [number, number, number, number] {
  const c = cover.total / 100;
  const lift = Math.sqrt(c);
  // Low cloud is the grey, heavy deck; high cloud stays bright and wispy.
  const decks = cover.low + cover.medium + cover.high;
  const lowShare = decks > 0 ? cover.low / decks : 0;
  const white = 255 - 28 * lowShare;
  const dark = [31, 42, 55] as const;
  // Clamped: a cool tint on the blue channel would otherwise pass 255 and wrap
  // round to a yellow pixel in the 8-bit tile.
  const channel = (from: number, to: number) =>
    Math.max(0, Math.min(255, Math.round(from + (to - from) * lift)));
  return [
    channel(dark[0], white),
    channel(dark[1], white),
    channel(dark[2], white + 6),
    Math.round(255 * (0.3 + 0.62 * c)),
  ];
}

/** A decoded upstream tile: RGBA, 8 or 16 bits per channel, row-major from the top left. */
export interface WeatherRaster {
  width: number;
  height: number;
  /** 4 channels per pixel. A 16-bit raster holds 0–65535 values. */
  data: ArrayLike<number>;
}

/**
 * How many zooms past a dataset's finest the backend paints. MET's fields are a
 * few kilometres per pixel; stretched by the map past that they turn into
 * visible squares, and radar into staircases. Painting deeper, from values
 * interpolated between the data's pixels, keeps a zoomed-in field a smooth
 * gradient and a shower a soft-edged shape.
 */
export const WEATHER_TILE_OVERZOOM = 3;

/** One dataset's decoded tiles at one zoom, addressed by tile. */
export interface WeatherMosaic {
  z: number;
  /** The decoded 256 px tile at (x, y), or null where MET has none. */
  tile(x: number, y: number): WeatherRaster | null;
}

/** Tile coordinates at `sourceZ` a painted tile at (z, x, y) reads, neighbours for interpolation included. */
export function weatherTileFootprint(
  z: number,
  x: number,
  y: number,
  sourceZ: number,
): { x: number; y: number }[] {
  const scale = 2 ** (sourceZ - z);
  const n = 2 ** sourceZ;
  const lo = (v: number) => Math.floor((v * 256 + 0.5) * scale - 0.5);
  const hi = (v: number) => Math.ceil((v * 256 + 255.5) * scale - 0.5);
  const tx0 = Math.floor(lo(x) / 256);
  const tx1 = Math.floor(hi(x) / 256);
  const ty0 = Math.max(0, Math.floor(lo(y) / 256));
  const ty1 = Math.min(n - 1, Math.floor(hi(y) / 256));
  const out: { x: number; y: number }[] = [];
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) out.push({ x: ((tx % n) + n) % n, y: ty });
  }
  return out;
}

/**
 * Gaussian smoothing per layer, in the data's own pixels. Interpolation alone
 * keeps each data pixel's outline — a zoomed-in shower is still a mosaic of
 * squares with soft corners — so the values are blurred slightly first. At the
 * data's own zoom a pixel is a screen pixel and this is invisible; three zooms
 * deeper it is what turns stair-steps into round outlines. Precipitation, a
 * field of discrete classes, needs the most.
 */
const SMOOTHING_SIGMA: Record<WeatherMapLayerId, number> = {
  precipitation: 1.3,
  wind: 1,
  clouds: 0.8,
  temperature: 0.7,
  'sea-temperature': 0.8,
};

function gaussianKernel(sigma: number): Float32Array {
  const radius = Math.ceil(sigma * 3);
  const kernel = new Float32Array(radius * 2 + 1);
  let sum = 0;
  for (let k = -radius; k <= radius; k++) {
    const w = Math.exp(-(k * k) / (2 * sigma * sigma));
    kernel[k + radius] = w;
    sum += w;
  }
  for (let k = 0; k < kernel.length; k++) kernel[k]! /= sum;
  return kernel;
}

/** Separable blur of a width × height field, in place (clamped at the window edge). */
function blur(field: Float32Array, width: number, height: number, kernel: Float32Array): void {
  const radius = (kernel.length - 1) / 2;
  const tmp = new Float32Array(field.length);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) {
        const xx = x + k < 0 ? 0 : x + k >= width ? width - 1 : x + k;
        acc += field[row + xx]! * kernel[k + radius]!;
      }
      tmp[row + x] = acc;
    }
  }
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) {
        const yy = y + k < 0 ? 0 : y + k >= height ? height - 1 : y + k;
        acc += tmp[yy * width + x]! * kernel[k + radius]!;
      }
      field[y * width + x] = acc;
    }
  }
}

/** Bilinear sample of a window field at fractional window coordinates. */
function bilinear(
  field: Float32Array,
  width: number,
  height: number,
  sx: number,
  sy: number,
): number {
  const cx = Math.max(0, Math.min(width - 1, sx));
  const cy = Math.max(0, Math.min(height - 1, sy));
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const fx = cx - x0;
  const fy = cy - y0;
  return (
    (field[y0 * width + x0]! * (1 - fx) + field[y0 * width + x1]! * fx) * (1 - fy) +
    (field[y1 * width + x0]! * (1 - fx) + field[y1 * width + x1]! * fx) * fy
  );
}

/** The data-pixel position of output pixel `p` of tile `t` at zoom `z`, in a mosaic at `mosaicZ`. */
function mosaicPosition(mosaicZ: number, z: number, t: number, p: number): number {
  return (t * 256 + p + 0.5) * 2 ** (mosaicZ - z) - 0.5;
}

/**
 * The data pixels a painted tile needs, decoded into float fields: one field
 * per value the layer carries (weighted by `mask`, so blurring a gap does not
 * drag values towards zero) plus the mask itself.
 */
interface ValueWindow {
  x0: number;
  y0: number;
  width: number;
  height: number;
  fields: Float32Array[];
  mask: Float32Array;
}

function decodeWindow(
  layer: WeatherMapLayerId,
  mosaic: WeatherMosaic,
  x0: number,
  y0: number,
  width: number,
  height: number,
): ValueWindow {
  const channels = layer === 'clouds' ? 3 : layer === 'wind' ? 2 : 1;
  const fields = Array.from({ length: channels }, () => new Float32Array(width * height));
  const mask = new Float32Array(width * height);
  const size = 2 ** mosaic.z * 256;
  let lastKey = -1;
  let lastTile: WeatherRaster | null = null;
  for (let wy = 0; wy < height; wy++) {
    const gy = Math.max(0, Math.min(size - 1, y0 + wy));
    for (let wx = 0; wx < width; wx++) {
      const gx = (((x0 + wx) % size) + size) % size;
      const key = (gy >> 8) * 65536 + (gx >> 8);
      if (key !== lastKey) {
        lastKey = key;
        lastTile = mosaic.tile(gx >> 8, gy >> 8);
      }
      if (!lastTile) continue;
      const d = lastTile.data;
      const i = ((gy & 255) * lastTile.width + (gx & 255)) * 4;
      const o = wy * width + wx;
      switch (layer) {
        case 'temperature':
          fields[0]![o] = decodeTemperature(d[i]!);
          mask[o] = 1;
          break;
        case 'sea-temperature': {
          const sea = decodeSeaTemperature(d[i]!, d[i + 3]!);
          if (sea === null) break;
          fields[0]![o] = sea;
          mask[o] = 1;
          break;
        }
        case 'wind': {
          const wind = decodeWind(d[i]!, d[i + 1]!);
          fields[0]![o] = wind.u;
          fields[1]![o] = wind.v;
          mask[o] = 1;
          break;
        }
        case 'clouds':
          fields[0]![o] = Math.min(200, d[i]!);
          fields[1]![o] = Math.min(200, d[i + 1]!);
          fields[2]![o] = Math.min(200, d[i + 2]!);
          mask[o] = 1;
          break;
        case 'precipitation': {
          const level = decodePrecipitationLevel(d[i]!, d[i + 1]!, d[i + 2]!, d[i + 3]!);
          if (level === null) break;
          fields[0]![o] = level;
          mask[o] = 1;
          break;
        }
      }
    }
  }
  return { x0, y0, width, height, fields, mask };
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

const RAIN_RGB = RAIN_COLORS.map(hexRgb);
const SNOW_RGB = SNOW_COLORS.map(hexRgb);

/**
 * Paint the display tile at (z, x, y) — straight-alpha RGBA, 256 px — from a
 * dataset's decoded tiles at a zoom at or above the data's own.
 *
 * The data pixels under the tile are decoded to their *values* (temperature,
 * wind components, cloud decks, precipitation level), smoothed a little (see
 * SMOOTHING_SIGMA), interpolated to each output pixel, and only then coloured.
 * Interpolating colours instead would muddy the ramps, and reading the nearest
 * data pixel would draw the squares this exists to avoid. Gaps in the data — a
 * coastline for sea temperature, the edge of radar coverage — fade out over the
 * same smoothing rather than stopping at a pixel.
 *
 * `temperature` is the air-temperature dataset, read the same way, and decides
 * precipitation's rain/snow blend; without it everything is rain.
 */
export function paintWeatherTile(
  layer: WeatherMapLayerId,
  mosaic: WeatherMosaic,
  z: number,
  x: number,
  y: number,
  temperature?: WeatherMosaic,
): Uint8Array {
  const out = new Uint8Array(256 * 256 * 4);
  const kernel = gaussianKernel(SMOOTHING_SIGMA[layer]);
  const margin = (kernel.length - 1) / 2 + 2;
  const wx0 = Math.floor(mosaicPosition(mosaic.z, z, x, 0)) - margin;
  const wy0 = Math.floor(mosaicPosition(mosaic.z, z, y, 0)) - margin;
  const wx1 = Math.ceil(mosaicPosition(mosaic.z, z, x, 255)) + margin;
  const wy1 = Math.ceil(mosaicPosition(mosaic.z, z, y, 255)) + margin;
  const win = decodeWindow(layer, mosaic, wx0, wy0, wx1 - wx0 + 1, wy1 - wy0 + 1);
  const { width, height, fields, mask } = win;
  // Normalised convolution: blur value × mask and the mask, divide back.
  for (const field of fields) {
    for (let i = 0; i < field.length; i++) field[i]! *= mask[i]!;
    blur(field, width, height, kernel);
  }
  blur(mask, width, height, kernel);

  let tempWin: ValueWindow | null = null;
  if (layer === 'precipitation' && temperature) {
    const tx0 = Math.floor(mosaicPosition(temperature.z, z, x, 0)) - 2;
    const ty0 = Math.floor(mosaicPosition(temperature.z, z, y, 0)) - 2;
    const tx1 = Math.ceil(mosaicPosition(temperature.z, z, x, 255)) + 2;
    const ty1 = Math.ceil(mosaicPosition(temperature.z, z, y, 255)) + 2;
    tempWin = decodeWindow('temperature', temperature, tx0, ty0, tx1 - tx0 + 1, ty1 - ty0 + 1);
  }

  const values = new Array<number>(fields.length);
  for (let py = 0; py < 256; py++) {
    const sy = mosaicPosition(mosaic.z, z, y, py) - wy0;
    for (let px = 0; px < 256; px++) {
      const sx = mosaicPosition(mosaic.z, z, x, px) - wx0;
      const covered = bilinear(mask, width, height, sx, sy);
      if (covered < 0.02) continue;
      for (let c = 0; c < fields.length; c++) {
        values[c] = bilinear(fields[c]!, width, height, sx, sy) / covered;
      }
      let rgb: readonly number[] | null = null;
      let alpha = 1;
      switch (layer) {
        case 'temperature':
        case 'sea-temperature':
          rgb = rampRgb(TEMPERATURE_RAMP, values[0]!);
          break;
        case 'wind':
          rgb = rampRgb(WIND_RAMP, Math.hypot(values[0]!, values[1]!));
          break;
        case 'clouds': {
          const rgba = cloudRgba(decodeClouds(values[0]!, values[1]!, values[2]!));
          rgb = rgba;
          alpha = rgba[3] / 255;
          break;
        }
        case 'precipitation': {
          const level = values[0]!;
          // Below level 1 is a shower's fringe: fade it in, don't cut it off.
          const presence = smoothstep(0.2, 0.95, level);
          if (presence === 0) break;
          const lo = Math.max(1, Math.min(PRECIPITATION_MAX_LEVEL, Math.floor(level)));
          const hi = Math.min(PRECIPITATION_MAX_LEVEL, lo + 1);
          const f = level < 1 ? 0 : Math.min(1, level - lo);
          let frozen = 0;
          if (tempWin) {
            const tsx = mosaicPosition(temperature!.z, z, x, px) - tempWin.x0;
            const tsy = mosaicPosition(temperature!.z, z, y, py) - tempWin.y0;
            const tw = bilinear(tempWin.mask, tempWin.width, tempWin.height, tsx, tsy);
            if (tw > 0.5) {
              const t = bilinear(tempWin.fields[0]!, tempWin.width, tempWin.height, tsx, tsy) / tw;
              // A one-degree blend either side of the threshold, not a seam.
              frozen =
                1 -
                smoothstep(FROZEN_PRECIPITATION_MAX_C - 0.5, FROZEN_PRECIPITATION_MAX_C + 0.5, t);
            }
          }
          const mix = (palette: readonly (readonly number[])[], c: number) =>
            palette[lo - 1]![c]! + (palette[hi - 1]![c]! - palette[lo - 1]![c]!) * f;
          rgb = [0, 1, 2].map(
            (c) => mix(RAIN_RGB, c) + (mix(SNOW_RGB, c) - mix(RAIN_RGB, c)) * frozen,
          );
          alpha =
            presence *
            (PRECIPITATION_ALPHA[lo - 1]! +
              (PRECIPITATION_ALPHA[hi - 1]! - PRECIPITATION_ALPHA[lo - 1]!) * f);
          break;
        }
      }
      if (!rgb) continue;
      const o = (py * 256 + px) * 4;
      out[o] = Math.round(rgb[0]!);
      out[o + 1] = Math.round(rgb[1]!);
      out[o + 2] = Math.round(rgb[2]!);
      // Where data runs out, fade over the smoothing instead of stopping at a pixel.
      out[o + 3] = Math.round(255 * alpha * smoothstep(0.25, 0.75, covered));
    }
  }
  return out;
}

// ----------------------------------------------------------------- legend ---

export interface WeatherLegendRow {
  /** Row caption where a layer has more than one ("Rain", "Snow & sleet"). */
  label: string | null;
  /** Colour stops along the bar, `at` 0–1 from the left. Adjacent equal `at`s make a hard edge. */
  stops: { at: number; color: string }[];
  ticks: { at: number; label: string }[];
}

export interface WeatherMapLegend {
  unit: string;
  rows: WeatherLegendRow[];
}

function rampLegendRow(
  ramp: readonly RampStop[],
  min: number,
  max: number,
  ticks: readonly number[],
  suffix = '',
): WeatherLegendRow {
  const at = (value: number) => (value - min) / (max - min);
  const stops = [
    { at: 0, color: toHex(rampRgb(ramp, min)) },
    ...ramp
      .filter((stop) => stop.value > min && stop.value < max)
      .map((stop) => ({ at: at(stop.value), color: stop.color })),
    { at: 1, color: toHex(rampRgb(ramp, max)) },
  ];
  return {
    label: null,
    stops,
    ticks: ticks.map((value) => ({ at: at(value), label: `${value}${suffix}` })),
  };
}

function bandsRow(label: string, colors: readonly string[]): WeatherLegendRow {
  const n = colors.length;
  return {
    label,
    stops: colors.flatMap((color, i) => [
      { at: i / n, color },
      { at: (i + 1) / n, color },
    ]),
    ticks: [],
  };
}

/**
 * The legend a client draws beside a layer. Built from the very ramps
 * `paintWeatherTile` uses, so the key cannot disagree with the pixels — the
 * first version shipped a hand-typed legend next to tiles it never coloured.
 */
export function weatherMapLegend(layer: WeatherMapLayerId): WeatherMapLegend {
  switch (layer) {
    case 'temperature':
      return {
        unit: '°C',
        rows: [rampLegendRow(TEMPERATURE_RAMP, -30, 40, [-20, -10, 0, 10, 20, 30], '°')],
      };
    case 'sea-temperature':
      return {
        unit: '°C',
        rows: [rampLegendRow(TEMPERATURE_RAMP, -2, 26, [0, 5, 10, 15, 20, 25], '°')],
      };
    case 'wind':
      return { unit: 'm/s', rows: [rampLegendRow(WIND_RAMP, 0, 30, [0, 5, 10, 15, 20, 25])] };
    case 'clouds': {
      const at = (pct: number) => toHex(cloudRgba({ low: 0, medium: pct, high: 0, total: pct }));
      return {
        unit: '%',
        rows: [
          {
            label: null,
            stops: [0, 25, 50, 75, 100].map((pct) => ({ at: pct / 100, color: at(pct) })),
            ticks: [0, 50, 100].map((pct) => ({ at: pct / 100, label: `${pct}` })),
          },
        ],
      };
    }
    case 'precipitation': {
      // Only the three thresholds MET publishes for these classes are labelled.
      const n = PRECIPITATION_MAX_LEVEL;
      const centre = (level: number) => (level - 0.5) / n;
      const rain = bandsRow('Rain', RAIN_COLORS);
      rain.ticks = [
        { at: centre(1), label: '<0.2' },
        { at: centre(5), label: '≈5' },
        { at: centre(6), label: '>15' },
      ];
      return { unit: 'mm/h', rows: [rain, bandsRow('Snow', SNOW_COLORS)] };
    }
  }
}

/** Evenly spaced colours along a legend row — for renderers without CSS gradients. */
export function legendRowSwatches(row: WeatherLegendRow, count: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const t = (i + 0.5) / count;
    let lo = row.stops[0]!;
    let hi = row.stops[row.stops.length - 1]!;
    for (let s = 1; s < row.stops.length; s++) {
      if (row.stops[s]!.at >= t) {
        lo = row.stops[s - 1]!;
        hi = row.stops[s]!;
        break;
      }
    }
    const span = hi.at - lo.at;
    const f = span > 0 ? (t - lo.at) / span : 0;
    const a = hexRgb(lo.color);
    const b = hexRgb(hi.color);
    out.push(toHex(a.map((c, k) => Math.round(c + (b[k]! - c) * f))));
  }
  return out;
}

// ---------------------------------------------------------------- catalog ---

export interface WeatherMapLayerSpec {
  id: WeatherMapLayerId;
  title: string;
  /** One line for the layer panel. */
  description: string;
  unit: string;
  /** What a blank or surprising map means, for the layer panel. */
  coverageNote: string;
  defaultOpacity: number;
}

export const WEATHER_MAP_LAYER_SPECS: readonly WeatherMapLayerSpec[] = [
  {
    id: 'precipitation',
    title: 'Precipitation',
    description: 'Radar for the last 90 minutes and the next 90, or the three-day forecast.',
    unit: 'mm/h',
    coverageNote:
      'Radar covers Norway, Sweden, Finland and Denmark; the forecast covers the world. Snow and sleet are told from rain by the forecast air temperature.',
    defaultOpacity: 0.9,
  },
  {
    id: 'wind',
    title: 'Wind',
    description: 'Mean wind 10 m above ground, hourly for about two days.',
    unit: 'm/s',
    coverageNote: 'A model forecast; gusts and local sheltering are not shown.',
    defaultOpacity: 0.75,
  },
  {
    id: 'temperature',
    title: 'Temperature',
    description: 'Air temperature 2 m above ground, hourly for about two days.',
    unit: '°C',
    coverageNote: 'Whole degrees on a ~2.5 km grid, so a summit reads as warm as its valleys.',
    defaultOpacity: 0.7,
  },
  {
    id: 'clouds',
    title: 'Clouds',
    description: 'Total cloud cover from low, medium and high cloud, hourly.',
    unit: '%',
    coverageNote: 'A forecast, not a satellite picture: clear sky is darkened so the cloud reads.',
    defaultOpacity: 0.85,
  },
  {
    id: 'sea-temperature',
    title: 'Sea temperature',
    description: 'Sea-surface temperature forecast for Nordic waters.',
    unit: '°C',
    coverageNote: 'Only where MET’s ocean model runs — the Nordic seas, not lakes.',
    defaultOpacity: 0.8,
  },
];

export function weatherMapLayerSpec(id: WeatherMapLayerId): WeatherMapLayerSpec {
  return WEATHER_MAP_LAYER_SPECS.find((layer) => layer.id === id)!;
}

export interface WeatherMapFrame {
  /** Opaque, URL-safe server id — unique per model run, so its tiles never change. */
  id: string;
  /** Validity time, ISO-8601 UTC. */
  time: string;
  kind: WeatherMapFrameKind;
  /** Same-origin path template; clients prefix their server origin. */
  tilePath: string;
}

export interface WeatherMapTimeline {
  id: WeatherMapTimelineId;
  bounds: [number, number, number, number];
  minzoom: number;
  maxzoom: number;
  frames: WeatherMapFrame[];
}

/** One colour chip per legend band, in the shape the first release's sheet read. */
export interface WeatherMapLegendStop {
  label: string;
  color: string;
}

export interface WeatherMapLayer extends WeatherMapLayerSpec {
  timelines: WeatherMapTimeline[];
  /**
   * The first release's single spliced timeline and flat legend. Android bundles
   * from before timelines render `frames.length` and `legend.map` unguarded, so
   * both stay until those bundles have taken the update.
   */
  frames: WeatherMapFrame[];
  legend: WeatherMapLegendStop[];
  bounds: [number, number, number, number];
  minzoom: number;
  maxzoom: number;
}

export interface WeatherMapsResponse {
  layers: WeatherMapLayer[];
  attribution: string;
  /** Kept for the same pre-timeline bundles, which read `lightning.reason` unguarded. */
  lightning: { available: false; reason: string };
}

// --------------------------------------------------------------- timeline ---

/** Index of the frame nearest a time; 0 for an empty list. */
export function closestFrameIndex(frames: readonly { time: string }[], targetMs: number): number {
  let answer = 0;
  let distance = Number.POSITIVE_INFINITY;
  frames.forEach((frame, index) => {
    const candidate = Math.abs(Date.parse(frame.time) - targetMs);
    if (candidate < distance) {
      answer = index;
      distance = candidate;
    }
  });
  return answer;
}

/**
 * Where "now" sits on a timeline: the newest *observed* frame when there are
 * any — radar is only ever a few minutes behind, and that picture is the truth
 * about now — otherwise the frame nearest the clock.
 */
export function nowFrameIndex(frames: readonly WeatherMapFrame[], nowMs: number): number {
  let lastObserved = -1;
  frames.forEach((frame, index) => {
    if (frame.kind === 'observation' && Date.parse(frame.time) <= nowMs) lastObserved = index;
  });
  return lastObserved >= 0 ? lastObserved : closestFrameIndex(frames, nowMs);
}

/** "Today 15:30", "Tomorrow 03:00", "Sat 20 12:00". */
export function weatherFrameLabel(timeMs: number, nowMs = Date.now()): string {
  return `${fmtDayLabel(timeMs, nowMs)} ${fmtClock(timeMs)}`;
}

/**
 * What a frame is, relative to now: "Radar · 25 min ago", "Nowcast · in 30 min",
 * "Forecast". Radar minutes matter — a shower 50 minutes old has moved on.
 */
export function weatherFrameCaption(frame: WeatherMapFrame, nowMs = Date.now()): string {
  if (frame.kind === 'forecast') return 'Forecast';
  const minutes = Math.round((Date.parse(frame.time) - nowMs) / 60_000);
  const when =
    Math.abs(minutes) < 3 ? 'now' : minutes < 0 ? `${-minutes} min ago` : `in ${minutes} min`;
  return `${frame.kind === 'observation' ? 'Radar' : 'Nowcast'} · ${when}`;
}

/** Where each new day starts along a timeline, as 0–1 positions with a weekday label. */
export function timelineDayMarks(
  frames: readonly WeatherMapFrame[],
  nowMs = Date.now(),
): { at: number; label: string }[] {
  if (frames.length < 2) return [];
  const marks: { at: number; label: string }[] = [];
  for (let i = 1; i < frames.length; i++) {
    const prev = new Date(Date.parse(frames[i - 1]!.time));
    const cur = new Date(Date.parse(frames[i]!.time));
    if (prev.getDate() !== cur.getDate()) {
      marks.push({ at: i / (frames.length - 1), label: fmtDayLabel(cur.getTime(), nowMs) });
    }
  }
  return marks;
}

// ------------------------------------------------------------ point sample ---

/** Every layer's value under one point at one time — the tap card's answer. */
export interface WeatherPointSample {
  /** The time the values are valid for (the frames nearest the requested time). */
  time: string;
  temperatureC: number | null;
  wind: { speed: number; fromDeg: number } | null;
  /** Level 0 dry … 6 extreme; `frozen` from the air temperature (see FROZEN_PRECIPITATION_MAX_C). */
  precipitation: { level: number; frozen: boolean; radar: boolean } | null;
  cloudCoverPct: number | null;
  seaTemperatureC: number | null;
}

const PRECIPITATION_WORDS = [
  'Very light',
  'Light',
  'Light to moderate',
  'Moderate',
  'Heavy',
  'Extreme',
] as const;

/** "Light rain", "Heavy snow or sleet", "Dry". */
export function precipitationText(level: number, frozen: boolean): string {
  if (level <= 0) return 'Dry';
  const word = PRECIPITATION_WORDS[Math.min(level, PRECIPITATION_MAX_LEVEL) - 1]!;
  const noun = frozen ? 'snow or sleet' : 'rain';
  const hint =
    level === 1
      ? ' (under 0.2 mm/h)'
      : level === 5
        ? ' (about 5 mm/h)'
        : level === 6
          ? ' (over 15 mm/h)'
          : '';
  return `${word} ${noun}${hint}`;
}

/** "6 m/s from SW ↗" — the arrow points where the wind is going, as on the forecast table. */
export function windText(speed: number, fromDeg: number): string {
  return `${Math.round(speed)} m/s from ${compass16(fromDeg)} ${windArrow(fromDeg)}`;
}

function fmtDegrees(value: number): string {
  return `${Math.round(value)}°`;
}

/**
 * The weather at a tapped point, as an identify group for the place card. The
 * switched-on layer's value leads, since that is what the reader was looking at;
 * the rest follow in a fixed order.
 */
export function weatherPointIdentify(
  sample: WeatherPointSample,
  lead: WeatherMapLayerId | null,
  nowMs = Date.now(),
): OverlayIdentifyGroup | null {
  const rows: [WeatherMapLayerId, string, string][] = [];
  if (sample.temperatureC !== null) {
    rows.push(['temperature', 'Temperature', fmtDegrees(sample.temperatureC)]);
  }
  if (sample.wind) rows.push(['wind', 'Wind', windText(sample.wind.speed, sample.wind.fromDeg)]);
  if (sample.precipitation) {
    rows.push([
      'precipitation',
      sample.precipitation.radar ? 'Radar' : 'Precipitation',
      precipitationText(sample.precipitation.level, sample.precipitation.frozen),
    ]);
  }
  if (sample.cloudCoverPct !== null) {
    rows.push(['clouds', 'Cloud cover', `${Math.round(sample.cloudCoverPct)} %`]);
  }
  if (sample.seaTemperatureC !== null) {
    rows.push(['sea-temperature', 'Sea', `${sample.seaTemperatureC.toFixed(1)}°`]);
  }
  if (rows.length === 0) return null;
  rows.sort((a, b) => Number(b[0] === lead) - Number(a[0] === lead));
  const properties: Record<string, string> = {};
  for (const [, label, value] of rows) properties[label] = value;
  const time = Date.parse(sample.time);
  return {
    title: Number.isFinite(time) ? `Weather · ${weatherFrameLabel(time, nowMs)}` : 'Weather',
    properties,
  };
}

/** GET /api/weather/maps/point for one place and time. */
export function weatherPointUrl(origin: string, at: LatLng, timeMs: number): string {
  return (
    `${origin}/api/weather/maps/point?lat=${at.lat.toFixed(5)}&lng=${at.lng.toFixed(5)}` +
    `&time=${encodeURIComponent(new Date(timeMs).toISOString())}`
  );
}

// ------------------------------------------------------------------- grid ---

/** Web Mercator's latitude limit; tiles do not reach the poles. */
const MERCATOR_MAX_LAT = 85.0511;

/** The XYZ tile and 256 px pixel under a point at a zoom. */
export function tilePixelAt(
  lng: number,
  lat: number,
  z: number,
): { x: number; y: number; px: number; py: number } {
  const n = 2 ** z;
  const clampedLat = Math.max(-MERCATOR_MAX_LAT, Math.min(MERCATOR_MAX_LAT, lat));
  const wrappedLng = ((((lng + 180) % 360) + 360) % 360) - 180;
  const gx = ((wrappedLng + 180) / 360) * n * 256;
  const rad = (clampedLat * Math.PI) / 180;
  const gy = ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n * 256;
  const maxPixel = n * 256 - 1;
  const cx = Math.max(0, Math.min(maxPixel, Math.floor(gx)));
  const cy = Math.max(0, Math.min(maxPixel, Math.floor(gy)));
  return { x: cx >> 8, y: cy >> 8, px: cx & 255, py: cy & 255 };
}

/** One layer's decoded value at a pixel of an upstream tile. */
export type WeatherValue =
  | { layer: 'temperature' | 'sea-temperature'; value: number | null }
  | { layer: 'wind'; value: WindVector }
  | { layer: 'clouds'; value: CloudCover }
  | { layer: 'precipitation'; value: number | null };

export function weatherValueAt(
  layer: WeatherMapLayerId,
  raster: WeatherRaster,
  px: number,
  py: number,
): WeatherValue {
  const i = (Math.min(raster.height - 1, py) * raster.width + Math.min(raster.width - 1, px)) * 4;
  const d = raster.data;
  switch (layer) {
    case 'temperature':
      return { layer, value: decodeTemperature(d[i]!) };
    case 'sea-temperature':
      return { layer, value: decodeSeaTemperature(d[i]!, d[i + 3]!) };
    case 'wind':
      return { layer, value: decodeWind(d[i]!, d[i + 1]!) };
    case 'clouds':
      return { layer, value: decodeClouds(d[i]!, d[i + 1]!, d[i + 2]!) };
    case 'precipitation':
      return { layer, value: decodePrecipitationLevel(d[i]!, d[i + 1]!, d[i + 2]!, d[i + 3]!) };
  }
}

/**
 * The zoom to read for a grid over a bbox: the first whose pixels are at least
 * twice as fine as a cell, within the dataset's zooms, stepped back until the
 * bbox needs no more than `maxTiles` tiles.
 */
export function weatherGridZoom(
  bbox: readonly [number, number, number, number],
  cols: number,
  minzoom: number,
  maxzoom: number,
  maxTiles = 16,
): number {
  const [w, s, e, n] = bbox;
  const cellDeg = Math.max(1e-6, (e - w) / Math.max(1, cols));
  let z = Math.ceil(Math.log2((360 * 2) / (256 * cellDeg)));
  z = Math.max(minzoom, Math.min(maxzoom, z));
  // Edges, not points: an east edge at 180° must not wrap round to column 0.
  const west = Math.max(-180, w);
  const east = Math.min(179.999999, e);
  while (z > minzoom) {
    const a = tilePixelAt(west, n, z);
    const b = tilePixelAt(east, s, z);
    if ((b.x - a.x + 1) * (b.y - a.y + 1) <= maxTiles) break;
    z -= 1;
  }
  return z;
}

/** A layer's values on a regular lat/lng grid over a viewport. */
export interface WeatherGridResponse {
  layer: WeatherMapLayerId;
  frame: string;
  time: string;
  /** West, south, east, north of the grid's outer edges. */
  bbox: [number, number, number, number];
  cols: number;
  rows: number;
  /**
   * Row-major from the north-west cell, one entry per cell centre, null where
   * the layer has no data. Scalar layers fill `values` (°C, %, level); wind
   * fills `u` and `v` (m/s).
   */
  values?: (number | null)[];
  u?: (number | null)[];
  v?: (number | null)[];
}

/** The grid endpoint for one frame over a viewport. */
export function weatherGridUrl(
  origin: string,
  layer: WeatherMapLayerId,
  frameId: string,
  bbox: readonly [number, number, number, number],
  cols: number,
  rows: number,
): string {
  const box = bbox.map((n) => n.toFixed(3)).join(',');
  return (
    `${origin}/api/weather/maps/${layer}/${encodeURIComponent(frameId)}/grid` +
    `?bbox=${box}&cols=${cols}&rows=${rows}`
  );
}

/** Cell centre of grid cell (col, row). */
export function weatherGridCellCentre(
  grid: Pick<WeatherGridResponse, 'bbox' | 'cols' | 'rows'>,
  col: number,
  row: number,
): LatLng {
  const [w, s, e, n] = grid.bbox;
  return {
    lng: w + ((col + 0.5) * (e - w)) / grid.cols,
    lat: n - ((row + 0.5) * (n - s)) / grid.rows,
  };
}

/**
 * Point labels for a grid — a temperature number, or a wind arrow with its
 * speed — as GeoJSON a symbol layer can place with collision on.
 */
export function weatherGridLabels(
  grid: WeatherGridResponse,
): GeoJSON.FeatureCollection<GeoJSON.Point> {
  const features: GeoJSON.Feature<GeoJSON.Point>[] = [];
  for (let row = 0; row < grid.rows; row++) {
    for (let col = 0; col < grid.cols; col++) {
      const i = row * grid.cols + col;
      const at = weatherGridCellCentre(grid, col, row);
      let properties: GeoJSON.GeoJsonProperties = null;
      if (grid.layer === 'wind') {
        const u = grid.u?.[i];
        const v = grid.v?.[i];
        if (u == null || v == null) continue;
        const vector = { u, v };
        const speed = windSpeed(vector);
        // Where the wind is going, for an upward-pointing glyph rotated clockwise.
        const towardDeg = (windFromDeg(vector) + 180) % 360;
        properties = { label: `${Math.round(speed)}`, rotation: towardDeg, speed };
      } else if (grid.layer === 'temperature' || grid.layer === 'sea-temperature') {
        const value = grid.values?.[i];
        if (value == null) continue;
        properties = { label: fmtDegrees(value), value };
      } else {
        continue;
      }
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [at.lng, at.lat] },
        properties,
      });
    }
  }
  return { type: 'FeatureCollection', features };
}

/** A scalar grid's value at a point, interpolated between cell centres; null outside or in a gap. */
export function sampleScalarGrid(
  grid: WeatherGridResponse,
  lng: number,
  lat: number,
): number | null {
  const values = grid.values;
  if (!values) return null;
  const [w, s, e, n] = grid.bbox;
  const fx = Math.max(0, Math.min(grid.cols - 1, ((lng - w) / (e - w)) * grid.cols - 0.5));
  const fy = Math.max(0, Math.min(grid.rows - 1, ((n - lat) / (n - s)) * grid.rows - 0.5));
  if (lng < w || lng > e || lat < s || lat > n) return null;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(grid.cols - 1, x0 + 1);
  const y1 = Math.min(grid.rows - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;
  let sum = 0;
  let weights = 0;
  for (const [x, y, weight] of [
    [x0, y0, (1 - tx) * (1 - ty)],
    [x1, y0, tx * (1 - ty)],
    [x0, y1, (1 - tx) * ty],
    [x1, y1, tx * ty],
  ] as const) {
    if (weight === 0) continue;
    const value = values[y * grid.cols + x];
    if (value == null) continue;
    sum += value * weight;
    weights += weight;
  }
  return weights > 0.5 ? sum / weights : null;
}

/**
 * Temperature numbers for the map: one beside each town the basemap is
 * labelling (as Yr does — a number means most next to a name), then a sparse
 * fill of the grid for the open country and sea between them. `place` marks the
 * first kind, so a renderer can place those first and offset them under the name.
 */
export function weatherValueLabels(
  grid: WeatherGridResponse,
  places: readonly { lng: number; lat: number }[],
  fillEvery = 3,
): GeoJSON.FeatureCollection<GeoJSON.Point> {
  const features: GeoJSON.Feature<GeoJSON.Point>[] = [];
  for (const place of places) {
    const value = sampleScalarGrid(grid, place.lng, place.lat);
    if (value === null) continue;
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [place.lng, place.lat] },
      properties: { label: fmtDegrees(value), value, place: true },
    });
  }
  const offset = Math.floor(fillEvery / 2);
  for (let row = offset; row < grid.rows; row += fillEvery) {
    for (let col = offset; col < grid.cols; col += fillEvery) {
      const value = grid.values?.[row * grid.cols + col];
      if (value == null) continue;
      const at = weatherGridCellCentre(grid, col, row);
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [at.lng, at.lat] },
        properties: { label: fmtDegrees(value), value, place: false },
      });
    }
  }
  return { type: 'FeatureCollection', features };
}

/**
 * Bilinear wind at a fractional grid position (cols/rows units from the
 * north-west cell centre), or null outside the data — the particle animation's
 * per-frame lookup.
 */
export function sampleWindGrid(
  grid: WeatherGridResponse,
  fx: number,
  fy: number,
): WindVector | null {
  const { cols, rows, u, v } = grid;
  if (!u || !v || fx < 0 || fy < 0 || fx > cols - 1 || fy > rows - 1) return null;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(cols - 1, x0 + 1);
  const y1 = Math.min(rows - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const corners: [number, number, number][] = [
    [x0, y0, (1 - tx) * (1 - ty)],
    [x1, y0, tx * (1 - ty)],
    [x0, y1, (1 - tx) * ty],
    [x1, y1, tx * ty],
  ];
  let su = 0;
  let sv = 0;
  for (const [x, y, weight] of corners) {
    // A corner that contributes nothing may be a gap: on a cell's edge the far
    // row is irrelevant, and refusing there would punch holes along every row.
    if (weight === 0) continue;
    const cu = u[y * cols + x];
    const cv = v[y * cols + x];
    if (cu == null || cv == null) return null;
    su += cu * weight;
    sv += cv * weight;
  }
  return { u: su, v: sv };
}

// --------------------------------------------------------------- warnings ---

export type WeatherWarningLevel = 'yellow' | 'orange' | 'red';

export const WEATHER_WARNING_COLORS: Record<WeatherWarningLevel, string> = {
  yellow: '#f5c400',
  orange: '#ff8a00',
  red: '#e0242a',
};

/** MET's event keys in words a reader expects on a badge. */
const WARNING_EVENTS: Record<string, string> = {
  avalanches: 'Avalanche danger',
  blowingSnow: 'Blowing snow',
  drivingConditions: 'Difficult driving',
  flood: 'Flood',
  forestFire: 'Forest fire danger',
  gale: 'Gale',
  ice: 'Ice',
  icing: 'Icing',
  landslide: 'Landslide',
  lightning: 'Lightning',
  polarLow: 'Polar low',
  rain: 'Heavy rain',
  rainFlood: 'Rain and flood',
  snow: 'Heavy snow',
  stormSurge: 'Storm surge',
  wind: 'Strong wind',
};

/** Display-ready properties of one warning area (and its badge point). */
export interface WeatherWarningProperties {
  id: string;
  level: WeatherWarningLevel;
  color: string;
  event: string;
  eventLabel: string;
  area: string;
  description: string;
  instruction: string;
  consequences: string;
  onset: string;
  ends: string;
  web: string;
  /** Present on the badge point only. */
  badge?: true;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function warningLevel(raw: unknown): WeatherWarningLevel | null {
  const s = text(raw).toLowerCase();
  return s.includes('red')
    ? 'red'
    : s.includes('orange')
      ? 'orange'
      : s.includes('yellow')
        ? 'yellow'
        : null;
}

/**
 * MET's CAP alert feed (metalerts 2.0 GeoJSON) as the features Atlas draws:
 * the warning areas with their level colour, plus one badge point per area.
 *
 * Green ("minor") entries are dropped — MET publishes them as information, not
 * as a warning — and so is anything already over, because the feed keeps a
 * warning listed for a while after it ends.
 */
export function normalizeMetAlerts(raw: unknown, nowMs = Date.now()): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  const list = (raw as { features?: unknown })?.features;
  if (!Array.isArray(list)) return { type: 'FeatureCollection', features };
  for (const entry of list) {
    const feature = entry as {
      geometry?: GeoJSON.Geometry;
      properties?: Record<string, unknown>;
      when?: { interval?: unknown };
    };
    const props = feature.properties ?? {};
    const level = warningLevel(props['awareness_level'] ?? props['riskMatrixColor']);
    const geometry = feature.geometry;
    if (!level || !geometry || (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon')) {
      continue;
    }
    const interval = Array.isArray(feature.when?.interval) ? feature.when.interval : [];
    const onset = text(interval[0]);
    const ends = text(interval[1]) || text(props['eventEndingTime']);
    if (ends && Date.parse(ends) < nowMs) continue;
    const event = text(props['event']);
    const properties: WeatherWarningProperties = {
      id: text(props['id']),
      level,
      color: WEATHER_WARNING_COLORS[level],
      event,
      eventLabel: WARNING_EVENTS[event] ?? (text(props['eventAwarenessName']) || 'Weather warning'),
      area: text(props['area']),
      description: text(props['description']),
      instruction: text(props['instruction']),
      consequences: text(props['consequences']),
      onset,
      ends,
      web: text(props['web']),
    };
    features.push({ type: 'Feature', geometry, properties: { ...properties } });
    const rings =
      geometry.type === 'Polygon'
        ? geometry.coordinates
        : // The largest polygon carries the badge: a coastal warning's islands
          // would otherwise pull it out to sea.
          ([...geometry.coordinates].sort(
            (a, b) => ringArea(b[0] ?? []) - ringArea(a[0] ?? []),
          )[0] ?? []);
    const label = polygonLabelPoint(rings);
    if (label) {
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [label.lng, label.lat] },
        properties: { ...properties, badge: true },
      });
    }
  }
  // Worst on top: red draws after orange after yellow.
  const rank = { yellow: 0, orange: 1, red: 2 } as const;
  features.sort(
    (a, b) =>
      rank[(a.properties as WeatherWarningProperties).level] -
      rank[(b.properties as WeatherWarningProperties).level],
  );
  return { type: 'FeatureCollection', features };
}

function ringArea(ring: readonly (readonly number[])[]): number {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    sum += (ring[j]![0]! + ring[i]![0]!) * (ring[j]![1]! - ring[i]![1]!);
  }
  return Math.abs(sum / 2);
}

/** A tapped warning, worded for the place card. */
export function weatherWarningIdentify(
  properties: Record<string, unknown> | null | undefined,
  nowMs = Date.now(),
): OverlayIdentifyGroup | null {
  if (!properties) return null;
  const level = warningLevel(properties['level']);
  if (!level) return null;
  const rows: Record<string, string> = {};
  rows['Level'] = `${level[0]!.toUpperCase()}${level.slice(1)}`;
  const area = text(properties['area']);
  if (area) rows['Area'] = area;
  const onset = Date.parse(text(properties['onset']));
  const ends = Date.parse(text(properties['ends']));
  if (Number.isFinite(onset) && Number.isFinite(ends)) {
    rows['Valid'] = `${weatherFrameLabel(onset, nowMs)} – ${weatherFrameLabel(ends, nowMs)}`;
  }
  const description = text(properties['description']);
  if (description) rows['Details'] = description;
  const instruction = text(properties['instruction']);
  if (instruction) rows['Advice'] = instruction;
  const web = text(properties['web']);
  if (web) rows['More'] = web;
  return { title: text(properties['eventLabel']) || 'Weather warning', properties: rows };
}
