import { normalizeLayerOptions, type LayerMeta, type LayerOption } from '@atlas/core';
import { act, renderHook } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';

import { useLayerFilters, type LayerFilterAccess } from './useLayerFilters.js';

function option(key: string, label: string, values: string[]): LayerOption {
  return {
    key,
    label,
    defaultValue: values[0]!,
    choices: values.map((value) => ({
      value,
      label: value.toUpperCase(),
      caption: `shows ${value}`,
    })),
  };
}

/** Wells & springs: one chip, four kinds. */
const WELLS = {
  id: 'groundwater-wells',
  title: 'Wells & springs',
  options: [option('kind', 'Show', ['all', 'springs', 'energy'])],
} as LayerMeta;
/** Alien species: two chips on one layer, which is what "grouped by layer" is for. */
const ALIEN = {
  id: 'alien-species',
  title: 'Alien species',
  options: [
    option('risk', 'Risk', ['severe', 'all']),
    option('group', 'Organism', ['all', 'plants']),
  ],
} as LayerMeta;
/** A plain row with no variants: never a filter. */
const HILLSHADE = { id: 'hillshade', title: 'Hillshade' } as LayerMeta;
/** A derived surface, whose `target` belongs to the quarry switch alone. */
const HUNT = {
  id: 'hunt',
  title: 'Hunt potential',
  derived: { vocabulary: 'hunt', legend: [] },
  options: [option('target', 'Target', ['radyr', 'elg'])],
} as LayerMeta;

/**
 * A stand-in for the clients' layer controllers, with the same shape of state:
 * an explicit on/off map over a per-profile default, and options per layer id
 * resolved through the same `normalizeLayerOptions` both of them use.
 */
function useFakeLayers(
  catalog: LayerMeta[],
  defaults: Record<string, boolean> = {},
): LayerFilterAccess {
  const [options, setOptions] = useState<Record<string, Record<string, string>>>({});
  return {
    catalog,
    isOn: (id) => defaults[id] ?? false,
    optionsFor: (meta) => normalizeLayerOptions(meta.options, options[meta.id]),
    setOption: (meta, key, value) =>
      setOptions((cur) => ({ ...cur, [meta.id]: { ...cur[meta.id], [key]: value } })),
  };
}

function renderFilters(catalog: LayerMeta[], defaults: Record<string, boolean> = {}) {
  return renderHook(() => useLayerFilters(useFakeLayers(catalog, defaults)));
}

describe('useLayerFilters', () => {
  it('offers the filters of the layers that are drawing, grouped by layer', () => {
    const { result } = renderFilters([HILLSHADE, WELLS, ALIEN], {
      hillshade: true,
      'groundwater-wells': true,
      'alien-species': true,
    });
    expect(result.current.groups.map((g) => g.layer)).toEqual([
      'groundwater-wells',
      'alien-species',
    ]);
    expect(result.current.groups[1]!.filters.map((f) => f.label)).toEqual(['Risk', 'Organism']);
    expect(result.current.count).toBe(3);
  });

  it('says nothing about a layer that is switched off', () => {
    // A filter for a layer that is not drawing is a setting, not a control —
    // the panel is where you configure a layer you are not looking at.
    const { result } = renderFilters([WELLS, ALIEN], { 'groundwater-wells': true });
    expect(result.current.groups.map((g) => g.layer)).toEqual(['groundwater-wells']);
  });

  it('is empty when nothing on the map is filterable, so the control can hide', () => {
    expect(renderFilters([HILLSHADE], { hillshade: true }).result.current.groups).toEqual([]);
    expect(renderFilters([WELLS, ALIEN]).result.current.groups).toEqual([]);
  });

  it('leaves a derived surface’s target to the quarry switch', () => {
    // Offering `target` here would be a second way to change it that does not
    // enforce "exactly one derived surface on", which usePotentialTarget owns.
    const { result } = renderFilters([HUNT, WELLS], { hunt: true, 'groundwater-wells': true });
    expect(result.current.groups.map((g) => g.layer)).toEqual(['groundwater-wells']);
    act(() => result.current.select('hunt', 'target', 'elg'));
    expect(result.current.groups.map((g) => g.layer)).toEqual(['groundwater-wells']);
  });

  it('reads out what the map is filtered to, in catalog order', () => {
    const { result } = renderFilters([WELLS, ALIEN], {
      'groundwater-wells': true,
      'alien-species': true,
    });
    expect(result.current.summary).toBe('ALL · SEVERE · ALL');
    act(() => result.current.select('groundwater-wells', 'kind', 'springs'));
    expect(result.current.summary).toBe('SPRINGS · SEVERE · ALL');
    expect(result.current.groups[0]!.filters[0]!.activeLabel).toBe('SPRINGS');
    expect(result.current.groups[0]!.filters[0]!.activeCaption).toBe('shows springs');
  });

  it('has no summary when there is nothing to say', () => {
    expect(renderFilters([HILLSHADE], { hillshade: true }).result.current.summary).toBeNull();
  });

  it('marks exactly the chosen value active, per filter', () => {
    const { result } = renderFilters([ALIEN], { 'alien-species': true });
    act(() => result.current.select('alien-species', 'group', 'plants'));
    const [risk, group] = result.current.groups[0]!.filters;
    expect(risk!.choices.filter((c) => c.active).map((c) => c.value)).toEqual(['severe']);
    expect(group!.choices.filter((c) => c.active).map((c) => c.value)).toEqual(['plants']);
  });

  it('ignores a pick for a layer or key it is not offering', () => {
    const { result } = renderFilters([WELLS], { 'groundwater-wells': true });
    act(() => result.current.select('alien-species', 'risk', 'all'));
    act(() => result.current.select('groundwater-wells', 'colour', 'red'));
    expect(result.current.summary).toBe('ALL');
  });
});
