// @vitest-environment jsdom
import type { LayerMeta } from '@atlas/core';
import { act, renderHook } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';

import { usePotentialTarget, type PotentialLayerAccess } from './usePotentialTarget.js';

function derivedLayer(
  id: string,
  title: string,
  vocabulary: 'fishing' | 'hunt',
  targets: string[],
): LayerMeta {
  return {
    id,
    title,
    derived: { vocabulary, legend: [] },
    options: [
      {
        key: 'target',
        label: 'Target',
        defaultValue: targets[0]!,
        choices: targets.map((value) => ({
          value,
          label: value.toUpperCase(),
          caption: `weights for ${value}`,
        })),
      },
    ],
  } as LayerMeta;
}

const LAKE = derivedLayer('lake-fishing', 'Lake fishing potential', 'fishing', ['orret', 'roye']);
const HUNT = derivedLayer('hunt', 'Hunt potential', 'hunt', ['radyr', 'elg']);
/** A plain WMS row: no `derived`, so the switch must ignore it entirely. */
const DEPTH = { id: 'lake-depth', title: 'Lake depth' } as LayerMeta;

/**
 * A stand-in for the clients' layer controllers, with the same shape of state:
 * an explicit on/off map over a per-profile default, and options per layer id.
 */
function useFakeLayers(
  catalog: LayerMeta[],
  defaults: Record<string, boolean> = {},
): PotentialLayerAccess {
  const [on, setOnState] = useState<Record<string, boolean>>({});
  const [options, setOptions] = useState<Record<string, Record<string, string>>>({});
  return {
    catalog,
    isOn: (id) => on[id] ?? defaults[id] ?? false,
    setOn: (id, value) => setOnState((cur) => ({ ...cur, [id]: value })),
    optionsFor: (meta) => ({
      target: meta.options?.[0]?.defaultValue ?? '',
      ...options[meta.id],
    }),
    setOption: (meta, key, value) =>
      setOptions((cur) => ({ ...cur, [meta.id]: { ...cur[meta.id], [key]: value } })),
  };
}

function renderSwitch(catalog: LayerMeta[], defaults: Record<string, boolean> = {}) {
  return renderHook(() => usePotentialTarget(useFakeLayers(catalog, defaults)));
}

describe('usePotentialTarget', () => {
  it('groups every derived surface by its own targets', () => {
    const { result } = renderSwitch([DEPTH, LAKE, HUNT]);
    expect(result.current.groups.map((g) => [g.layer, g.vocabulary])).toEqual([
      ['lake-fishing', 'fishing'],
      ['hunt', 'hunt'],
    ]);
    expect(result.current.groups[1]!.choices.map((c) => c.label)).toEqual(['RADYR', 'ELG']);
    expect(result.current.groups[1]!.choices[0]!.caption).toBe('weights for radyr');
  });

  it('is empty where there is nothing derived to switch between', () => {
    // Outside Fish & Hunt the catalog carries no derived rows at all, which is
    // what a client hides the control on — no profile id is tested anywhere.
    expect(renderSwitch([DEPTH]).result.current.groups).toEqual([]);
  });

  it('reports nothing active until a surface is on', () => {
    expect(renderSwitch([LAKE, HUNT]).result.current.active).toBeNull();
  });

  it('names the animal being drawn, layer and label together', () => {
    const { result } = renderSwitch([LAKE, HUNT], { hunt: true });
    expect(result.current.active).toMatchObject({
      layer: 'hunt',
      layerTitle: 'Hunt potential',
      value: 'radyr',
      label: 'RADYR',
    });
  });

  it('switches surface and target in one pick', () => {
    const { result } = renderSwitch([LAKE, HUNT]);
    act(() => result.current.select('hunt', 'elg'));
    expect(result.current.active).toMatchObject({ layer: 'hunt', value: 'elg' });
    expect(result.current.groups[1]!.choices[1]!.active).toBe(true);
  });

  it('leaves exactly one derived surface on', () => {
    // Two ramps over the same ground render a colour nobody can read.
    const { result } = renderSwitch([LAKE, HUNT], { 'lake-fishing': true });
    act(() => result.current.select('hunt', 'elg'));
    expect(result.current.active?.layer).toBe('hunt');
    expect(result.current.groups[0]!.choices.every((c) => !c.active)).toBe(true);
  });

  it('overrides a surface that is on only by the profile default', () => {
    // `isOn` resolves to true with nothing stored, so switching the other one on
    // has to write an explicit false rather than skip the untouched layer.
    const { result } = renderSwitch([LAKE, HUNT], { 'lake-fishing': true });
    act(() => result.current.select('hunt', 'radyr'));
    expect(result.current.groups[0]!.choices.some((c) => c.active)).toBe(false);
  });

  it('remembers each surface’s target across a switch away and back', () => {
    // The animal is a property of the surface, not of the session: coming back
    // to the lake must not silently re-tune it to the default species.
    const { result } = renderSwitch([LAKE, HUNT]);
    act(() => result.current.select('lake-fishing', 'roye'));
    act(() => result.current.select('hunt', 'elg'));
    act(() => result.current.select('lake-fishing', 'roye'));
    expect(result.current.active).toMatchObject({ layer: 'lake-fishing', value: 'roye' });
  });

  it('clears back to no derived surface', () => {
    const { result } = renderSwitch([LAKE, HUNT], { hunt: true });
    act(() => result.current.clear());
    expect(result.current.active).toBeNull();
  });

  it('ignores a pick for a layer it does not have', () => {
    const { result } = renderSwitch([LAKE]);
    act(() => result.current.select('hunt', 'elg'));
    expect(result.current.active).toBeNull();
  });
});
