import { TransitError } from '@atlas/transit';
import type { TransitCommuteQuery, TransitCommuteResult } from '@atlas/transit';
import type { PlaceRecord } from '@atlas/storage';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export const COMMUTE_SETTING_KEY = 'transit.commute';

export interface CommuteConfig {
  fromId: string | null;
  viaId: string | null;
  toId: string | null;
  allowedBusLines: string[];
  excludedRailStops: string[];
}

export interface CommuteSettings {
  status: 'loading' | 'ready' | 'error';
  getSetting: (key: string) => Promise<string | null>;
  setSetting: (key: string, value: string) => void;
}

export type CommuteFn = (
  query: TransitCommuteQuery,
  signal: AbortSignal,
) => Promise<TransitCommuteResult>;

export interface CommuteController {
  /** Saved configuration has finished loading and controls may safely write. */
  ready: boolean;
  config: CommuteConfig;
  setConfig: (config: CommuteConfig) => void;
  query: TransitCommuteQuery | null;
  result: TransitCommuteResult | null;
  loading: boolean;
  error: string | null;
  updatedMs: number | null;
  refresh: () => void;
}

const EMPTY_CONFIG: CommuteConfig = {
  fromId: null,
  viaId: null,
  toId: null,
  allowedBusLines: ['280', '71'],
  excludedRailStops: ['Hvalstad'],
};

const findNamed = (places: readonly PlaceRecord[], needle: string): string | null => {
  const normalizedNeedle = needle.toLocaleLowerCase('nb-NO');
  return (
    places.find((place) => place.name.toLocaleLowerCase('nb-NO').includes(normalizedNeedle))?.id ??
    null
  );
};

/** First-run defaults for the commute requested by this Atlas installation. */
export function defaultCommuteConfig(places: readonly PlaceRecord[]): CommuteConfig {
  return {
    ...EMPTY_CONFIG,
    fromId: findNamed(places, 'engelsrud'),
    viaId: findNamed(places, 'asker'),
    toId:
      findNamed(places, 'nationaltheatret') ??
      findNamed(places, 'nationalteater') ??
      findNamed(places, 'national'),
  };
}

export function parseCommuteConfig(value: string | null): CommuteConfig | null {
  if (!value) return null;
  try {
    const raw = JSON.parse(value) as Partial<CommuteConfig>;
    const id = (candidate: unknown): string | null =>
      typeof candidate === 'string' && candidate ? candidate : null;
    const strings = (candidate: unknown, fallback: string[]): string[] =>
      Array.isArray(candidate)
        ? candidate
            .filter((item): item is string => typeof item === 'string')
            .map((item) => item.trim())
            .filter(Boolean)
        : fallback;
    return {
      fromId: id(raw.fromId),
      viaId: id(raw.viaId),
      toId: id(raw.toId),
      allowedBusLines: strings(raw.allowedBusLines, EMPTY_CONFIG.allowedBusLines),
      excludedRailStops: strings(raw.excludedRailStops, EMPTY_CONFIG.excludedRailStops),
    };
  } catch {
    return null;
  }
}

/** Saved commute state shared by the web board, Android board and widget bridge. */
export function useCommute(
  settings: CommuteSettings,
  places: readonly PlaceRecord[],
  fetchCommute: CommuteFn,
  active: boolean,
): CommuteController {
  const { status, getSetting, setSetting: saveSetting } = settings;
  const [config, setConfigState] = useState<CommuteConfig>(EMPTY_CONFIG);
  const [loaded, setLoaded] = useState(false);
  const [result, setResult] = useState<TransitCommuteResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [updatedMs, setUpdatedMs] = useState<number | null>(null);
  const [seed, setSeed] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (status !== 'ready' || loaded) return;
    let current = true;
    void getSetting(COMMUTE_SETTING_KEY).then((saved) => {
      if (!current) return;
      const next = parseCommuteConfig(saved) ?? defaultCommuteConfig(places);
      setConfigState(next);
      if (!saved) saveSetting(COMMUTE_SETTING_KEY, JSON.stringify(next));
      setLoaded(true);
    });
    return () => {
      current = false;
    };
  }, [getSetting, loaded, places, saveSetting, status]);

  const byId = useMemo(() => new Map(places.map((place) => [place.id, place])), [places]);
  const query = useMemo<TransitCommuteQuery | null>(() => {
    const from = config.fromId ? byId.get(config.fromId) : undefined;
    const via = config.viaId ? byId.get(config.viaId) : undefined;
    const to = config.toId ? byId.get(config.toId) : undefined;
    if (!from || !to || from.id === to.id || config.allowedBusLines.length === 0) return null;
    return {
      from: { name: from.name, lat: from.lat, lng: from.lng },
      via:
        via && via.id !== from.id && via.id !== to.id
          ? [{ name: via.name, lat: via.lat, lng: via.lng }]
          : [],
      to: { name: to.name, lat: to.lat, lng: to.lng },
      allowedBusLines: config.allowedBusLines,
      excludedRailStops: config.excludedRailStops,
      limit: 10,
    };
  }, [byId, config]);
  const queryKey = query ? JSON.stringify(query) : '';

  useEffect(() => {
    abortRef.current?.abort();
    if (!active || !loaded || !query) {
      setResult(null);
      setLoading(false);
      setError(null);
      setUpdatedMs(null);
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const next = await fetchCommute(query, controller.signal);
        if (controller.signal.aborted) return;
        setResult(next);
        setError(null);
        setUpdatedMs(Date.now());
      } catch (err) {
        if (controller.signal.aborted) return;
        setResult(null);
        setUpdatedMs(null);
        setError(
          err instanceof TransitError
            ? err.message
            : 'Commute board unavailable — check your connection.',
        );
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
    // query enters through its stable serialized value; callers rebuild it.
  }, [active, fetchCommute, loaded, queryKey, seed]);

  const setConfig = useCallback(
    (next: CommuteConfig) => {
      setConfigState(next);
      saveSetting(COMMUTE_SETTING_KEY, JSON.stringify(next));
    },
    [saveSetting],
  );
  const refresh = useCallback(() => setSeed((value) => value + 1), []);

  return { ready: loaded, config, setConfig, query, result, loading, error, updatedMs, refresh };
}
