import {
  groupLayerCatalog,
  mapProfile,
  searchLayerGroups,
  type LayerMeta,
  type LayerOption,
} from '@atlas/core';
import { useState } from 'react';
import type { LayerCatalog } from './useLayerCatalog.js';

/**
 * A layer's variant picker (`LayerMeta.options`) — which species a wildlife
 * layer draws today, and the target a derived surface is tuned for next.
 *
 * The caption under the row is the point, not decoration: a surface or a
 * filtered layer is meaningless without knowing what it is tuned for, so the
 * picker is the one place that can teach it.
 */
function LayerOptionChips({
  layers,
  meta,
  option,
}: {
  layers: LayerCatalog;
  meta: LayerMeta;
  option: LayerOption;
}) {
  const selected = layers.optionsFor(meta)[option.key];
  const caption = option.choices.find((choice) => choice.value === selected)?.caption;
  return (
    <div className="layer-options">
      <div className="layer-options-row" role="group" aria-label={`${meta.title} ${option.label}`}>
        {option.choices.map((choice) => (
          <button
            key={choice.value}
            type="button"
            className={choice.value === selected ? 'layer-chip layer-chip-on' : 'layer-chip'}
            aria-pressed={choice.value === selected}
            onClick={() => layers.setOption(meta, option.key, choice.value)}
          >
            {choice.label}
          </button>
        ))}
      </div>
      {caption && <div className="layer-desc">{caption}</div>}
    </div>
  );
}

/**
 * The ramp a derived surface is drawn with, in the model's own words.
 *
 * A heatmap whose colours are unexplained is a decoration, and these ones carry
 * a specific claim: the bands are *percentiles of what is on screen*, so "Prime"
 * means the top 5 % of this water rather than the best water in Norway. The
 * words and the swatches arrive together from the catalog so the two clients
 * cannot drift apart on what a colour means.
 */
function DerivedLegend({ meta }: { meta: LayerMeta }) {
  const legend = meta.derived?.legend ?? [];
  if (legend.length === 0) return null;
  return (
    <div className="layer-legend" aria-label={`${meta.title} legend`}>
      {legend.map((band) => (
        <span key={band.key} className="layer-legend-band">
          <span className="layer-legend-swatch" style={{ background: band.color }} />
          {band.label}
        </span>
      ))}
    </div>
  );
}

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
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  if (layers.catalog.length === 0) return null;

  const groups = groupLayerCatalog(layers.catalog, layers.profileId);
  const searching = query.trim().length > 0;
  const visibleGroups = searchLayerGroups(groups, query);
  const activeLayers = layers.catalog.filter((meta) => layers.isOn(meta.id));
  const note = mapProfile(layers.profileId).note;

  const layerRow = (meta: LayerMeta, key: string) => {
    const on = layers.isOn(meta.id);
    const opacity = layers.opacityFor(meta.id);
    return (
      <div key={key} className="layer-row">
        <label className="layer-toggle">
          <span className="layer-name">{meta.title}</span>
          <input type="checkbox" checked={on} onChange={() => layers.toggle(meta.id)} />
          <span className="layer-toggle-control" aria-hidden="true" />
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
        {on &&
          meta.options?.map((option) => (
            <LayerOptionChips key={option.key} layers={layers} meta={meta} option={option} />
          ))}
        {on && <DerivedLegend meta={meta} />}
        {on && meta.minzoom !== undefined && mapZoom < meta.minzoom && (
          <div className="layer-hint">Zoom in to z{meta.minzoom}+ to see this layer.</div>
        )}
        {on && meta.coverageNote && <div className="layer-hint">{meta.coverageNote}</div>}
      </div>
    );
  };

  return (
    <section className="layers-section" aria-label="Map layers">
      <div className="layers-title-row">
        <div className="layers-title">Map layers</div>
        <button
          type="button"
          className="layer-search-toggle"
          aria-label="Search layers"
          aria-expanded={searchOpen}
          onClick={() => {
            setSearchOpen((value) => !value);
            if (searchOpen) setQuery('');
          }}
        >
          ⌕
        </button>
      </div>
      {searchOpen && (
        <input
          className="layer-search"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder="Search layers"
          aria-label="Search available layers"
          autoFocus
        />
      )}
      {note && <p className="layers-profile-note">{note}</p>}
      {/* The map the overlays are drawn on, above the overlays themselves.
          Switching it off is the honest way to read a raster with holes in it —
          a 1826 amtskart sheet, a bathymetry survey's edge — because today's
          coloured land fills those holes and reads as part of the old map. */}
      <div className="layer-row">
        <label className="layer-toggle">
          <span className="layer-name">Base map</span>
          <input
            type="checkbox"
            checked={layers.basemapOn}
            onChange={() => layers.setBasemapOn(!layers.basemapOn)}
          />
          <span className="layer-toggle-control" aria-hidden="true" />
        </label>
        <div className="layer-desc">
          Roads, land and place names under the overlays. Turn it off to read a historic map or any
          overlay with gaps on its own — this profile only.
        </div>
      </div>
      {activeLayers.length > 0 && !searching && (
        <div className="layers-active">
          <div className="layers-group">Active</div>
          {activeLayers.map((meta) => layerRow(meta, `active-${meta.id}`))}
        </div>
      )}
      {visibleGroups.map((group) => (
        <div key={group.name}>
          <div className="layers-group">{group.name}</div>
          {group.layers.map((meta) => layerRow(meta, meta.id))}
        </div>
      ))}
    </section>
  );
}
