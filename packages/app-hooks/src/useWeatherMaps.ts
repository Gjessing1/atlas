import {
  type WeatherMapFrame,
  type WeatherMapLayer,
  type WeatherMapLayerId,
  type WeatherMapsResponse,
} from '@atlas/conditions';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export interface ActiveWeatherMapFrame extends WeatherMapFrame {
  tileUrlTemplate: string;
}

export interface WeatherMapsController {
  status: 'idle' | 'loading' | 'ready' | 'error';
  layers: WeatherMapLayer[];
  layer: WeatherMapLayer | null;
  frame: ActiveWeatherMapFrame | null;
  frameIndex: number;
  visible: boolean;
  playing: boolean;
  attribution: string;
  lightningReason: string | null;
  selectLayer: (id: WeatherMapLayerId) => void;
  selectFrame: (index: number) => void;
  setVisible: (visible: boolean) => void;
  togglePlaying: () => void;
  previous: () => void;
  next: () => void;
}

function closestFrame(frames: readonly WeatherMapFrame[], targetMs: number): number {
  let answer = 0;
  let distance = Number.POSITIVE_INFINITY;
  frames.forEach((frame, index) => {
    const candidate = Math.abs(Date.parse(frame.time) - targetMs);
    if (candidate < distance) {
      answer = index;
      distance = candidate;
    }
  });
  return answer;
}

function absoluteTemplate(origin: string, path: string): string {
  if (/^https?:\/\//.test(path)) return path;
  return `${origin.replace(/\/$/, '')}${path}`;
}

/**
 * Shared timeline state for the web and native weather-map surfaces. The apps
 * only render controls and a raster source; discovery, layer switching and the
 * slideshow's time semantics live here once.
 */
export function useWeatherMaps(origin: string, enabled: boolean): WeatherMapsController {
  const [status, setStatus] = useState<WeatherMapsController['status']>('idle');
  const [catalog, setCatalog] = useState<WeatherMapsResponse | null>(null);
  const [layerId, setLayerId] = useState<WeatherMapLayerId>('precipitation');
  const [frameIndex, setFrameIndex] = useState(0);
  const [visible, setVisible] = useState(false);
  const [playing, setPlaying] = useState(false);
  const selectedTime = useRef(Date.now());
  const selectedLayerId = useRef<WeatherMapLayerId>('precipitation');

  useEffect(() => {
    if (!enabled) {
      setPlaying(false);
      setVisible(false);
      return;
    }
    let cancelled = false;
    setStatus('loading');
    fetch(`${origin.replace(/\/$/, '')}/api/weather/maps`)
      .then((res) => (res.ok ? (res.json() as Promise<WeatherMapsResponse>) : null))
      .then((answer) => {
        if (cancelled) return;
        if (!answer || !Array.isArray(answer.layers) || answer.layers.length === 0) {
          setStatus('error');
          return;
        }
        setCatalog(answer);
        const wanted =
          answer.layers.find((layer) => layer.id === selectedLayerId.current) ?? answer.layers[0]!;
        selectedLayerId.current = wanted.id;
        setLayerId(wanted.id);
        setFrameIndex(closestFrame(wanted.frames, selectedTime.current));
        setStatus('ready');
      })
      .catch(() => {
        if (!cancelled) setStatus('error');
      });
    return () => {
      cancelled = true;
    };
    // Opening the surface is the refresh event; catalog intentionally stays as
    // a stale visual fallback while that request is in flight. The selection
    // itself lives in selectedLayerId so switching layers does not refetch.
  }, [origin, enabled]);

  const layer = useMemo(
    () => catalog?.layers.find((candidate) => candidate.id === layerId) ?? null,
    [catalog, layerId],
  );
  const rawFrame =
    layer?.frames[Math.min(frameIndex, Math.max(0, layer.frames.length - 1))] ?? null;
  const frame = useMemo<ActiveWeatherMapFrame | null>(
    () =>
      rawFrame
        ? { ...rawFrame, tileUrlTemplate: absoluteTemplate(origin, rawFrame.tilePath) }
        : null,
    [origin, rawFrame],
  );

  const selectLayer = useCallback(
    (id: WeatherMapLayerId) => {
      const next = catalog?.layers.find((candidate) => candidate.id === id);
      if (!next) return;
      const at = rawFrame ? Date.parse(rawFrame.time) : selectedTime.current;
      selectedLayerId.current = id;
      setLayerId(id);
      setFrameIndex(closestFrame(next.frames, at));
    },
    [catalog, rawFrame],
  );

  const selectFrame = useCallback(
    (index: number) => {
      if (!layer) return;
      const clamped = Math.max(0, Math.min(index, layer.frames.length - 1));
      selectedTime.current = Date.parse(layer.frames[clamped]!.time);
      setFrameIndex(clamped);
    },
    [layer],
  );

  const previous = useCallback(() => selectFrame(frameIndex - 1), [frameIndex, selectFrame]);
  const next = useCallback(() => selectFrame(frameIndex + 1), [frameIndex, selectFrame]);
  const updateVisible = useCallback((nextVisible: boolean) => {
    setVisible(nextVisible);
    if (!nextVisible) setPlaying(false);
  }, []);

  useEffect(() => {
    if (!playing || !visible || !layer || layer.frames.length < 2) return;
    const timer = setInterval(() => {
      setFrameIndex((current) => {
        const nextIndex = current >= layer.frames.length - 1 ? 0 : current + 1;
        selectedTime.current = Date.parse(layer.frames[nextIndex]!.time);
        return nextIndex;
      });
    }, 700);
    return () => clearInterval(timer);
  }, [playing, visible, layer]);

  return {
    status,
    layers: catalog?.layers ?? [],
    layer,
    frame,
    frameIndex,
    visible,
    playing,
    attribution: catalog?.attribution ?? '',
    lightningReason: catalog?.lightning.reason ?? null,
    selectLayer,
    selectFrame,
    setVisible: updateVisible,
    togglePlaying: () => setPlaying((current) => !current),
    previous,
    next,
  };
}
