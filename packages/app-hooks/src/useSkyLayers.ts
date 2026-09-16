import {
  LIGHTNING_WINDOWS,
  type AuroraForecastStatus,
  type LightningWindow,
} from '@atlas/conditions';
import { useCallback, useEffect, useState } from 'react';

export interface SkyLayersController {
  lightning: {
    window: LightningWindow;
    windows: typeof LIGHTNING_WINDOWS;
    setWindow: (window: LightningWindow) => void;
  };
  aurora: {
    status: 'idle' | 'loading' | 'ready' | 'error';
    forecast: AuroraForecastStatus | null;
  };
}

/** Shared controls and forecast metadata for the two live sky layers. */
export function useSkyLayers(
  origin: string,
  auroraActive: boolean,
  refreshMs = 5 * 60_000,
): SkyLayersController {
  const [window, setWindowState] = useState<LightningWindow>('1h');
  const [status, setStatus] = useState<SkyLayersController['aurora']['status']>('idle');
  const [forecast, setForecast] = useState<AuroraForecastStatus | null>(null);

  useEffect(() => {
    if (!auroraActive) {
      setStatus('idle');
      return;
    }
    let cancelled = false;
    const load = async () => {
      setStatus((current) => (current === 'ready' ? current : 'loading'));
      try {
        const response = await fetch(`${origin.replace(/\/$/, '')}/api/weather/aurora`);
        if (!response.ok) throw new Error(`aurora metadata ${response.status}`);
        const answer = (await response.json()) as AuroraForecastStatus;
        if (!cancelled) {
          setForecast(answer);
          setStatus('ready');
        }
      } catch {
        if (!cancelled) setStatus((current) => (current === 'ready' ? current : 'error'));
      }
    };
    void load();
    const timer = setInterval(() => void load(), refreshMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [origin, auroraActive, refreshMs]);

  const setWindow = useCallback((value: LightningWindow) => setWindowState(value), []);
  return {
    lightning: { window, windows: LIGHTNING_WINDOWS, setWindow },
    aurora: { status: auroraActive ? status : 'idle', forecast: auroraActive ? forecast : null },
  };
}
