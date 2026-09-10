/**
 * **What the user has switched on** — the overlay preferences and the active
 * catalog entries they resolve to, shared by both clients.
 *
 * `apps/web/src/layers/useLayerCatalog.ts` and
 * `apps/android/src/layers/useOverlays.ts` used to implement all of this twice:
 * the same persisted state shape, the same `<profile>:<layer>` keys, the same
 * default resolution, opacity fallback chain, option normalization, basemap
 * special case, active-derived-surface rule and mutation API — down to the
 * comments, which called each other "twins". That is not a similarity to be
 * abstracted away on sight; it is a rule set that has stopped changing shape,
 * and drift in it is worse than drift in presentation, because the two devices
 * would then disagree about *which layer is on* rather than about how it looks
 * (DR4).
 *
 * What stays in each app is what genuinely differs: how the catalog is loaded
 * and cached (Android keeps a last-seen copy so the sheet works offline; a
 * browser refetches), which layers a client can actually draw (Android hides
 * vector layers whose renderer has not landed), and everything about MapLibre —
 * tile URLs, source identity, layer creation. This hook takes the catalog a
 * client is willing to offer and answers what the user wants drawn from it.
 */

import {
  BASEMAP_STATE_ID,
  basemapVisible,
  layerDefaultsOn,
  layersForProfile,
  normalizeLayerOptions,
  OVERLAY_STATE_SETTING,
  type LayerMeta,
  type OverlayStateMap,
} from '@atlas/core';
import { useCallback, useMemo } from 'react';

import { usePersistedSetting, type SettingsAccess } from './usePersistedSetting.js';

/**
 * One overlay the user has switched on, with everything the *decision* carries.
 * Each client widens it with what its renderer needs — the web adds a
 * generation marker for the derived surfaces, Android a tile URL and a MapLibre
 * source id — and neither of those is a preference.
 */
export interface OverlayEntry {
  meta: LayerMeta;
  opacity: number;
  /** The layer's resolved variant — always complete, defaults filled in. */
  options: Record<string, string>;
}

export interface OverlayPreferencesInput {
  /**
   * Every layer this client is willing to offer, in the server's display order
   * — already narrowed by whatever the platform cannot render. Loading and
   * caching it is the app's business; this hook only ever reads it.
   */
  catalog: readonly LayerMeta[];
  /** The active map profile. Visibility and opacity are per profile. */
  profileId: string;
  /** The profile's synced preset, from `useMapProfilePreferences`. */
  preferredLayers?: readonly string[];
  /** Whether that preset is an explicit user choice rather than Atlas defaults. */
  customizedLayers?: boolean;
}

export interface OverlayPreferences {
  /** The active map profile, so panels can show its standing caveat. */
  profileId: string;
  /** The catalog narrowed to the active profile, in the server's display order. */
  catalog: LayerMeta[];
  /** Per-layer visibility/opacity/variant exactly as persisted. */
  state: OverlayStateMap;
  /** The enabled overlays, in catalog order, ready for a renderer. */
  overlays: OverlayEntry[];
  /**
   * The derived potential surface currently switched on, with its chosen target
   * resolved — what the preparation pill prepares and what a map tap asks to
   * have explained.
   *
   * At most one: the surfaces are opinions about the same ground and stacking
   * two of them would render a colour nobody can read. If more than one is
   * somehow on, the first in catalog order wins, and the rest still draw — this
   * decides which one the *pill and the card* speak for, not what is visible.
   */
  derived: { meta: LayerMeta; layer: string; target: string } | null;
  /**
   * Whether a layer is currently on, resolving the device's stored choice
   * against the profile's preset and default (a hike-profile trail layer reads
   * as on before it has ever been touched). Panels and switchers must use this
   * rather than `state[id]?.on`, so what they draw matches what the map draws.
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
  /** The layer's resolved variant (see `LayerMeta.options`), defaults filled in. */
  optionsFor: (meta: LayerMeta) => Record<string, string>;
  setOption: (meta: LayerMeta, key: string, value: string) => void;
  setOn: (id: string, on: boolean) => void;
  /** Persist a profile preset choice and clear any stale quick-switch deviation. */
  setProfileOn: (profileId: string, id: string, on: boolean) => void;
  toggle: (id: string) => void;
  setOpacity: (id: string, opacity: number) => void;
}

/** Visibility and opacity are per profile; a layer's variant is not (see below). */
const stateKey = (profileId: string, id: string) => `${profileId}:${id}`;

/**
 * Resolve one layer's on/off state — the profile-specific choice first, then
 * the synced preset once the user has customized this profile, then the legacy
 * global choice, then the profile's own default.
 *
 * A pure function of the stored map rather than a closure, so a mutation that
 * has to *record* the resolved value (see `setOpacity`) reads it from the same
 * map it is about to write, instead of from whatever the last render captured.
 */
function resolveOn(
  state: OverlayStateMap,
  profileId: string,
  id: string,
  preferredLayers: readonly string[],
  customizedLayers: boolean,
): boolean {
  return (
    state[stateKey(profileId, id)]?.on ??
    (customizedLayers
      ? preferredLayers.includes(id)
      : (state[id]?.on ?? layerDefaultsOn(id, profileId)))
  );
}

/** The opacity fallback chain: this profile, the legacy global entry, the catalog. */
function resolveOpacity(
  state: OverlayStateMap,
  catalog: readonly LayerMeta[],
  profileId: string,
  id: string,
): number {
  return (
    state[stateKey(profileId, id)]?.opacity ??
    state[id]?.opacity ??
    catalog.find((meta) => meta.id === id)?.defaultOpacity ??
    1
  );
}

/**
 * The overlay panel's state, over one client's catalog.
 *
 * Toggles keep working in-session even when persistent storage is unavailable —
 * they just don't survive a reload, which is what the panels already promise.
 * That, the load-before-write latch and the corrupt-row handling all come from
 * {@link usePersistedSetting} and {@link OVERLAY_STATE_SETTING}; neither client
 * has its own copy of them any more.
 */
export function useOverlayPreferences(
  settings: SettingsAccess,
  input: OverlayPreferencesInput,
): OverlayPreferences {
  const { catalog: allLayers, profileId, preferredLayers = [], customizedLayers = false } = input;
  const { value: state, setValue } = usePersistedSetting(settings, OVERLAY_STATE_SETTING);

  const update = useCallback(
    (mutate: (current: OverlayStateMap) => OverlayStateMap) => {
      void setValue(mutate);
    },
    [setValue],
  );

  const isOn = useCallback(
    (id: string) => resolveOn(state, profileId, id, preferredLayers, customizedLayers),
    [state, profileId, preferredLayers, customizedLayers],
  );

  const setOn = useCallback(
    (id: string, on: boolean) =>
      update((current) => ({
        ...current,
        [stateKey(profileId, id)]: { ...current[stateKey(profileId, id)], on },
      })),
    [update, profileId],
  );

  const setProfileOn = useCallback(
    (forProfile: string, id: string, on: boolean) =>
      update((current) => ({
        ...current,
        [stateKey(forProfile, id)]: { ...current[stateKey(forProfile, id)], on },
      })),
    [update],
  );

  const toggle = useCallback((id: string) => setOn(id, !isOn(id)), [setOn, isOn]);

  // The basemap is not a catalog row, so it borrows `setOn`'s key shape but not
  // `isOn`: that resolves a missing entry against the profile's `defaultLayers`
  // and would answer *off*, while the basemap's default is on. `basemapVisible`
  // (core) owns that rule for both clients.
  const basemapOn = basemapVisible(state, profileId);
  const setBasemapOn = useCallback(
    (on: boolean) =>
      update((current) => ({
        ...current,
        [stateKey(profileId, BASEMAP_STATE_ID)]: {
          ...current[stateKey(profileId, BASEMAP_STATE_ID)],
          on,
        },
      })),
    [update, profileId],
  );

  const setOpacity = useCallback(
    (id: string, opacity: number) =>
      update((current) => ({
        ...current,
        [stateKey(profileId, id)]: {
          // Writing an opacity settles the layer's visibility too: the entry
          // that carries it is the profile-scoped one, and leaving `on` off it
          // would shadow a default or preset that said the layer is drawing.
          on:
            current[stateKey(profileId, id)]?.on ??
            resolveOn(current, profileId, id, preferredLayers, customizedLayers),
          opacity,
        },
      })),
    [update, profileId, preferredLayers, customizedLayers],
  );

  const opacityFor = useCallback(
    (id: string) => resolveOpacity(state, allLayers, profileId, id),
    [state, allLayers, profileId],
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
      update((current) => ({
        ...current,
        [meta.id]: {
          ...current[meta.id],
          options: normalizeLayerOptions(meta.options, {
            ...current[meta.id]?.options,
            [key]: value,
          }),
        },
      })),
    [update],
  );

  // A contextual layer must stop drawing outside its profile — an overlay on the
  // map that the panel doesn't list is an overlay the user can't switch off. Its
  // explicit state stays stored, so switching back restores the choice.
  const catalog = useMemo(() => layersForProfile(allLayers, profileId), [allLayers, profileId]);

  const overlays = useMemo(
    () =>
      catalog
        .filter((meta) => resolveOn(state, profileId, meta.id, preferredLayers, customizedLayers))
        .map((meta) => ({
          meta,
          opacity: resolveOpacity(state, allLayers, profileId, meta.id),
          options: normalizeLayerOptions(meta.options, state[meta.id]?.options),
        })),
    [catalog, allLayers, state, profileId, preferredLayers, customizedLayers],
  );

  const derived = useMemo(() => {
    const active = overlays.find((overlay) => overlay.meta.derived);
    if (!active) return null;
    return { meta: active.meta, layer: active.meta.id, target: active.options['target'] ?? '' };
  }, [overlays]);

  return {
    profileId,
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
