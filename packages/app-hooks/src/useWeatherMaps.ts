import {
  asWeatherMapLayerId,
  closestFrameIndex,
  nowFrameIndex,
  weatherGridUrl,
  weatherMapLegend,
  type WeatherGridResponse,
  type WeatherMapFrame,
  type WeatherMapLayer,
  type WeatherMapLayerId,
  type WeatherMapLegend,
  type WeatherMapsResponse,
  type WeatherMapTimeline,
  type WeatherMapTimelineId,
} from '@atlas/conditions';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export interface ActiveWeatherMapFrame extends WeatherMapFrame {
  /** Absolute {z}/{x}/{y} template on the client's server origin. */
  tileUrlTemplate: string;
}

export interface WeatherMapsController {
  status: 'idle' | 'loading' | 'ready' | 'error';
  /** The switched-on weather field, or null when none is on. */
  layerId: WeatherMapLayerId | null;
  /** That field's catalog entry, once the catalog has answered. */
  layer: WeatherMapLayer | null;
  /** The timelines the field offers, radar first. */
  timelineIds: WeatherMapTimelineId[];
  timeline: WeatherMapTimeline | null;
  frames: WeatherMapFrame[];
  frameIndex: number;
  frame: ActiveWeatherMapFrame | null;
  /**
   * The frames play reaches next. A renderer loads them invisibly, so a step of
   * the animation shows a picture that is already there instead of a blank map
   * while its tiles arrive.
   */
  upcoming: ActiveWeatherMapFrame[];
  /** Where now sits on the timeline (the newest radar picture, or the nearest hour). */
  nowIndex: number;
  /** Whether the selection is pinned to now, and so moves with it as data refreshes. */
  followingNow: boolean;
  playing: boolean;
  attribution: string;
  legend: WeatherMapLegend | null;
  setTimeline: (id: WeatherMapTimelineId) => void;
  selectFrame: (index: number) => void;
  goToNow: () => void;
  togglePlaying: () => void;
  previous: () => void;
  next: () => void;
}

export interface WeatherMapsOptions {
  /** How often the catalog is refetched while a field is on. Radar updates every 5 minutes. */
  refreshMs?: number;
  /** Test seam. */
  now?: () => number;
}

const REFRESH_MS = 5 * 60_000;
/** Radar steps are 5 minutes apart and forecast steps an hour: the hour gets a longer look. */
const STEP_MS: Record<WeatherMapTimelineId, number> = { radar: 450, forecast: 750 };
/** Play pauses on the last frame for this many steps before looping, so the end is readable. */
const END_HOLD_STEPS = 3;

function absoluteTemplate(origin: string, path: string): string {
  if (/^https?:\/\//.test(path)) return path;
  return `${origin.replace(/\/$/, '')}${path}`;
}

/**
 * The timeline behind the weather layers, shared by the web and Android.
 *
 * Driven by which weather row is switched on in the layer catalog — there is no
 * separate weather-map panel to open. While one is on, this fetches the frame
 * catalog (and refreshes it, since radar moves every five minutes), keeps the
 * selected time across layer and data changes, plays, and tells the renderer
 * which frames to warm. The apps draw the rasters and the dock.
 *
 * The selection is a *time*, not an index: switching from wind to temperature
 * lands on the same hour, and a refresh that adds new radar pictures keeps the
 * reader where they were. Until they scrub, the selection follows now.
 */
export function useWeatherMaps(
  origin: string,
  activeLayer: string | null,
  options: WeatherMapsOptions = {},
): WeatherMapsController {
  const refreshMs = options.refreshMs ?? REFRESH_MS;
  const nowRef = useRef(options.now ?? Date.now);
  nowRef.current = options.now ?? Date.now;
  const layerId = asWeatherMapLayerId(activeLayer);
  const on = layerId !== null;

  const [status, setStatus] = useState<WeatherMapsController['status']>('idle');
  const [catalog, setCatalog] = useState<WeatherMapsResponse | null>(null);
  const [timelinePreference, setTimelinePreference] = useState<WeatherMapTimelineId | null>(null);
  /** Chosen validity time; null follows now. */
  const [selectedMs, setSelectedMs] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  // Refreshed when the catalog is, so "now" advances with the data.
  const [nowMs, setNowMs] = useState(() => nowRef.current());

  useEffect(() => {
    if (!on) {
      setPlaying(false);
      return;
    }
    let cancelled = false;
    const load = () => {
      setStatus((current) => (current === 'ready' ? current : 'loading'));
      fetch(`${origin.replace(/\/$/, '')}/api/weather/maps`)
        .then((res) => (res.ok ? (res.json() as Promise<WeatherMapsResponse>) : null))
        .then((answer) => {
          if (cancelled) return;
          if (!answer || !Array.isArray(answer.layers)) {
            // A failed refresh keeps the last good catalog on screen.
            setStatus((current) => (current === 'ready' ? current : 'error'));
            return;
          }
          setCatalog(answer);
          setNowMs(nowRef.current());
          setStatus('ready');
        })
        .catch(() => {
          if (!cancelled) setStatus((current) => (current === 'ready' ? current : 'error'));
        });
    };
    load();
    const timer = setInterval(load, refreshMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [origin, on, refreshMs]);

  const layer = useMemo(
    () => catalog?.layers.find((candidate) => candidate.id === layerId) ?? null,
    [catalog, layerId],
  );
  // A catalog from before timelines has none; its spliced frames stand in as one forecast.
  const timelines = useMemo<WeatherMapTimeline[]>(() => {
    if (!layer) return [];
    if (Array.isArray(layer.timelines) && layer.timelines.length > 0) {
      return [...layer.timelines].sort(
        (a, b) => Number(b.id === 'radar') - Number(a.id === 'radar'),
      );
    }
    return [
      {
        id: 'forecast',
        bounds: layer.bounds,
        minzoom: layer.minzoom,
        maxzoom: layer.maxzoom,
        frames: layer.frames ?? [],
      },
    ];
  }, [layer]);
  const timeline =
    timelines.find((candidate) => candidate.id === timelinePreference) ?? timelines[0] ?? null;
  const frames = useMemo(() => timeline?.frames ?? [], [timeline]);
  const nowIndex = useMemo(() => nowFrameIndex(frames, nowMs), [frames, nowMs]);
  const frameIndex = selectedMs === null ? nowIndex : closestFrameIndex(frames, selectedMs);

  const active = useCallback(
    (frame: WeatherMapFrame | undefined): ActiveWeatherMapFrame | null =>
      frame ? { ...frame, tileUrlTemplate: absoluteTemplate(origin, frame.tilePath) } : null,
    [origin],
  );
  const rawFrame = frames[frameIndex];
  const frame = useMemo(() => active(rawFrame), [active, rawFrame]);
  const upcoming = useMemo(() => {
    if (frames.length < 2) return [];
    const out: ActiveWeatherMapFrame[] = [];
    for (let step = 1; step <= Math.min(2, frames.length - 1); step++) {
      const next = active(frames[(frameIndex + step) % frames.length]);
      if (next) out.push(next);
    }
    return out;
  }, [active, frames, frameIndex]);

  const selectFrame = useCallback(
    (index: number) => {
      if (frames.length === 0) return;
      const clamped = Math.max(0, Math.min(index, frames.length - 1));
      setSelectedMs(Date.parse(frames[clamped]!.time));
    },
    [frames],
  );
  const goToNow = useCallback(() => {
    setPlaying(false);
    setSelectedMs(null);
  }, []);
  const setTimeline = useCallback((id: WeatherMapTimelineId) => {
    setTimelinePreference(id);
    // The two timelines barely overlap in time; a switch lands on now.
    setSelectedMs(null);
  }, []);

  // Play steps through the frames and loops, holding briefly on the last one.
  const playState = useRef({ frames, index: frameIndex, hold: 0 });
  playState.current.frames = frames;
  playState.current.index = frameIndex;
  const stepMs = STEP_MS[timeline?.id ?? 'forecast'];
  useEffect(() => {
    if (!playing || !on || frames.length < 2) return;
    playState.current.hold = 0;
    const timer = setInterval(() => {
      const state = playState.current;
      const count = state.frames.length;
      if (count < 2) return;
      if (state.index >= count - 1 && state.hold < END_HOLD_STEPS) {
        state.hold += 1;
        return;
      }
      state.hold = 0;
      const nextIndex = state.index >= count - 1 ? 0 : state.index + 1;
      state.index = nextIndex;
      setSelectedMs(Date.parse(state.frames[nextIndex]!.time));
    }, stepMs);
    return () => clearInterval(timer);
  }, [playing, on, frames.length, stepMs]);

  const togglePlaying = useCallback(() => setPlaying((current) => !current), []);
  const previous = useCallback(() => selectFrame(frameIndex - 1), [frameIndex, selectFrame]);
  const next = useCallback(() => selectFrame(frameIndex + 1), [frameIndex, selectFrame]);
  const legend = useMemo(() => (layerId ? weatherMapLegend(layerId) : null), [layerId]);

  return {
    status: on ? status : 'idle',
    layerId,
    layer: on ? layer : null,
    timelineIds: timelines.map((candidate) => candidate.id),
    timeline: on ? timeline : null,
    frames: on ? frames : [],
    frameIndex,
    frame: on ? frame : null,
    upcoming: on ? upcoming : [],
    nowIndex,
    followingNow: selectedMs === null,
    playing: on && playing,
    attribution: catalog?.attribution ?? '',
    legend,
    setTimeline,
    selectFrame,
    goToNow,
    togglePlaying,
    previous,
    next,
  };
}

/** A viewport to sample a weather grid over. */
export interface WeatherGridViewport {
  bbox: [number, number, number, number];
  cols: number;
  rows: number;
}

/**
 * The switched-on field's values over a viewport, for the frame on screen —
 * what the wind particles, wind arrows and temperature numbers are drawn from.
 *
 * Answers are cached per URL, so playing through frames the reader has already
 * seen does not refetch, and the last grid stays up while the next one is on
 * its way (a flicker to nothing between frames reads as the wind stopping).
 */
export function useWeatherGrid(
  origin: string,
  maps: WeatherMapsController,
  viewport: WeatherGridViewport | null,
  wanted: boolean,
): WeatherGridResponse | null {
  const [grid, setGrid] = useState<WeatherGridResponse | null>(null);
  const cache = useRef(new Map<string, WeatherGridResponse>());
  const layerId = maps.layerId;
  const frameId = maps.frame?.id ?? null;
  const url =
    wanted && layerId && frameId && viewport
      ? weatherGridUrl(
          origin.replace(/\/$/, ''),
          layerId,
          frameId,
          viewport.bbox,
          viewport.cols,
          viewport.rows,
        )
      : null;

  useEffect(() => {
    if (!url) {
      setGrid(null);
      return;
    }
    const hit = cache.current.get(url);
    if (hit) {
      setGrid(hit);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetch(url, { signal: controller.signal })
        .then((res) => (res.ok ? (res.json() as Promise<WeatherGridResponse>) : null))
        .then((answer) => {
          if (!answer || controller.signal.aborted) return;
          cache.current.set(url, answer);
          // A small cache: one viewport's worth of frames, not a session's.
          if (cache.current.size > 80) {
            cache.current.delete(cache.current.keys().next().value!);
          }
          setGrid(answer);
        })
        .catch(() => {
          // Offline or aborted: the last grid stays until the next frame answers.
        });
    }, 120);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [url]);

  // A grid for another layer is never shown under this one.
  return grid && grid.layer === layerId ? grid : null;
}
