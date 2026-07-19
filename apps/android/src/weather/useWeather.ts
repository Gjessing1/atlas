import type { WeatherForecast } from '@atlas/conditions';
import type { LatLng } from '@atlas/core';
import { useEffect, useState } from 'react';

import { useServerOrigin } from '../serverOrigin';

export interface WeatherState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  /** Kept through a reload for the same/nearby target so the sheet doesn't flash empty. */
  forecast: WeatherForecast | null;
}

/**
 * Fetches the proxied met.no forecast for a target point (null target = idle).
 * The web twin of this hook lives in apps/web/src/weather/useWeather.ts; the
 * only difference here is the absolute server origin (one APK, any server).
 */
export function useWeather(target: LatLng | null): WeatherState {
  const origin = useServerOrigin();
  const [state, setState] = useState<WeatherState>({ status: 'idle', forecast: null });
  const lat = target?.lat;
  const lng = target?.lng;

  useEffect(() => {
    if (lat === undefined || lng === undefined) {
      setState({ status: 'idle', forecast: null });
      return;
    }
    let cancelled = false;
    setState((cur) => ({ status: 'loading', forecast: cur.forecast }));
    fetch(`${origin}/api/weather?lat=${lat.toFixed(4)}&lon=${lng.toFixed(4)}`)
      .then((res) => (res.ok ? (res.json() as Promise<WeatherForecast>) : null))
      .then((forecast) => {
        if (!cancelled) {
          setState(forecast ? { status: 'ready', forecast } : { status: 'error', forecast: null });
        }
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'error', forecast: null });
      });
    return () => {
      cancelled = true;
    };
  }, [origin, lat, lng]);

  return state;
}
