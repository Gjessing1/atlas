import { fmtClock, fmtDayLabel, type LngLatBbox, type OverlayIdentifyGroup } from '@atlas/core';

import {
  decodeClouds,
  type CloudCover,
  type WeatherMosaic,
  type WeatherRaster,
} from './weather-maps.js';
import { sunPosition } from './sun.js';

/** Live weather/space-weather rows that are not part of the animated model fields. */
export const LIGHTNING_OBSERVATIONS_ID = 'weather-lightning';
export const AURORA_FORECAST_ID = 'aurora-forecast';
export const LIGHT_POLLUTION_ID = 'light-pollution';

export const LIGHTNING_WINDOWS = [
  { id: '1h', label: '1 hour', minutes: 60, frostDuration: 'PT1H' },
  { id: '12h', label: '12 hours', minutes: 12 * 60, frostDuration: 'PT12H' },
  { id: '24h', label: '24 hours', minutes: 24 * 60, frostDuration: 'PT24H' },
] as const;
export type LightningWindow = (typeof LIGHTNING_WINDOWS)[number]['id'];

export function lightningWindow(value: unknown): (typeof LIGHTNING_WINDOWS)[number] {
  return LIGHTNING_WINDOWS.find((candidate) => candidate.id === value) ?? LIGHTNING_WINDOWS[0];
}

export type LightningAge = 'flash' | 'fresh' | 'recent' | 'older' | 'oldest';

export interface LightningStrikeProperties {
  observedAt: string;
  /** `observedAt` as epoch ms: the age bands are drawn against the reader's own clock. */
  observedMs: number;
  /** Age when the server answered. Bundles from before `observedMs` colour by these. */
  ageMinutes: number;
  age: LightningAge;
  markerColor: string;
  peakCurrentKa: number;
  polarity: 'positive' | 'negative' | 'unknown';
}

export interface LightningStrikeFeature {
  type: 'Feature';
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties: LightningStrikeProperties;
}

export interface LightningResponse {
  type: 'FeatureCollection';
  features: LightningStrikeFeature[];
}

/** Frost's Nordic lightning-detection coverage used to clip untrusted viewports. */
export const LIGHTNING_BOUNDS: LngLatBbox = [-25, 50, 45, 85];

export interface LightningAgeBand {
  age: LightningAge;
  /** The band ends at this strike age. */
  maxMinutes: number;
  /** Legend text for that end. */
  label: string;
  color: string;
  /** Dot radius, px. */
  radius: number;
  opacity: number;
  /** Outline width, px — what keeps the dark violet readable on a dark map. */
  strokeWidth: number;
}

/**
 * The visual hierarchy by strike age. Age, not peak current, decides how loud
 * a strike is: what matters on a map of a day's lightning is where the storm is
 * *now*, so a strike fades from a pulsing orange through magenta and violet to
 * grey, and the day-old ones are barely there. The first band also pulses
 * (`lightningPulse`); every other band is a solid dot.
 */
export const LIGHTNING_AGE_BANDS: readonly LightningAgeBand[] = [
  {
    age: 'flash',
    maxMinutes: 1,
    label: '1 min',
    color: '#ff7a00',
    radius: 5.5,
    opacity: 1,
    strokeWidth: 1,
  },
  {
    age: 'fresh',
    maxMinutes: 15,
    label: '15 min',
    color: '#d61fd0',
    radius: 4.5,
    opacity: 1,
    strokeWidth: 1,
  },
  {
    age: 'recent',
    maxMinutes: 60,
    label: '1 h',
    color: '#4a1a8c',
    radius: 4,
    opacity: 1,
    strokeWidth: 1,
  },
  {
    age: 'older',
    maxMinutes: 6 * 60,
    label: '6 h',
    color: '#8c8c8c',
    radius: 3.2,
    opacity: 0.95,
    strokeWidth: 0.8,
  },
  {
    age: 'oldest',
    maxMinutes: 24 * 60,
    label: '24 h',
    color: '#9e9e9e',
    radius: 2,
    opacity: 0.4,
    strokeWidth: 0,
  },
];

/** The bands a window can contain, for its legend: a one-hour view never shows the greys. */
export function lightningLegendBands(window: LightningWindow): LightningAgeBand[] {
  const minutes = lightningWindow(window).minutes;
  return LIGHTNING_AGE_BANDS.filter(
    (_band, index) => index === 0 || LIGHTNING_AGE_BANDS[index - 1]!.maxMinutes < minutes,
  );
}

/** Outline colour for every band: light, so dark dots stay findable on a dark basemap. */
export const LIGHTNING_STROKE_COLOR = '#ffffff';

const MINUTE_MS = 60_000;

/** The band a strike of this age falls in; anything older than a day is the faintest. */
export function lightningAgeBand(ageMs: number): LightningAgeBand {
  return (
    LIGHTNING_AGE_BANDS.find((band) => ageMs < band.maxMinutes * MINUTE_MS) ??
    LIGHTNING_AGE_BANDS[LIGHTNING_AGE_BANDS.length - 1]!
  );
}

/**
 * A strike's age at `nowMs`, as a MapLibre expression (plain JSON, so both
 * clients use it as-is). The bands move on between data refreshes by feeding a
 * newer `nowMs` into the same expressions. A server from before `observedMs`
 * sent only the age at answer time; that age is used as it stands, and a strike
 * with neither is a day old.
 */
export function lightningAgeExpression(nowMs: number): unknown[] {
  const now = Math.round(nowMs);
  return [
    '-',
    now,
    [
      'to-number',
      [
        'coalesce',
        ['get', 'observedMs'],
        // `to-number` reads a missing value as 0 — a new strike — so coalesce first.
        ['-', now, ['*', ['to-number', ['coalesce', ['get', 'ageMinutes'], 24 * 60]], MINUTE_MS]],
      ],
    ],
  ];
}

/** A paint value that steps through the age bands, e.g. `band => band.color`. */
export function lightningBandExpression(
  nowMs: number,
  pick: (band: LightningAgeBand) => string | number,
): unknown[] {
  const expression: unknown[] = [
    'step',
    lightningAgeExpression(nowMs),
    pick(LIGHTNING_AGE_BANDS[0]!),
  ];
  for (let i = 1; i < LIGHTNING_AGE_BANDS.length; i++) {
    expression.push(
      LIGHTNING_AGE_BANDS[i - 1]!.maxMinutes * MINUTE_MS,
      pick(LIGHTNING_AGE_BANDS[i]!),
    );
  }
  return expression;
}

/** Selects the strikes still in the pulsing first band. */
export function lightningFlashFilter(nowMs: number): unknown[] {
  return ['<', lightningAgeExpression(nowMs), LIGHTNING_AGE_BANDS[0]!.maxMinutes * MINUTE_MS];
}

/** Whether any strike in a response is still in the pulsing band — no strike, no animation. */
export function lightningHasFlash(data: LightningResponse | null, nowMs: number): boolean {
  const limit = LIGHTNING_AGE_BANDS[0]!.maxMinutes * MINUTE_MS;
  return Boolean(
    data?.features.some((feature) => nowMs - Number(feature.properties.observedMs) < limit),
  );
}

/** One cycle of the newest strikes' pulse. */
export const LIGHTNING_PULSE_MS = 1600;

export interface LightningPulseFrame {
  /** The orange core swells and settles once per cycle. */
  coreRadius: number;
  /** The shockwave ring expands out of the core and fades as it goes. */
  ringRadius: number;
  ringOpacity: number;
  ringWidth: number;
}

/** The pulse at a point in its cycle (0–1), identical on both clients. */
export function lightningPulse(phase: number): LightningPulseFrame {
  const t = ((phase % 1) + 1) % 1;
  const out = 1 - (1 - t) ** 3;
  const core = LIGHTNING_AGE_BANDS[0]!.radius;
  return {
    coreRadius: core + 1.8 * Math.sin(t * Math.PI),
    ringRadius: core + 20 * out,
    ringOpacity: 0.9 * (1 - t) ** 1.5,
    ringWidth: 2.4 - 1.4 * t,
  };
}

/** A resting frame for readers who asked for reduced motion: the ring shown, not animated. */
export const LIGHTNING_PULSE_STILL: LightningPulseFrame = lightningPulse(0.35);

/**
 * Parse Universal ASCII Lightning Format. Frost currently emits UALF version
 * 0: version, UTC date/time, nanoseconds, latitude, longitude, peak current,
 * detection type and quality fields. Atlas deliberately needs only the stable
 * leading fields; a later UALF extension can append data without changing the
 * public feature shape.
 */
export function parseUalf(
  text: string,
  nowMs: number,
  maxFeatures = 10_000,
  maxAgeMinutes = 95,
): LightningResponse {
  const features: LightningStrikeFeature[] = [];
  for (const line of text.split(/\r?\n/)) {
    const field = line.trim().split(/\s+/);
    if (field.length < 12 || field[0] !== '0') continue;
    const [year, month, day, hour, minute, second, nanoseconds] = field.slice(1, 8).map(Number);
    const lat = Number(field[8]);
    const lng = Number(field[9]);
    const peakCurrentKa = Number(field[10]);
    if (
      ![year, month, day, hour, minute, second, lat, lng, peakCurrentKa].every(Number.isFinite) ||
      Math.abs(lat) > 90 ||
      Math.abs(lng) > 180
    ) {
      continue;
    }
    const timeMs =
      Date.UTC(year!, month! - 1, day!, hour!, minute!, second!) +
      (Number.isFinite(nanoseconds) ? Math.floor(nanoseconds! / 1e6) : 0);
    if (!Number.isFinite(timeMs)) continue;
    const ageMs = Math.max(0, nowMs - timeMs);
    if (ageMs > maxAgeMinutes * MINUTE_MS) continue;
    const band = lightningAgeBand(ageMs);
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lng, lat] },
      properties: {
        observedAt: new Date(timeMs).toISOString(),
        observedMs: timeMs,
        ageMinutes: Math.round(ageMs / MINUTE_MS),
        age: band.age,
        markerColor: band.color,
        peakCurrentKa: Math.round(peakCurrentKa),
        polarity: peakCurrentKa > 0 ? 'positive' : peakCurrentKa < 0 ? 'negative' : 'unknown',
      },
    });
  }
  // Oldest first, so the newest strikes are drawn on top. If an exceptional
  // storm exceeds the response guard, the oldest — faintest — are the ones cut.
  features.sort((a, b) => a.properties.observedMs - b.properties.observedMs);
  return { type: 'FeatureCollection', features: features.slice(-maxFeatures) };
}

/** "Less than a minute", "12 min", "3 h 5 min". */
function strikeAge(ageMs: number): string {
  const minutes = Math.floor(Math.max(0, ageMs) / MINUTE_MS);
  if (minutes < 1) return 'Less than a minute';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/** Display-ready card for a strike already hit-tested on either client. */
export function lightningIdentify(
  properties: Record<string, unknown> | null | undefined,
  nowMs = Date.now(),
): OverlayIdentifyGroup | null {
  if (!properties || typeof properties['observedAt'] !== 'string') return null;
  const time = Date.parse(properties['observedAt']);
  if (!Number.isFinite(time)) return null;
  const current = Number(properties['peakCurrentKa']);
  const polarity = properties['polarity'];
  const rows: Record<string, string> = {
    // The reader's own clock, like every other time in Atlas.
    Observed: `${fmtDayLabel(time, nowMs)} ${fmtClock(time)}`,
    // Measured now, not when the server answered: the card can be opened long after.
    Age: strikeAge(nowMs - time),
  };
  if (Number.isFinite(current)) rows['Peak current'] = `${Math.abs(Math.round(current))} kA`;
  if (polarity === 'positive' || polarity === 'negative') rows['Polarity'] = polarity;
  return { title: 'Lightning strike', properties: rows };
}

export interface OvationGrid {
  observationTime: string;
  forecastTime: string;
  /** Row-major longitude 0…359, latitude −90…90. */
  values: Uint8Array;
}

export interface AuroraForecastStatus {
  observationTime: string;
  forecastTime: string;
  /** The conditions folded into the rendered viewing-chance surface. */
  factors: readonly ['aurora', 'darkness', 'clouds', 'light-pollution'];
}

export interface AuroraPaintConditions {
  /** MET Norway low/medium/high cloud forecast nearest OVATION's validity time. */
  clouds?: WeatherMosaic;
  /** NASA VIIRS night-light tile at the same z/x/y as the output. */
  lightPollution?: WeatherRaster;
}

interface OvationPayload {
  'Observation Time'?: unknown;
  'Forecast Time'?: unknown;
  coordinates?: unknown;
}

/** Validate NOAA SWPC's compact `[longitude, latitude, probability]` grid. */
export function parseOvation(payload: unknown): OvationGrid | null {
  if (!payload || typeof payload !== 'object') return null;
  const raw = payload as OvationPayload;
  if (
    typeof raw['Observation Time'] !== 'string' ||
    typeof raw['Forecast Time'] !== 'string' ||
    !Number.isFinite(Date.parse(raw['Observation Time'])) ||
    !Number.isFinite(Date.parse(raw['Forecast Time'])) ||
    !Array.isArray(raw.coordinates)
  ) {
    return null;
  }
  const values = new Uint8Array(360 * 181);
  let usable = 0;
  for (const row of raw.coordinates) {
    if (!Array.isArray(row) || row.length < 3) continue;
    const lng = Number(row[0]);
    const lat = Number(row[1]);
    const probability = Number(row[2]);
    if (
      !Number.isInteger(lng) ||
      !Number.isInteger(lat) ||
      lng < 0 ||
      lng > 359 ||
      lat < -90 ||
      lat > 90 ||
      !Number.isFinite(probability)
    ) {
      continue;
    }
    values[(lat + 90) * 360 + lng] = Math.round(Math.max(0, Math.min(100, probability)));
    usable++;
  }
  if (usable < 60_000) return null;
  return {
    observationTime: raw['Observation Time'],
    forecastTime: raw['Forecast Time'],
    values,
  };
}

const gridValue = (grid: OvationGrid, lng: number, lat: number): number => {
  const wrapped = ((lng % 360) + 360) % 360;
  const y = Math.max(0, Math.min(180, lat + 90));
  const x0 = Math.floor(wrapped);
  const x1 = (x0 + 1) % 360;
  const y0 = Math.floor(y);
  const y1 = Math.min(180, y0 + 1);
  const fx = wrapped - x0;
  const fy = y - y0;
  const at = (x: number, row: number) => grid.values[row * 360 + x]!;
  const top = at(x0, y0) * (1 - fx) + at(x1, y0) * fx;
  const bottom = at(x0, y1) * (1 - fx) + at(x1, y1) * fx;
  return top * (1 - fy) + bottom * fy;
};

/** Low cloud obscures most; high cloud is often translucent (the same distinction Yr documents). */
export function auroraCloudFactor(cloud: CloudCover): number {
  const obscured = 0.88 * cloud.low + 0.58 * cloud.medium + 0.3 * cloud.high;
  return Math.max(0.06, 1 - obscured / 100);
}

/** Civil twilight is too bright; astronomical twilight and darker gets the full model signal. */
export function auroraDarknessFactor(time: Date, lat: number, lng: number): number {
  const altitude = sunPosition(time, lat, lng).altitude;
  if (altitude >= -6) return 0.05;
  if (altitude <= -12) return 1;
  return 0.05 + ((-6 - altitude) / 6) * 0.95;
}

/** VIIRS luminance is a radiance proxy: brighter emitted light means poorer local contrast. */
export function auroraLightFactor(r: number, g: number, b: number): number {
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return Math.max(0.16, 1 - 0.84 * Math.sqrt(Math.max(0, luminance) / 255));
}

function cloudAt(
  mosaic: WeatherMosaic | undefined,
  z: number,
  x: number,
  y: number,
  px: number,
  py: number,
): CloudCover | null {
  if (!mosaic) return null;
  const scale = 2 ** (mosaic.z - z);
  const gx = Math.max(0, Math.floor((x * 256 + px + 0.5) * scale));
  const gy = Math.max(0, Math.floor((y * 256 + py + 0.5) * scale));
  const tile = mosaic.tile(gx >> 8, gy >> 8);
  if (!tile) return null;
  const sx = Math.min(tile.width - 1, gx & 255);
  const sy = Math.min(tile.height - 1, gy & 255);
  const i = (sy * tile.width + sx) * 4;
  return decodeClouds(tile.data[i]!, tile.data[i + 1]!, tile.data[i + 2]!);
}

/**
 * Transparent aurora *viewing chance* for MapLibre.
 *
 * Hue/brightness carry OVATION probability; opacity also applies darkness,
 * MET cloud decks and VIIRS-observed artificial light. The oval therefore
 * remains faintly locatable under poor conditions without implying that a
 * daytime, overcast city has the same chance as a clear dark site.
 */
export function paintAuroraTile(
  grid: OvationGrid,
  z: number,
  x: number,
  y: number,
  conditions: AuroraPaintConditions = {},
): Uint8Array {
  const size = 256;
  const out = new Uint8Array(size * size * 4);
  const scale = size * 2 ** z;
  const forecast = new Date(grid.forecastTime);
  for (let py = 0; py < size; py++) {
    const worldY = (y * size + py + 0.5) / scale;
    const lat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * worldY))) * 180) / Math.PI;
    for (let px = 0; px < size; px++) {
      const lng = ((x * size + px + 0.5) / scale) * 360 - 180;
      const value = gridValue(grid, lng, lat);
      if (value < 5) continue;
      const probability = Math.min(1, (value - 5) / 95);
      const cloud = cloudAt(conditions.clouds, z, x, y, px, py);
      const cloudFactor = cloud ? auroraCloudFactor(cloud) : 1;
      let lightFactor = 1;
      const i = (py * size + px) * 4;
      const light = conditions.lightPollution;
      if (light) {
        const li =
          (Math.min(light.height - 1, py) * light.width + Math.min(light.width - 1, px)) * 4;
        lightFactor = auroraLightFactor(light.data[li]!, light.data[li + 1]!, light.data[li + 2]!);
      }
      const viewing =
        probability * auroraDarknessFactor(forecast, lat, lng) * cloudFactor * lightFactor;
      // A green-only band whose luminance and saturation rise with model
      // intensity. This avoids implying that red is a different phenomenon.
      out[i] = Math.round(32 + 128 * probability);
      out[i + 1] = Math.round(150 + 105 * Math.pow(probability, 0.65));
      out[i + 2] = Math.round(88 + 32 * probability);
      out[i + 3] = Math.round(10 + 235 * Math.pow(viewing, 0.68));
    }
  }
  return out;
}
