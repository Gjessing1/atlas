import type { LayerFilterSwitch as FilterSwitch } from '@atlas/app-hooks';
import { useEffect, useRef, useState } from 'react';
import { FilterIcon } from '../icons.js';

/**
 * **What is the map filtered to?** — the chips of the switched-on layers,
 * sitting with the other map-corner controls instead of three steps into the
 * Collections sidebar.
 *
 * The Fish & Hunt quarry switch is the model, and Curiosities is the profile
 * that needed the same move: every register in it is only readable filtered.
 * Alien species is a wall of dots until the risk chip cuts it down, the ore
 * register cannot answer "where is the gold" without the metal chip, and the
 * groundwater register is half suburban heat pumps. Those chips existed — in the
 * panel, behind a scroll — so the control the profile is *about* was the one
 * nobody found.
 *
 * A menu of chip rows rather than a visible row: several layers can be filtered
 * at once (each of the two alien-species chips is its own question), and the map
 * is what the screen is for. The trigger carries the current answer, so the
 * control still says what is on without being opened.
 *
 * `useLayerFilters` owns which filters exist and what they are set to, so
 * Android renders the identical model, and neither client can disagree with the
 * panel about what the map is drawing.
 */
export function LayerFilterSwitch({ filters }: { filters: FilterSwitch }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Dismiss like a menu: click anywhere else, or Escape — the same contract as
  // the layer quick switch and the quarry switch it stacks with.
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

  // Nothing on the map is filterable: hidden rather than shown empty, and
  // decided by the catalog rather than by naming profiles here.
  if (filters.groups.length === 0) return null;

  return (
    <div className="layer-filters" ref={rootRef}>
      {open && (
        <div className="layer-filters-menu" role="group" aria-label="Layer filters">
          {filters.groups.map((group) => (
            <div key={group.layer} className="layer-filters-group">
              <div className="layer-filters-layer">{group.title}</div>
              {group.filters.map((filter) => (
                <div key={filter.key} className="layer-filters-option">
                  <div className="layer-filters-label">{filter.label}</div>
                  <div
                    className="layer-filters-chips"
                    role="group"
                    aria-label={`${group.title} ${filter.label}`}
                  >
                    {filter.choices.map((choice) => (
                      <button
                        key={choice.value}
                        type="button"
                        role="radio"
                        aria-checked={choice.active}
                        className={`layer-chip${choice.active ? ' layer-chip-on' : ''}`}
                        title={choice.caption ?? choice.label}
                        onClick={() => filters.select(choice.layer, choice.key, choice.value)}
                      >
                        {choice.label}
                      </button>
                    ))}
                  </div>
                  {/* The caption is the point, not decoration: a filtered
                      register means nothing until you know what was cut. */}
                  {filter.activeCaption && (
                    <div className="layer-filters-caption">{filter.activeCaption}</div>
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
      <button
        type="button"
        className={`layer-filters-toggle${open ? ' layer-filters-toggle-open' : ''}`}
        aria-expanded={open}
        aria-label={
          filters.summary ? `Layer filters: ${filters.summary}` : 'Filter the layers on the map'
        }
        title={filters.summary ?? 'Filter the layers on the map'}
        onClick={() => setOpen((v) => !v)}
      >
        <FilterIcon size={18} />
        <span className="layer-filters-toggle-label">{filters.summary ?? 'Filters'}</span>
      </button>
    </div>
  );
}
