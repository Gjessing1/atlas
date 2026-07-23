import {
  DEFAULT_MAP_STYLE_OVERRIDES,
  sanitizeMapStyleOverrides,
  type MapStyleOverrides,
} from '@atlas/core';
import { useCallback, useEffect, useState } from 'react';

const STYLE_SETTING = 'local.map.style-overrides';

export interface MapStyleSettings {
  status: string;
  getSetting: (key: string) => Promise<string | null>;
  setSetting: (key: string, value: string) => void;
}

export interface MapStyleEditorController {
  value: MapStyleOverrides;
  setColor: (
    key: 'landColor' | 'waterColor' | 'roadColor' | 'pathColor',
    value: string | null,
  ) => void;
  setLabelScale: (value: number) => void;
  setPoiScale: (value: number) => void;
  reset: () => void;
}

/** Persisted, per-device map-style edits shared by the web and Android adapters. */
export function useMapStyleEditor(settings: MapStyleSettings): MapStyleEditorController {
  const [value, setValue] = useState<MapStyleOverrides>({ ...DEFAULT_MAP_STYLE_OVERRIDES });
  const { status, getSetting, setSetting } = settings;

  useEffect(() => {
    if (status !== 'ready') return;
    let cancelled = false;
    void getSetting(STYLE_SETTING).then((stored) => {
      if (cancelled || !stored) return;
      try {
        setValue(sanitizeMapStyleOverrides(JSON.parse(stored)));
      } catch {
        // Corrupt local preference: retain Atlas defaults.
      }
    });
    return () => {
      cancelled = true;
    };
  }, [status, getSetting]);

  const update = useCallback(
    (mutate: (current: MapStyleOverrides) => MapStyleOverrides) => {
      setValue((current) => {
        const next = sanitizeMapStyleOverrides(mutate(current));
        setSetting(STYLE_SETTING, JSON.stringify(next));
        return next;
      });
    },
    [setSetting],
  );

  const setColor = useCallback(
    (key: 'landColor' | 'waterColor' | 'roadColor' | 'pathColor', color: string | null) =>
      update((current) => {
        const next = { ...current };
        if (color) next[key] = color;
        else delete next[key];
        return next;
      }),
    [update],
  );

  const setLabelScale = useCallback(
    (labelScale: number) => update((current) => ({ ...current, labelScale })),
    [update],
  );
  const setPoiScale = useCallback(
    (poiScale: number) => update((current) => ({ ...current, poiScale })),
    [update],
  );
  const reset = useCallback(() => {
    const next = { ...DEFAULT_MAP_STYLE_OVERRIDES };
    setValue(next);
    setSetting(STYLE_SETTING, JSON.stringify(next));
  }, [setSetting]);

  return { value, setColor, setLabelScale, setPoiScale, reset };
}
