import type { LayerMeta, LayerOption } from '@atlas/core';
import { useCallback, useMemo } from 'react';

/**
 * The Fish & Hunt sub-profile: **what are you after?**
 *
 * The derived potential surfaces (ROADMAP § N5) are one layer per model and one
 * *target* per animal — ørret hold where elg never go, and the target is what
 * selects the row of weights the model runs. Both facts have until now been
 * reachable only from the full layers panel: switch on "Hunt potential", scroll
 * to its option chips, pick "Elg". That is three steps to answer the single
 * question the profile exists for, and it hides the whole idea of the target
 * from anyone who never opens the panel.
 *
 * So this is the profile switch one level down — pick the quarry, and the
 * surface that models it comes on with it. It owns no state of its own: it
 * reads and writes the same per-device layer state the panel does, through the
 * narrow seam below, so the two can never disagree about what is drawn.
 *
 * Shared rather than written twice because it is the arithmetic of "which
 * surface is on and what is it tuned for", which is exactly the shape §7.6 says
 * belongs in `@atlas/app-hooks`; each client renders the result in its own
 * idiom.
 */

/** The option key every derived surface declares its animal under. */
export const POTENTIAL_TARGET_KEY = 'target';

/**
 * The slice of a client's layer controller this needs — web's `LayerCatalog`
 * and Android's `OverlaysController` both satisfy it structurally. Narrow on
 * purpose: a quarry switch has no business with opacity or profile presets.
 */
export interface PotentialLayerAccess {
  /** The catalog *for the active profile* — so outside Fish & Hunt this is empty. */
  readonly catalog: readonly LayerMeta[];
  isOn: (id: string) => boolean;
  setOn: (id: string, on: boolean) => void;
  optionsFor: (meta: LayerMeta) => Record<string, string>;
  setOption: (meta: LayerMeta, key: string, value: string) => void;
}

/** One animal a surface can be tuned for. */
export interface PotentialTargetChoice {
  /** The derived layer that models it, e.g. `hunt`. */
  readonly layer: string;
  /** That layer's title, e.g. `Hunt potential` — the group heading. */
  readonly layerTitle: string;
  /** The stored option value, e.g. `elg`. */
  readonly value: string;
  /** What the user reads, e.g. `Elg`. */
  readonly label: string;
  /** One line on what choosing it changes about the arithmetic. */
  readonly caption?: string;
  /** Whether this is the surface and target currently drawn. */
  readonly active: boolean;
}

/** One derived surface and everything it can be tuned for. */
export interface PotentialTargetGroup {
  readonly layer: string;
  readonly title: string;
  /** A fisher casts, a hunter looks — the surface's own vocabulary. */
  readonly vocabulary: 'fishing' | 'hunt';
  readonly choices: readonly PotentialTargetChoice[];
}

export interface PotentialTargetSwitch {
  /**
   * Every derived surface in the active profile's catalog, with its targets.
   * Empty outside Fish & Hunt — and on a server with no derive service — which
   * is what a client should hide the control on, rather than testing the
   * profile id itself.
   */
  readonly groups: readonly PotentialTargetGroup[];
  /** The animal currently drawn, or null when no derived surface is on. */
  readonly active: PotentialTargetChoice | null;
  /** Draw this surface tuned for this animal, and no other derived surface. */
  select: (layer: string, value: string) => void;
  /** Stop drawing the active surface, leaving the raw overlays alone. */
  clear: () => void;
}

function targetOption(meta: LayerMeta): LayerOption | undefined {
  return meta.options?.find((option) => option.key === POTENTIAL_TARGET_KEY);
}

export function usePotentialTarget(layers: PotentialLayerAccess): PotentialTargetSwitch {
  const { catalog, isOn, setOn, optionsFor, setOption } = layers;

  // A derived row with no target option would be a surface tuned for nothing,
  // which the engine treats as meaningless (D4); skipping it here keeps the
  // control honest instead of rendering an empty group.
  const surfaces = useMemo(
    () => catalog.filter((meta) => meta.derived !== undefined && targetOption(meta) !== undefined),
    [catalog],
  );

  // At most one, and in catalog order — the same rule and the same tie-break
  // the clients' `derived` already use, because this must name the surface the
  // preparation pill and the explain card are speaking for.
  const activeSurface = useMemo(
    () => surfaces.find((meta) => isOn(meta.id)) ?? null,
    [surfaces, isOn],
  );
  const activeValue = activeSurface ? optionsFor(activeSurface)[POTENTIAL_TARGET_KEY] : undefined;

  const groups = useMemo<readonly PotentialTargetGroup[]>(
    () =>
      surfaces.map((meta) => ({
        layer: meta.id,
        title: meta.title,
        vocabulary: meta.derived!.vocabulary,
        choices: targetOption(meta)!.choices.map((choice) => ({
          layer: meta.id,
          layerTitle: meta.title,
          value: choice.value,
          label: choice.label,
          ...(choice.caption === undefined ? {} : { caption: choice.caption }),
          active: meta.id === activeSurface?.id && choice.value === activeValue,
        })),
      })),
    [surfaces, activeSurface, activeValue],
  );

  const active = useMemo(
    () => groups.flatMap((group) => group.choices).find((choice) => choice.active) ?? null,
    [groups],
  );

  const select = useCallback(
    (layer: string, value: string) => {
      const meta = surfaces.find((surface) => surface.id === layer);
      if (!meta) return;
      setOption(meta, POTENTIAL_TARGET_KEY, value);
      // The surfaces are opinions about the same ground, so exactly one is on:
      // stacked, two ramps render a colour nobody can read. The others are
      // switched off *explicitly* rather than skipped when already off — one may
      // be on only by the profile's default, which needs overriding to stick.
      for (const other of surfaces) setOn(other.id, other.id === layer);
    },
    [surfaces, setOption, setOn],
  );

  const clear = useCallback(() => {
    if (activeSurface) setOn(activeSurface.id, false);
  }, [activeSurface, setOn]);

  return { groups, active, select, clear };
}
