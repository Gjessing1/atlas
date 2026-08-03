import { layersForProfile, normalizeLayerOptions, overlayTileUrl } from '@atlas/core';
import { describe, expect, it } from 'vitest';
import { derivedLayerMeta, derivedLayerMetas, POTENTIAL_PROFILE_TAG } from './catalog.js';
import { huntModel } from './hunt.js';
import { lakeModel } from './lake.js';
import { diagnosticModel, DERIVE_MODELS } from './models.js';

describe('derived layers in the catalog', () => {
  it('offers the models with an opinion and withholds the diagnostic one', () => {
    const ids = derivedLayerMetas().map((meta) => meta.id);
    expect(ids).toContain('lake-fishing');
    expect(ids).not.toContain(diagnosticModel.layer);
    // Guard against a future model shipping to users by forgetting the flag.
    expect(derivedLayerMetas(DERIVE_MODELS).length).toBe(
      DERIVE_MODELS.filter((m) => m.catalog).length,
    );
  });

  it('carries the target as a layer option, defaulting to the model’s first', () => {
    const meta = derivedLayerMeta(lakeModel);
    const option = meta.options?.find((o) => o.key === 'target');
    expect(option?.defaultValue).toBe(lakeModel.targets[0]!.value);
    expect(option?.choices.map((c) => c.value)).toEqual(lakeModel.targets.map((t) => t.value));
    // The chip teaches what it tunes; a bare species name teaches nothing.
    expect(option?.choices[0]?.caption).toMatch(/weigh heaviest/);
  });

  it('offers rut and general roe deer as adjacent, distinct targets', () => {
    const option = derivedLayerMeta(huntModel).options?.find(
      (candidate) => candidate.key === 'target',
    );
    expect(option?.choices.slice(0, 2)).toEqual([
      expect.objectContaining({ value: 'radyr', label: 'Rådyr ▸ brunst' }),
      expect.objectContaining({ value: 'radyr-generell', label: 'Rådyr ▸ generell' }),
    ]);
  });

  it('names the ramp in the model’s own vocabulary', () => {
    const legend = derivedLayerMeta(lakeModel).derived?.legend ?? [];
    expect(legend.map((band) => band.label)).toEqual([
      'Quiet',
      'Worth a cast',
      'Promising water',
      'Prime',
    ]);
    expect(legend.every((band) => band.color.startsWith('rgba('))).toBe(true);
  });

  it('is drawn from the derive service, not the overlay proxy', () => {
    const meta = derivedLayerMeta(lakeModel);
    const options = normalizeLayerOptions(meta.options, { target: 'gjedde' });
    expect(overlayTileUrl('', meta, options)).toBe(
      '/api/potential/lake-fishing/gjedde/{z}/{x}/{y}.png',
    );
    // A tap is answered by the explain endpoint, which returns reasoning —
    // the overlay identify route knows nothing about derived layers.
    expect(meta.identify).toBe(false);
  });

  /**
   * The guard that keeps a device on an older bundle from listing a row it
   * would request from `/api/overlay/…` and render permanently blank.
   */
  it('is offered in Fish & Hunt and nowhere else', () => {
    const catalog = derivedLayerMetas();
    expect(layersForProfile(catalog, 'fishhunt').map((m) => m.id)).toEqual(
      catalog.map((m) => m.id),
    );
    for (const profile of ['explore', 'drive', 'bike', 'hike', 'run', 'ski']) {
      expect(layersForProfile(catalog, profile)).toEqual([]);
    }
    expect(derivedLayerMeta(lakeModel).profiles).toEqual([POTENTIAL_PROFILE_TAG]);
  });

  it('draws only where cells exist, and says so rather than reading as empty', () => {
    const meta = derivedLayerMeta(lakeModel);
    expect(meta.minzoom).toBe(11);
    expect(meta.maxzoom).toBe(13);
    expect(meta.coverageNote).toBeTruthy();
  });
});
