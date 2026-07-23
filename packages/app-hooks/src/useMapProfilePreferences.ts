import {
  MAP_PROFILES,
  defaultMapProfilePreferences,
  preferredLayersForProfile,
  sanitizeMapProfilePreferences,
  type MapProfile,
  type MapProfilePreferences,
} from '@atlas/core';
import { useCallback, useEffect, useMemo, useState } from 'react';

// Unlike the active `local.map.profile`, layout preferences intentionally sync:
// a signed-in user's chosen shortcut set and profile overlays follow them.
const PREFERENCES_SETTING = 'map.profile-preferences';

export interface MapProfilePreferenceSettings {
  status: string;
  getSetting: (key: string) => Promise<string | null>;
  setSetting: (key: string, value: string) => void;
}

export interface MapProfilePreferencesController {
  value: MapProfilePreferences;
  visibleProfiles: readonly MapProfile[];
  preferredLayers: (profileId: string) => readonly string[];
  /** Whether this profile has an explicit user selection rather than Atlas defaults. */
  customizedLayers: (profileId: string) => boolean;
  setVisible: (profileId: string, visible: boolean) => void;
  setPreferredLayers: (profileId: string, layerIds: readonly string[]) => void;
  reset: () => void;
}

/** Shared, syncable activity-profile layout used by both clients. */
export function useMapProfilePreferences(
  settings: MapProfilePreferenceSettings,
): MapProfilePreferencesController {
  const [value, setValue] = useState<MapProfilePreferences>(defaultMapProfilePreferences);
  const { status, getSetting, setSetting } = settings;

  useEffect(() => {
    if (status !== 'ready') return;
    let cancelled = false;
    void getSetting(PREFERENCES_SETTING).then((stored) => {
      if (cancelled || !stored) return;
      try {
        setValue(sanitizeMapProfilePreferences(JSON.parse(stored)));
      } catch {
        // Corrupt synced preference: retain Atlas defaults.
      }
    });
    return () => {
      cancelled = true;
    };
  }, [status, getSetting]);

  const update = useCallback(
    (mutate: (current: MapProfilePreferences) => MapProfilePreferences) => {
      setValue((current) => {
        const next = sanitizeMapProfilePreferences(mutate(current));
        setSetting(PREFERENCES_SETTING, JSON.stringify(next));
        return next;
      });
    },
    [setSetting],
  );

  const setVisible = useCallback(
    (profileId: string, visible: boolean) => {
      if (!MAP_PROFILES.some((profile) => profile.id === profileId)) return;
      update((current) => {
        const ids = new Set(current.visible);
        if (visible) ids.add(profileId);
        else if (ids.size > 1) ids.delete(profileId);
        return { ...current, visible: [...ids] };
      });
    },
    [update],
  );

  const setPreferredLayers = useCallback(
    (profileId: string, layerIds: readonly string[]) => {
      if (!MAP_PROFILES.some((profile) => profile.id === profileId)) return;
      update((current) => ({
        ...current,
        layers: { ...current.layers, [profileId]: [...layerIds] },
      }));
    },
    [update],
  );

  const reset = useCallback(() => {
    const next = defaultMapProfilePreferences();
    setValue(next);
    setSetting(PREFERENCES_SETTING, JSON.stringify(next));
  }, [setSetting]);

  const visibleProfiles = useMemo(
    () => MAP_PROFILES.filter((profile) => value.visible.includes(profile.id)),
    [value.visible],
  );
  const preferredLayers = useCallback(
    (profileId: string) => preferredLayersForProfile(value, profileId),
    [value],
  );
  const customizedLayers = useCallback(
    (profileId: string) => Object.hasOwn(value.layers, profileId),
    [value.layers],
  );

  return {
    value,
    visibleProfiles,
    preferredLayers,
    customizedLayers,
    setVisible,
    setPreferredLayers,
    reset,
  };
}
