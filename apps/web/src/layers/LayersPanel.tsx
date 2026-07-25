import { mapProfile, type LayerMeta } from '@atlas/core';
import type { LayerCatalog } from './useLayerCatalog.js';

interface LayersPanelProps {
  layers: LayerCatalog;
  /** Current map zoom (rounded is fine) — drives the live "zoom in" hints. */
  mapZoom: number;
}

/**
 * The map-layers section of the Sidebar: the curated overlay catalog grouped
 * by theme, with visibility, opacity, a source link and honest coverage/zoom
 * notes ("blank ≠ broken"). Groups are always expanded — a short curated list
 * beats collapsible trees.
 */
export function LayersPanel({ layers, mapZoom }: LayersPanelProps) {
  if (layers.catalog.length === 0) return null;

  const groups: [string, LayerMeta[]][] = [];
  for (const meta of layers.catalog) {
    const group = groups.find(([name]) => name === meta.group);
    if (group) group[1].push(meta);
    else groups.push([meta.group, [meta]]);
  }

  const note = mapProfile(layers.profileId).note;

  return (
    <section className="layers-section" aria-label="Map layers">
      <div className="layers-title">Map layers</div>
      {note && <p className="layers-profile-note">{note}</p>}
      {groups.map(([group, metas]) => (
        <div key={group}>
          <div className="layers-group">{group}</div>
          {metas.map((meta) => {
            const on = layers.isOn(meta.id);
            const opacity = layers.opacityFor(meta.id);
            return (
              <div key={meta.id} className="layer-row">
                <label className="layer-toggle">
                  <input type="checkbox" checked={on} onChange={() => layers.toggle(meta.id)} />
                  <span className="layer-name">{meta.title}</span>
                </label>
                {on && (
                  <input
                    type="range"
                    className="layer-opacity"
                    min={10}
                    max={100}
                    value={Math.round(opacity * 100)}
                    onChange={(e) => layers.setOpacity(meta.id, Number(e.target.value) / 100)}
                    aria-label={`${meta.title} opacity`}
                    title="Opacity"
                  />
                )}
                <div className="layer-desc">
                  {meta.description}{' '}
                  {meta.metadataUrl && (
                    <a href={meta.metadataUrl} target="_blank" rel="noreferrer">
                      source
                    </a>
                  )}
                </div>
                {on && meta.minzoom !== undefined && mapZoom < meta.minzoom && (
                  <div className="layer-hint">Zoom in to z{meta.minzoom}+ to see this layer.</div>
                )}
                {on && meta.coverageNote && <div className="layer-hint">{meta.coverageNote}</div>}
              </div>
            );
          })}
        </div>
      ))}
    </section>
  );
}
