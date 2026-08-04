import type { LayerMeta, LayerOption } from '@atlas/core';
import { useCallback, useMemo } from 'react';
import { POTENTIAL_TARGET_KEY } from './usePotentialTarget.js';

/**
 * **What is the map filtered to?** — the chips of the layers that are actually
 * drawing, one level up from the panel that owns them.
 *
 * `LayerMeta.options` are how a national register becomes readable: alien
 * species is a wall of dots until the risk chip cuts it down, GRANADA is a map
 * of suburban heat pumps until you ask for springs, and the ore register cannot
 * answer "where is the gold" at all until the metal chip does. But the chips
 * have only ever existed inside the full layers panel — three steps and a scroll
 * away from the map — so the one profile whose layers are *all* filtered
 * (Curiosities) hid its own most useful control.
 *
 * This is `usePotentialTarget`'s sibling, and deliberately its complement: that
 * one owns the single `target` option of the derived surfaces (a sub-profile,
 * one choice, exclusive), this one owns everything else. Only *switched-on*
 * layers appear — a filter for a layer that is not drawing is a setting, not a
 * control — and it holds no state of its own, reading and writing the same
 * per-device layer state the panel does, so the two can never disagree.
 *
 * Shared rather than written twice for §7.6's reason: the arithmetic of "which
 * filters exist right now and what are they set to" is identical on both
 * clients, and only the rendering differs.
 */

/** One value a filter can take. */
export interface LayerFilterChoice {
  readonly layer: string;
  readonly key: string;
  readonly value: string;
  readonly label: string;
  /** One line on what picking it changes — the chips' whole teaching surface. */
  readonly caption?: string;
  readonly active: boolean;
}

/** One filter (`LayerOption`) on one layer that is currently drawing. */
export interface LayerFilter {
  readonly layer: string;
  readonly layerTitle: string;
  readonly key: string;
  /** The option's own label: "Show", "Risk", "Metal". */
  readonly label: string;
  readonly choices: readonly LayerFilterChoice[];
  /** The chosen choice's label, so a trigger can say what is set without re-searching. */
  readonly activeLabel: string;
  /** The chosen choice's caption, for the line under the chips. */
  readonly activeCaption?: string;
}

/** The filters of one layer, kept together under its title. */
export interface LayerFilterGroup {
  readonly layer: string;
  readonly title: string;
  readonly filters: readonly LayerFilter[];
}

export interface LayerFilterSwitch {
  /**
   * Every filter of every switched-on layer, in catalog order. Empty when
   * nothing on the map is filterable — which is what a client should hide the
   * control on, rather than naming profiles here.
   */
  readonly groups: readonly LayerFilterGroup[];
  /** How many filters are on offer, for a badge. */
  readonly count: number;
  /**
   * What they are set to right now — "Everything · Severe · Gold" — or null when
   * there is nothing to say. The trigger's label, so the control says what the
   * map is filtered to without being opened.
   */
  readonly summary: string | null;
  select: (layer: string, key: string, value: string) => void;
}

/**
 * The slice of a client's layer controller this needs. Web's `LayerCatalog` and
 * Android's `OverlaysController` both satisfy it structurally, and it is
 * narrower than `PotentialLayerAccess` on purpose: changing a filter never
 * switches a layer on or off, so `setOn` has no business here.
 */
export interface LayerFilterAccess {
  /** The catalog *for the active profile* — the same list the panel renders. */
  readonly catalog: readonly LayerMeta[];
  isOn: (id: string) => boolean;
  optionsFor: (meta: LayerMeta) => Record<string, string>;
  setOption: (meta: LayerMeta, key: string, value: string) => void;
}

/**
 * The options this control offers for a layer: all of them, except a derived
 * surface's `target`.
 *
 * That one is the Fish & Hunt sub-profile and has its own control, which also
 * owns the rule that exactly one surface may be on — offering it here as an
 * ordinary chip row would be a second way to change it that does not enforce
 * that rule.
 */
function filterableOptions(meta: LayerMeta): LayerOption[] {
  return (meta.options ?? []).filter(
    (option) => !(meta.derived !== undefined && option.key === POTENTIAL_TARGET_KEY),
  );
}

export function useLayerFilters(layers: LayerFilterAccess): LayerFilterSwitch {
  const { catalog, isOn, optionsFor, setOption } = layers;

  const groups = useMemo<readonly LayerFilterGroup[]>(() => {
    const out: LayerFilterGroup[] = [];
    for (const meta of catalog) {
      if (!isOn(meta.id)) continue;
      const options = filterableOptions(meta);
      if (options.length === 0) continue;
      const chosen = optionsFor(meta);
      out.push({
        layer: meta.id,
        title: meta.title,
        filters: options.map((option) => {
          const active = option.choices.find((choice) => choice.value === chosen[option.key]);
          return {
            layer: meta.id,
            layerTitle: meta.title,
            key: option.key,
            label: option.label,
            choices: option.choices.map((choice) => ({
              layer: meta.id,
              key: option.key,
              value: choice.value,
              label: choice.label,
              ...(choice.caption === undefined ? {} : { caption: choice.caption }),
              active: choice.value === chosen[option.key],
            })),
            // `optionsFor` resolves against the layer's declared choices, so
            // there is always one — but a client bundle can be older than the
            // catalog it is reading, and an empty label beats a crash.
            activeLabel: active?.label ?? '',
            ...(active?.caption === undefined ? {} : { activeCaption: active.caption }),
          };
        }),
      });
    }
    return out;
  }, [catalog, isOn, optionsFor]);

  const filters = useMemo(() => groups.flatMap((group) => group.filters), [groups]);

  const summary = useMemo(() => {
    const labels = filters.map((filter) => filter.activeLabel).filter((label) => label.length > 0);
    return labels.length > 0 ? labels.join(' · ') : null;
  }, [filters]);

  const select = useCallback(
    (layer: string, key: string, value: string) => {
      const meta = catalog.find((entry) => entry.id === layer);
      // Only a filter this control is actually offering may be set through it:
      // otherwise a stale menu (a layer switched off in another surface while
      // this one was open) could write a `target` and break the one-surface rule
      // `usePotentialTarget` enforces.
      if (!meta || !filterableOptions(meta).some((option) => option.key === key)) return;
      setOption(meta, key, value);
    },
    [catalog, setOption],
  );

  return { groups, count: filters.length, summary, select };
}
