import {
  BASEMAP_STATE_ID,
  basemapVisible,
  layerDefaultsOn,
  layersForProfile,
  normalizeLayerOptions,
  OVERLAY_STATE_SETTING,
  readSetting,
  type LayerMeta,
  type LayersResponse,
  type OverlayStateMap,
} from '@atlas/core';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ActiveOverlay } from '../map/useOverlayLayers.js';

export interface LayerCatalog {
  /** The active map profile, so panels can show its standing caveat. */
  profileId: string;
  /** Full server catalog; profile settings use it to configure inactive profiles. */
  allCatalog: LayerMeta[];
  /** The catalog for the active profile, in the server's display order. */
  catalog: LayerMeta[];
  /** Per-layer visibility/opacity as persisted. */
  state: OverlayStateMap;
  /** The enabled overlays, ready for useOverlayLayers. */
  overlays: ActiveOverlay[];
  /**
   * The derived potential surface currently switched on, with its chosen
   * target resolved — what the preparation pill prepares and what a map tap
   * asks to have explained.
   *
   * At most one: the surfaces are opinions about the same ground and stacking
   * two of them would render a colour nobody can read. If more than one is
   * somehow on, the first in catalog order wins, and the rest still draw — this
   * decides which one the *pill and the card* speak for, not what is visible.
   */
  derived: { meta: LayerMeta; layer: string; target: string } | null;
  /**
   * Whether a layer is currently on, resolving the device's stored choice
   * against the active profile's default (a hike-profile trail layer reads as
   * on before it has ever been touched). Panels/switchers must use this rather
   * than `state[id]?.on` so what they draw matches what the map draws.
   */
  isOn: (id: string) => boolean;
  /**
   * Whether the vector basemap draws under the overlays in this profile — on
   * until the user says otherwise. Stored beside layer visibility and keyed the
   * same way (see `BASEMAP_STATE_ID`), because it is switched from the same two
   * surfaces and is per-profile for the same reason: reading an 1826 amtskart
   * with nothing under it is a Curiosities decision, not a global one.
   */
  basemapOn: boolean;
  setBasemapOn: (on: boolean) => void;
  opacityFor: (id: string) => number;
  /**
   * The layer's resolved variant (see `LayerMeta.options`) — always complete,
   * so callers never have to know a layer's defaults.
   */
  optionsFor: (meta: LayerMeta) => Record<string, string>;
  setOption: (meta: LayerMeta, key: string, value: string) => void;
  setOn: (id: string, on: boolean) => void;
  /** Persist a profile preset choice and clear any stale quick-switch deviation. */
  setProfileOn: (profileId: string, id: string, on: boolean) => void;
  toggle: (id: string) => void;
  setOpacity: (id: string, opacity: number) => void;
}

interface SettingsAccess {
  status: string;
  getSetting: (key: string) => Promise<string | null>;
  setSetting: (key: string, value: string) => Promise<boolean> | void;
}

/**
 * Fetches the overlay catalog (GET /api/layers) once and pairs it with the
 * persisted per-device panel state. Toggles keep working in-session even when
 * persistent storage is unavailable — they just don't survive a reload.
 */
export function useLayerCatalog(
  userData: SettingsAccess,
  profileId: string,
  preferredLayers: readonly string[] = [],
  customizedLayers = false,
): LayerCatalog {
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
    // The definition owns what a usable stored value is (`OVERLAY_STATE_SETTING`
    // in @atlas/core), so a corrupt or half-written row degrades to "nothing
    // chosen yet" and a single bad entry costs only itself.
    void getSetting(OVERLAY_STATE_SETTING.key).then((raw) => {
      setState(readSetting(OVERLAY_STATE_SETTING, raw));
    });
  }, [status, getSetting]);

  const update = useCallback(
    (mutate: (cur: OverlayStateMap) => OverlayStateMap) => {
      setState((cur) => {
        const next = mutate(cur);
        void setSetting(OVERLAY_STATE_SETTING.key, OVERLAY_STATE_SETTING.encode(next));
        return next;
      });
    },
    [setSetting],
  );

  const stateKey = useCallback((forProfile: string, id: string) => `${forProfile}:${id}`, []);

  // Profile-specific quick choices win. Before a user customizes a profile,
  // legacy global choices remain valid; afterwards the synced preset becomes
  // the baseline on every device.
  const isOn = useCallback(
    (id: string) =>
      state[stateKey(profileId, id)]?.on ??
      (customizedLayers
        ? preferredLayers.includes(id)
        : (state[id]?.on ?? layerDefaultsOn(id, profileId))),
    [state, stateKey, profileId, customizedLayers, preferredLayers],
  );

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

  const toggle = useCallback((id: string) => setOn(id, !isOn(id)), [setOn, isOn]);

  // The basemap is not a catalog row, so it goes through `setOn`'s key shape
  // rather than `setOn` itself — `isOn` would resolve a missing entry against
  // the profile's `defaultLayers` and answer *off*, and the basemap's default is
  // on. `basemapVisible` owns that rule for both clients.
  const basemapOn = basemapVisible(state, profileId);
  const setBasemapOn = useCallback(
    (on: boolean) =>
      update((cur) => ({
        ...cur,
        [stateKey(profileId, BASEMAP_STATE_ID)]: {
          ...cur[stateKey(profileId, BASEMAP_STATE_ID)],
          on,
        },
      })),
    [update, stateKey, profileId],
  );

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

  // A variant is a property of the layer, not of the profile it is viewed in:
  // the species you hunt does not change because you switched to Hike, so this
  // is stored under the plain layer id rather than the profile-scoped key.
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

  // Contextual layers are hidden outside their profile, so they must stop
  // drawing too — an overlay on the map that the panel doesn't list is an
  // overlay the user can't switch off. The on-state survives in `state`, so
  // returning to the profile brings it back.
  const catalog = useMemo(() => layersForProfile(allLayers, profileId), [allLayers, profileId]);

  const overlays = useMemo(
    () =>
      catalog
        .filter((meta) => isOn(meta.id))
        .map((meta) => ({ meta, opacity: opacityFor(meta.id), options: optionsFor(meta) })),
    [catalog, isOn, opacityFor, optionsFor],
  );

  const derived = useMemo(() => {
    const active = overlays.find((overlay) => overlay.meta.derived);
    if (!active) return null;
    return {
      meta: active.meta,
      layer: active.meta.id,
      target: active.options?.['target'] ?? '',
    };
  }, [overlays]);

  return {
    profileId,
    allCatalog: allLayers,
    catalog,
    state,
    overlays,
    derived,
    isOn,
    basemapOn,
    setBasemapOn,
    opacityFor,
    optionsFor,
    setOption,
    setOn,
    setProfileOn,
    toggle,
    setOpacity,
  };
}
