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
  /**
   * A pin was dropped, dragged or picked from search: follow it, but only while
   * the panel is already open — see {@link followPin}.
   */
  followPin: (at: LatLng | null) => void;
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

  /**
   * Placing a pin *is* aiming the forecast — with the panel open, dropping a pin
   * somewhere else and being told the weather at the old spot is just wrong.
   * This is the one exception to "panning does not move the target": the user
   * pointed at a place, deliberately. Clearing the pin leaves the panel where it
   * was rather than closing it; removing a marker is not a request to stop
   * reading the forecast.
   */
  const followPin = useCallback((at: LatLng | null) => {
    setTarget((cur) => (cur && at ? at : cur));
  }, []);

  return { target, setTarget, toggle, retarget, followPin };
}
