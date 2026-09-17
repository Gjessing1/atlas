import { jsonSetting } from '@atlas/core';
import {
  DEFAULT_TRANSIT_PREFERENCES,
  parseTransitPreferences,
  type TransitPreferences,
} from '@atlas/transit';

import { usePersistedSetting, type SettingsAccess } from './usePersistedSetting.js';

export const TRANSIT_PREFERENCES_SETTING = jsonSetting<TransitPreferences>({
  key: 'route.transit.preferences',
  scope: 'synced',
  defaultValue: DEFAULT_TRANSIT_PREFERENCES,
  parse: parseTransitPreferences,
});

export interface TransitPreferencesController {
  value: TransitPreferences;
  loaded: boolean;
  patch: (patch: Partial<TransitPreferences>) => Promise<boolean>;
  reset: () => Promise<boolean>;
}

/** Shared, account-synced preferences used by both journey-planner clients. */
export function useTransitPreferences(settings: SettingsAccess): TransitPreferencesController {
  const stored = usePersistedSetting(settings, TRANSIT_PREFERENCES_SETTING);
  return {
    value: stored.value,
    loaded: stored.loaded,
    patch: (patch) => stored.setValue((current) => ({ ...current, ...patch })),
    reset: () => stored.setValue(DEFAULT_TRANSIT_PREFERENCES),
  };
}
