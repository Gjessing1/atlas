import {
  layerDefaultsOn,
  layerOptionSignature,
  layersForProfile,
  normalizeLayerOptions,
  overlayTileUrl,
  type LayerMeta,
  type LayersResponse,
  type OverlayStateMap,
} from '@atlas/core';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { useServerOrigin } from '../serverOrigin';
import type { UserData } from '../useUserData';

// Vector overlay ids MapScene knows how to draw as GeoJSON. Any vector layer
// outside this set is hidden from the panel until its renderer lands (see the
// `renderableLayers` filter below). Kept as an explicit id set rather than a
// clever heuristic — the vector layers genuinely differ in what drawing them
// means (hunting-field polygons vs. camera dots and average-speed lines).
const RENDERABLE_VECTOR_IDS = new Set(['statskog-jaktfelt', 'speed-cameras', 'ice-observations']);

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
  /** The layer's resolved options, for the layers that declare any. */
  options: Record<string, string>;
  /**
   * Source id, carrying the option variant so that picking a different species
   * remounts the source instead of leaving the old tiles in place.
   */
  sourceId: string;
}

export interface OverlaysController {
  /** The active map profile, so the sheet can show its standing caveat. */
  profileId: string;
  /**
   * The derived potential surface currently switched on, with its resolved
   * target — what the preparation pill prepares and what a map tap asks to have
   * explained. At most one; see the web twin in useLayerCatalog.
   */
  derived: { meta: LayerMeta; layer: string; target: string } | null;
  /** Full cached/live catalog; profile settings configure inactive profiles from it. */
  allCatalog: LayerMeta[];
  /** The catalog narrowed to the active map profile. */
  catalog: LayerMeta[];
  state: OverlayStateMap;
  overlays: ActiveOverlay[];
  /** Resolve an explicit choice against the active profile's default. */
  isOn: (id: string) => boolean;
  opacityFor: (id: string) => number;
  /** The layer's resolved variant (see `LayerMeta.options`), defaults filled in. */
  optionsFor: (meta: LayerMeta) => Record<string, string>;
  setOption: (meta: LayerMeta, key: string, value: string) => void;
  setOn: (id: string, on: boolean) => void;
  setProfileOn: (profileId: string, id: string, on: boolean) => void;
  toggle: (id: string) => void;
  setOpacity: (id: string, opacity: number) => void;
}

/**
 * The overlay catalog + per-device panel state (Android twin of the web's
 * useLayerCatalog). The catalog comes from GET /api/layers and is cached in a
 * local setting — offline-first: the last-seen catalog keeps the sheet and any
 * cached tiles usable without connectivity.
 */
export function useOverlays(
  data: UserData,
  profileId: string,
  preferredLayers: readonly string[] = [],
  customizedLayers = false,
): OverlaysController {
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

  const stateKey = useCallback((forProfile: string, id: string) => `${forProfile}:${id}`, []);

  const setOn = useCallback(
    (id: string, on: boolean) =>
      update((cur) => ({
        ...cur,
        [stateKey(profileId, id)]: { ...cur[stateKey(profileId, id)], on },
      })),
    [update, stateKey, profileId],
  );

  const setProfileOn = useCallback(
    (forProfile: string, id: string, on: boolean) =>
      update((cur) => ({
        ...cur,
        [stateKey(forProfile, id)]: { ...cur[stateKey(forProfile, id)], on },
      })),
    [update, stateKey],
  );

  const isOn = useCallback(
    (id: string) =>
      state[stateKey(profileId, id)]?.on ??
      (customizedLayers
        ? preferredLayers.includes(id)
        : (state[id]?.on ?? layerDefaultsOn(id, profileId))),
    [state, stateKey, profileId, customizedLayers, preferredLayers],
  );

  const toggle = useCallback((id: string) => setOn(id, !isOn(id)), [setOn, isOn]);

  const setOpacity = useCallback(
    (id: string, opacity: number) =>
      update((cur) => ({
        ...cur,
        [stateKey(profileId, id)]: {
          on: cur[stateKey(profileId, id)]?.on ?? isOn(id),
          opacity,
        },
      })),
    [update, stateKey, profileId, isOn],
  );

  const opacityFor = useCallback(
    (id: string) =>
      state[stateKey(profileId, id)]?.opacity ??
      state[id]?.opacity ??
      allLayers.find((meta) => meta.id === id)?.defaultOpacity ??
      1,
    [state, stateKey, profileId, allLayers],
  );

  // A variant belongs to the layer, not to the profile it is viewed in — the
  // species you hunt does not change because you switched to Hike — so it is
  // stored under the plain layer id, unlike on/off and opacity.
  const optionsFor = useCallback(
    (meta: LayerMeta) => normalizeLayerOptions(meta.options, state[meta.id]?.options),
    [state],
  );

  const setOption = useCallback(
    (meta: LayerMeta, key: string, value: string) =>
      update((cur) => ({
        ...cur,
        [meta.id]: {
          ...cur[meta.id],
          options: normalizeLayerOptions(meta.options, {
            ...cur[meta.id]?.options,
            [key]: value,
          }),
        },
      })),
    [update],
  );

  // Vector overlays are only offered once MapScene can draw them — a toggle
  // that draws nothing is worse than not offering it. Both current ones do:
  // the Statskog jaktfelt polygons (useHuntingFields) and the ATK cameras
  // (useSpeedCameras), each a GeoJSON overlay MapScene paints. The *stored*
  // catalog cache stays raw, so widening this set needs no migration.
  const renderableLayers = useMemo(
    () => allLayers.filter((meta) => !meta.vector || RENDERABLE_VECTOR_IDS.has(meta.id)),
    [allLayers],
  );

  // A contextual layer must stop drawing outside its profile; its explicit
  // state stays stored, so switching back restores the user's choice.
  const catalog = useMemo(
    () => layersForProfile(renderableLayers, profileId),
    [renderableLayers, profileId],
  );

  const overlays = useMemo(
    () =>
      catalog
        .filter((meta) => isOn(meta.id))
        .map((meta) => {
          const options = optionsFor(meta);
          const signature = layerOptionSignature(options);
          return {
            meta,
            opacity: opacityFor(meta.id),
            tileUrlTemplate: overlayTileUrl(origin, meta, options),
            options,
            sourceId: `atlas-overlay-${meta.id}${signature ? `--${signature}` : ''}`,
          };
        }),
    [catalog, origin, isOn, opacityFor, optionsFor],
  );

  const derived = useMemo(() => {
    const active = overlays.find((overlay) => overlay.meta.derived);
    if (!active) return null;
    return { meta: active.meta, layer: active.meta.id, target: active.options['target'] ?? '' };
  }, [overlays]);

  return {
    profileId,
    derived,
    allCatalog: renderableLayers,
    catalog,
    state,
    overlays,
    isOn,
    opacityFor,
    optionsFor,
    setOption,
    setOn,
    setProfileOn,
    toggle,
    setOpacity,
  };
}
