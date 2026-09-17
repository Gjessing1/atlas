import type { TransitAccessMode, TransitPreferences } from './model.js';

export const DEFAULT_TRANSIT_PREFERENCES: TransitPreferences = Object.freeze({
  accessMode: 'foot',
  walkSpeedMps: 1.3,
  walkReluctance: 2,
  transferSlackSeconds: 120,
  maximumTransfers: 4,
  bikeSpeedMps: 4.2,
  bikeReluctance: 2,
  bikeOptimisation: 'quick',
  bikeRentalNetworks: [],
});

const ACCESS_MODES: readonly TransitAccessMode[] = ['foot', 'bicycle', 'bike_rental'];
const BIKE_OPTIMISATIONS = ['quick', 'safe', 'flat'] as const;

const finiteBetween = (value: unknown, min: number, max: number, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
    ? value
    : fallback;

/** Accept older/partial rows and bound every value before it reaches a planner. */
export function parseTransitPreferences(value: unknown): TransitPreferences | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Partial<Record<keyof TransitPreferences, unknown>>;
  const accessMode = ACCESS_MODES.includes(raw.accessMode as TransitAccessMode)
    ? (raw.accessMode as TransitAccessMode)
    : DEFAULT_TRANSIT_PREFERENCES.accessMode;
  const bikeOptimisation = BIKE_OPTIMISATIONS.includes(
    raw.bikeOptimisation as TransitPreferences['bikeOptimisation'],
  )
    ? (raw.bikeOptimisation as TransitPreferences['bikeOptimisation'])
    : DEFAULT_TRANSIT_PREFERENCES.bikeOptimisation;
  const bikeRentalNetworks = Array.isArray(raw.bikeRentalNetworks)
    ? raw.bikeRentalNetworks
        .filter((network): network is string => typeof network === 'string')
        .map((network) => network.trim())
        .filter(Boolean)
        .slice(0, 20)
    : [];
  return {
    accessMode,
    walkSpeedMps: finiteBetween(raw.walkSpeedMps, 0.5, 3, 1.3),
    walkReluctance: finiteBetween(raw.walkReluctance, 1, 20, 2),
    transferSlackSeconds: Math.trunc(finiteBetween(raw.transferSlackSeconds, 0, 1800, 120)),
    maximumTransfers: Math.trunc(finiteBetween(raw.maximumTransfers, 0, 8, 4)),
    bikeSpeedMps: finiteBetween(raw.bikeSpeedMps, 1, 15, 4.2),
    bikeReluctance: finiteBetween(raw.bikeReluctance, 0.1, 20, 2),
    bikeOptimisation,
    bikeRentalNetworks,
  };
}
