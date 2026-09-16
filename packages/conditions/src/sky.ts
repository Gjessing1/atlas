import { fmtClock, type LngLatBbox, type OverlayIdentifyGroup } from '@atlas/core';

/** Live weather/space-weather rows that are not part of the animated model fields. */
export const LIGHTNING_OBSERVATIONS_ID = 'weather-lightning';
export const AURORA_FORECAST_ID = 'aurora-forecast';

export type LightningAge = 'fresh' | 'recent' | 'older';

export interface LightningStrikeProperties {
  observedAt: string;
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

const lightningAge = (
  ageMinutes: number,
): Pick<LightningStrikeProperties, 'age' | 'markerColor'> => {
  if (ageMinutes <= 15) return { age: 'fresh', markerColor: '#fff3a3' };
  if (ageMinutes <= 45) return { age: 'recent', markerColor: '#ffb020' };
  return { age: 'older', markerColor: '#e64980' };
};

/**
 * Parse Universal ASCII Lightning Format. Frost currently emits UALF version
 * 0: version, UTC date/time, nanoseconds, latitude, longitude, peak current,
 * detection type and quality fields. Atlas deliberately needs only the stable
 * leading fields; a later UALF extension can append data without changing the
 * public feature shape.
 */
export function parseUalf(text: string, nowMs: number, maxFeatures = 10_000): LightningResponse {
  const features: LightningStrikeFeature[] = [];
  for (const line of text.split(/\r?\n/)) {
    const field = line.trim().split(/\s+/);
    if (field.length < 12 || field[0] !== '0') continue;
    const [year, month, day, hour, minute, second] = field.slice(1, 7).map(Number);
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
    const timeMs = Date.UTC(year!, month! - 1, day!, hour!, minute!, second!);
    if (!Number.isFinite(timeMs)) continue;
    const ageMinutes = Math.max(0, Math.round((nowMs - timeMs) / 60_000));
    if (ageMinutes > 95) continue;
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lng, lat] },
      properties: {
        observedAt: new Date(timeMs).toISOString(),
        ageMinutes,
        ...lightningAge(ageMinutes),
        peakCurrentKa: Math.round(peakCurrentKa),
        polarity: peakCurrentKa > 0 ? 'positive' : peakCurrentKa < 0 ? 'negative' : 'unknown',
      },
    });
  }
  // Frost is chronological. Keep the newest observations if an exceptional
  // storm exceeds the response guard rather than returning an enormous map.
  return { type: 'FeatureCollection', features: features.slice(-maxFeatures) };
}

/** Display-ready card for a strike already hit-tested on either client. */
export function lightningIdentify(
  properties: Record<string, unknown> | null | undefined,
): OverlayIdentifyGroup | null {
  if (!properties || typeof properties['observedAt'] !== 'string') return null;
  const time = Date.parse(properties['observedAt']);
  if (!Number.isFinite(time)) return null;
  const age = Number(properties['ageMinutes']);
  const current = Number(properties['peakCurrentKa']);
  const polarity = properties['polarity'];
  const rows: Record<string, string> = {
    Observed: `${new Date(time).toISOString().slice(0, 10)} ${fmtClock(time)} UTC`,
  };
  if (Number.isFinite(age)) rows['Age'] = age < 1 ? 'Less than a minute' : `${Math.round(age)} min`;
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

/** Transparent green→yellow→red OVATION probability tile for MapLibre. */
export function paintAuroraTile(grid: OvationGrid, z: number, x: number, y: number): Uint8Array {
  const size = 256;
  const out = new Uint8Array(size * size * 4);
  const scale = size * 2 ** z;
  for (let py = 0; py < size; py++) {
    const worldY = (y * size + py + 0.5) / scale;
    const lat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * worldY))) * 180) / Math.PI;
    for (let px = 0; px < size; px++) {
      const lng = ((x * size + px + 0.5) / scale) * 360 - 180;
      const value = gridValue(grid, lng, lat);
      if (value < 5) continue;
      const t = Math.min(1, (value - 5) / 65);
      const hot = Math.max(0, (t - 0.55) / 0.45);
      const i = (py * size + px) * 4;
      out[i] = Math.round(55 + 200 * hot);
      out[i + 1] = Math.round(225 - 120 * hot);
      out[i + 2] = Math.round(105 - 75 * hot);
      out[i + 3] = Math.round(35 + 190 * Math.pow(t, 0.7));
    }
  }
  return out;
}
