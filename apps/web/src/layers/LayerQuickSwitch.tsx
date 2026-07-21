import { useEffect, useRef, useState } from 'react';
import { LayersIcon } from '../icons.js';
import type { LayerCatalog } from './useLayerCatalog.js';

interface LayerQuickSwitchProps {
  layers: LayerCatalog;
  /** Current map zoom — flags layers that won't draw yet at this zoom. */
  mapZoom: number;
}

/**
 * Map-corner overlay switcher: one tap to turn a layer on or off without
 * opening the Collections sidebar. Deliberately a *switcher*, not a second panel —
 * opacity, descriptions and source links stay in LayersPanel, which this
 * points at. Shares the same catalog state, so the two never disagree.
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

  if (layers.catalog.length === 0) return null;

  const activeCount = layers.overlays.length;

  return (
    <div className="layer-switch" ref={rootRef}>
      {open && (
        <div className="layer-switch-menu" role="group" aria-label="Map layers">
          {layers.catalog.map((meta) => {
            const on = layers.isOn(meta.id);
            // "Blank ≠ broken": say so before the user turns it on and sees nothing.
            const tooLowZoom = meta.minzoom !== undefined && mapZoom < meta.minzoom;
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
                <span className="layer-switch-label">{meta.title}</span>
                {on && tooLowZoom && (
                  <span className="layer-switch-hint" title={`Zoom in to z${meta.minzoom}+`}>
                    z{meta.minzoom}+
                  </span>
                )}
              </button>
            );
          })}
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
