import {
  layersForProfile,
  type LayerMeta,
  type LayersResponse,
  type OverlayStateMap,
} from '@atlas/core';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ActiveOverlay } from '../map/useOverlayLayers.js';

// Visibility/opacity are device-local preferences (`local.` keys never sync).
const STATE_SETTING = 'local.layers.state';

export interface LayerCatalog {
  /** The catalog for the active profile, in the server's display order. */
  catalog: LayerMeta[];
  /** Per-layer visibility/opacity as persisted. */
  state: OverlayStateMap;
  /** The enabled overlays, ready for useOverlayLayers. */
  overlays: ActiveOverlay[];
  toggle: (id: string) => void;
  setOpacity: (id: string, opacity: number) => void;
}

interface SettingsAccess {
  status: string;
  getSetting: (key: string) => Promise<string | null>;
  setSetting: (key: string, value: string) => void;
}

/**
 * Fetches the overlay catalog (GET /api/layers) once and pairs it with the
 * persisted per-device panel state. Toggles keep working in-session even when
 * persistent storage is unavailable — they just don't survive a reload.
 */
export function useLayerCatalog(userData: SettingsAccess, profileId: string): LayerCatalog {
  const [allLayers, setAllLayers] = useState<LayerMeta[]>([]);
  const [state, setState] = useState<OverlayStateMap>({});
  const { status, getSetting, setSetting } = userData;

  useEffect(() => {
    let cancelled = false;
    fetch('/api/layers')
      .then((res) => (res.ok ? (res.json() as Promise<LayersResponse>) : { layers: [] }))
      .then((body) => {
        if (!cancelled) setAllLayers(body.layers ?? []);
      })
      .catch(() => {
        // No catalog (backend down / old server): the panel simply stays empty.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (status !== 'ready') return;
    void getSetting(STATE_SETTING).then((raw) => {
      if (!raw) return;
      try {
        setState(JSON.parse(raw) as OverlayStateMap);
      } catch {
        // Corrupt setting: fall back to everything off.
      }
    });
  }, [status, getSetting]);

  const update = useCallback(
    (mutate: (cur: OverlayStateMap) => OverlayStateMap) => {
      setState((cur) => {
        const next = mutate(cur);
        setSetting(STATE_SETTING, JSON.stringify(next));
        return next;
      });
    },
    [setSetting],
  );

  const toggle = useCallback(
    (id: string) =>
      update((cur) => ({ ...cur, [id]: { ...cur[id], on: !(cur[id]?.on ?? false) } })),
    [update],
  );

  const setOpacity = useCallback(
    (id: string, opacity: number) =>
      update((cur) => ({ ...cur, [id]: { on: cur[id]?.on ?? false, opacity } })),
    [update],
  );

  // Contextual layers are hidden outside their profile, so they must stop
  // drawing too — an overlay on the map that the panel doesn't list is an
  // overlay the user can't switch off. The on-state survives in `state`, so
  // returning to the profile brings it back.
  const catalog = useMemo(() => layersForProfile(allLayers, profileId), [allLayers, profileId]);

  const overlays = useMemo(
    () =>
      catalog
        .filter((meta) => state[meta.id]?.on)
        .map((meta) => ({ meta, opacity: state[meta.id]?.opacity ?? meta.defaultOpacity })),
    [catalog, state],
  );

  return { catalog, state, overlays, toggle, setOpacity };
}
