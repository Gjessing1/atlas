import { groupLayerCatalog, type LayerMeta } from '@atlas/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { LayersIcon } from '../icons.js';
import type { LayerCatalog } from './useLayerCatalog.js';

interface LayerQuickSwitchProps {
  layers: LayerCatalog;
  /** Current map zoom — flags layers that won't draw yet at this zoom. */
  mapZoom: number;
}

/** The chosen variant of a layer that has one ("Severe · Plants"). */
function variantLabel(layers: LayerCatalog, meta: LayerMeta): string | null {
  if (!meta.options?.length) return null;
  const chosen = layers.optionsFor(meta);
  const labels = meta.options
    .map((option) => option.choices.find((choice) => choice.value === chosen[option.key])?.label)
    .filter((label): label is string => Boolean(label));
  return labels.length > 0 ? labels.join(' · ') : null;
}

/**
 * Map-corner overlay switcher: one tap to turn a layer on or off without
 * opening the Collections sidebar. Deliberately a *switcher*, not a second panel —
 * opacity, descriptions, source links and the variant chips stay in LayersPanel,
 * which this points at. Shares the same catalog state, so the two never disagree.
 *
 * Grouped under the same headings as that panel (and in the same profile-first
 * order), because a flat list stops being scannable at the length Curiosities
 * reaches: eleven rows with no headings, opening on the general-purpose layers.
 * A layer that has variants shows the one it is set to rather than a chip row —
 * the switcher says what is on, the panel changes it, and the filter control
 * above changes it without leaving the map.
 *
 * The basemap sits at the foot of the list, below a rule: it is not one of the
 * overlays, it is the map they are drawn on, and switching it off is what makes
 * a scanned 1826 sheet or any raster with holes readable — today's coloured land
 * fills those holes and the eye takes it for part of the old survey.
 */
export function LayerQuickSwitch({ layers, mapZoom }: LayerQuickSwitchProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Dismiss like a menu: click anywhere else, or Escape.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const groups = useMemo(
    () => groupLayerCatalog(layers.catalog, layers.profileId),
    [layers.catalog, layers.profileId],
  );

  if (layers.catalog.length === 0) return null;

  const activeCount = layers.overlays.length;

  return (
    <div className="layer-switch" ref={rootRef}>
      {open && (
        <div className="layer-switch-menu" role="group" aria-label="Map layers">
          {groups.map((group) => (
            <div key={group.name} className="layer-switch-group">
              <div className="layer-switch-heading">{group.name}</div>
              {group.layers.map((meta) => {
                const on = layers.isOn(meta.id);
                // "Blank ≠ broken": say so before the user turns it on and sees nothing.
                const tooLowZoom = meta.minzoom !== undefined && mapZoom < meta.minzoom;
                const variant = on ? variantLabel(layers, meta) : null;
                return (
                  <button
                    key={meta.id}
                    type="button"
                    className={`layer-switch-item${on ? ' layer-switch-item-on' : ''}`}
                    aria-pressed={on}
                    onClick={() => layers.toggle(meta.id)}
                  >
                    <span className="layer-switch-check" aria-hidden="true">
                      {on ? '✓' : ''}
                    </span>
                    <span className="layer-switch-label">
                      {meta.title}
                      {variant && <span className="layer-switch-variant">{variant}</span>}
                    </span>
                    {on && tooLowZoom && (
                      <span className="layer-switch-hint" title={`Zoom in to z${meta.minzoom}+`}>
                        z{meta.minzoom}+
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
          <div className="layer-switch-group layer-switch-base">
            <button
              type="button"
              className={`layer-switch-item${layers.basemapOn ? ' layer-switch-item-on' : ''}`}
              aria-pressed={layers.basemapOn}
              onClick={() => layers.setBasemapOn(!layers.basemapOn)}
              title="Draw the ordinary map under the overlays"
            >
              <span className="layer-switch-check" aria-hidden="true">
                {layers.basemapOn ? '✓' : ''}
              </span>
              <span className="layer-switch-label">Base map</span>
            </button>
          </div>
        </div>
      )}
      <button
        type="button"
        className={`layer-switch-toggle${activeCount > 0 ? ' layer-switch-toggle-on' : ''}`}
        aria-expanded={open}
        aria-label={activeCount > 0 ? `Map layers (${activeCount} on)` : 'Map layers'}
        title="Map layers"
        onClick={() => setOpen((v) => !v)}
      >
        <LayersIcon size={18} />
        {activeCount > 0 && <span className="layer-switch-count">{activeCount}</span>}
      </button>
    </div>
  );
}
