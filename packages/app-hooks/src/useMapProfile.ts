import { DEFAULT_MAP_PROFILE, isMapProfile, mapProfile, type MapProfile } from '@atlas/core';
import { useCallback, useEffect, useState } from 'react';

// Which activity you're doing is a per-device choice, like the layer panel
// state — a phone in a ski bag and a desktop planning a drive disagree on
// purpose, so this never syncs (`local.` keys are excluded from sync).
const PROFILE_SETTING = 'local.map.profile';

export interface MapProfileSettings {
  status: string;
  getSetting: (key: string) => Promise<string | null>;
  setSetting: (key: string, value: string) => void;
}

export interface MapProfileController {
  profile: MapProfile;
  setProfile: (id: string) => void;
}

/**
 * The active map profile, persisted per device.
 *
 * Switching profiles is deliberately cheap and reversible: it changes which
 * contextual overlays are offered and the travel mode new routes default to,
 * and nothing else — no saved data moves, and layers the user had switched on
 * keep their on-state for when they come back.
 */
export function useMapProfile(settings: MapProfileSettings): MapProfileController {
  const [id, setId] = useState<string>(DEFAULT_MAP_PROFILE);
  const { status, getSetting, setSetting } = settings;

  useEffect(() => {
    if (status !== 'ready') return;
    let cancelled = false;
    void getSetting(PROFILE_SETTING).then((raw) => {
      // An unknown id (downgrade, hand-edited setting) falls back to Explore
      // rather than hiding the contextual catalog behind a dead profile.
      if (!cancelled && isMapProfile(raw)) setId(raw);
    });
    return () => {
      cancelled = true;
    };
  }, [status, getSetting]);

  const setProfile = useCallback(
    (next: string) => {
      if (!isMapProfile(next)) return;
      setId(next);
      setSetting(PROFILE_SETTING, next);
    },
    [setSetting],
  );

  return { profile: mapProfile(id), setProfile };
}
