import {
  layerDefaultsOn,
  layersForProfile,
  type LayerMeta,
  type LayersResponse,
  type OverlayStateMap,
} from '@atlas/core';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { useServerOrigin } from '../serverOrigin';
import type { UserData } from '../useUserData';

// Visibility/opacity are device-local preferences (`local.` keys never sync).
const STATE_SETTING = 'local.layers.state';
// Last-seen catalog, so the panel works offline with known layers.
const CATALOG_SETTING = 'local.layers.catalog';

/** An overlay the user has switched on, ready for MapScene's RasterSource. */
export interface ActiveOverlay {
  meta: LayerMeta;
  opacity: number;
  /** Absolute {z}/{x}/{y} template on the current server origin. */
  tileUrlTemplate: string;
}

export interface OverlaysController {
  /** The catalog narrowed to the active map profile. */
  catalog: LayerMeta[];
  state: OverlayStateMap;
  overlays: ActiveOverlay[];
  /** Resolve an explicit choice against the active profile's default. */
  isOn: (id: string) => boolean;
  setOn: (id: string, on: boolean) => void;
  toggle: (id: string) => void;
  setOpacity: (id: string, opacity: number) => void;
}

/**
 * The overlay catalog + per-device panel state (Android twin of the web's
 * useLayerCatalog). The catalog comes from GET /api/layers and is cached in a
 * local setting — offline-first: the last-seen catalog keeps the sheet and any
 * cached tiles usable without connectivity.
 */
export function useOverlays(data: UserData, profileId: string): OverlaysController {
  const origin = useServerOrigin();
  const [allLayers, setAllLayers] = useState<LayerMeta[]>([]);
  const [state, setState] = useState<OverlayStateMap>({});
  const { status, getSetting, setSetting } = data;

  useEffect(() => {
    if (status !== 'ready') return;
    let cancelled = false;
    void getSetting(STATE_SETTING).then((raw) => {
      if (cancelled || !raw) return;
      try {
        setState(JSON.parse(raw) as OverlayStateMap);
      } catch {
        // Corrupt setting: everything stays off.
      }
    });
    void getSetting(CATALOG_SETTING).then((raw) => {
      if (cancelled || !raw) return;
      try {
        // Only seed from the cache while the live fetch hasn't answered yet.
        setAllLayers((cur) => (cur.length > 0 ? cur : (JSON.parse(raw) as LayerMeta[])));
      } catch {
        // Corrupt cache: wait for the live fetch.
      }
    });
    return () => {
      cancelled = true;
    };
  }, [status, getSetting]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`${origin}/api/layers`);
        if (!res.ok) return;
        const body = (await res.json()) as LayersResponse;
        if (cancelled || !Array.isArray(body.layers)) return;
        setAllLayers(body.layers);
        setSetting(CATALOG_SETTING, JSON.stringify(body.layers));
      } catch {
        // Offline: the cached catalog (if any) carries the sheet.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [origin, setSetting]);

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
      update((cur) => ({
        ...cur,
        [id]: { ...cur[id], on: !(cur[id]?.on ?? layerDefaultsOn(id, profileId)) },
      })),
    [update, profileId],
  );

  const setOn = useCallback(
    (id: string, on: boolean) =>
      update((cur) => ({
        ...cur,
        [id]: { ...cur[id], on },
      })),
    [update],
  );

  const isOn = useCallback(
    (id: string) => state[id]?.on ?? layerDefaultsOn(id, profileId),
    [state, profileId],
  );

  const setOpacity = useCallback(
    (id: string, opacity: number) =>
      update((cur) => ({
        ...cur,
        [id]: { on: cur[id]?.on ?? layerDefaultsOn(id, profileId), opacity },
      })),
    [update, profileId],
  );

  // A contextual layer must stop drawing outside its profile; its explicit
  // state stays stored, so switching back restores the user's choice.
  const catalog = useMemo(() => layersForProfile(allLayers, profileId), [allLayers, profileId]);

  const overlays = useMemo(
    () =>
      catalog
        .filter((meta) => isOn(meta.id))
        .map((meta) => ({
          meta,
          opacity: state[meta.id]?.opacity ?? meta.defaultOpacity,
          tileUrlTemplate: `${origin}/api/overlay/${meta.id}/{z}/{x}/{y}.png`,
        })),
    [catalog, state, origin, isOn],
  );

  return { catalog, state, overlays, isOn, setOn, toggle, setOpacity };
}
