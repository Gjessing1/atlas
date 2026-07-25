import { useCallback, useEffect, useState } from 'react';

/** Device-local: which regions this phone keeps current is not a synced choice. */
const AUTO_UPDATE_SETTING = 'local.regions.auto-update';

export interface OfflinePrefsSettings {
  status: string;
  getSetting: (key: string) => Promise<string | null>;
  setSetting: (key: string, value: string) => void;
}

export interface OfflinePrefsController {
  /**
   * Refresh downloaded regions by themselves once the server has rebuilt them.
   * On by default: the download is Wi-Fi-only and replaces a region the user
   * already chose, and the alternative is a map quietly drawing months-old OSM
   * data until someone notices the badge.
   */
  autoUpdate: boolean;
  setAutoUpdate: (value: boolean) => void;
}

export function useOfflinePrefs(settings: OfflinePrefsSettings): OfflinePrefsController {
  const { status, getSetting, setSetting } = settings;
  const [autoUpdate, setState] = useState(true);

  useEffect(() => {
    if (status !== 'ready') return;
    let cancelled = false;
    void getSetting(AUTO_UPDATE_SETTING).then((raw) => {
      if (!cancelled && raw != null) setState(raw !== 'false');
    });
    return () => {
      cancelled = true;
    };
  }, [status, getSetting]);

  const setAutoUpdate = useCallback(
    (value: boolean) => {
      setState(value);
      setSetting(AUTO_UPDATE_SETTING, String(value));
    },
    [setSetting],
  );

  return { autoUpdate, setAutoUpdate };
}
