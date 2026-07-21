import { isThemeMode, type ColorScheme, type ThemeMode } from '@atlas/core';
import { useCallback, useEffect, useState } from 'react';

const THEME_SETTING = 'local.appearance.theme';

export interface ThemeModeSettings {
  status: string;
  getSetting: (key: string) => Promise<string | null>;
  setSetting: (key: string, value: string) => void;
}

export interface ThemeModeController {
  mode: ThemeMode;
  colorScheme: ColorScheme;
  setMode: (mode: ThemeMode) => void;
}

/** Persisted per-device theme preference, resolved against the live OS scheme. */
export function useThemeMode(
  settings: ThemeModeSettings,
  systemColorScheme: ColorScheme,
): ThemeModeController {
  const [mode, setModeState] = useState<ThemeMode>('system');
  const { status, getSetting, setSetting } = settings;

  useEffect(() => {
    if (status !== 'ready') return;
    let cancelled = false;
    void getSetting(THEME_SETTING).then((stored) => {
      if (!cancelled && isThemeMode(stored)) setModeState(stored);
    });
    return () => {
      cancelled = true;
    };
  }, [status, getSetting]);

  const setMode = useCallback(
    (next: ThemeMode) => {
      setModeState(next);
      setSetting(THEME_SETTING, next);
    },
    [setSetting],
  );

  return {
    mode,
    colorScheme: mode === 'system' ? systemColorScheme : mode,
    setMode,
  };
}
