import type { LatLng } from '@atlas/core';
import { useCallback, useState } from 'react';

export interface WeatherTargetController {
  /** The point the weather panel is describing; null = panel closed. */
  target: LatLng | null;
  setTarget: (at: LatLng | null) => void;
  /** Topbar button: open onto the pin if there is one, else the map centre. */
  toggle: () => void;
  /** Panel button: move the forecast to wherever the map is looking now. */
  retarget: () => void;
}

/**
 * Which point the weather panel is aimed at. Weather is about a place, not
 * about the camera, so the target is picked once and then stays put until the
 * user re-aims it — panning the map underneath does not silently change the
 * forecast they are reading.
 */
export function useWeatherTarget(
  pin: LatLng | null,
  center: () => LatLng | null,
  fallback: LatLng,
): WeatherTargetController {
  const [target, setTarget] = useState<LatLng | null>(null);

  const toggle = useCallback(() => {
    setTarget((cur) => (cur ? null : (pin ?? center() ?? fallback)));
  }, [pin, center, fallback]);

  const retarget = useCallback(() => {
    setTarget(center() ?? fallback);
  }, [center, fallback]);

  return { target, setTarget, toggle, retarget };
}
