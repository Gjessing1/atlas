import type { LayerMeta } from '@atlas/core';
import { BAND_LABELS, CELL_MAX_TILE_ZOOM, CELL_ZOOM, SURFACE_BANDS } from '@atlas/potential';
import { DERIVE_MODELS, type DeriveModel } from './models.js';

/**
 * Derived surfaces as ordinary catalog rows (ROADMAP § N5 → E3b).
 *
 * The engine's output is not a new kind of thing to the user: it is a layer you
 * switch on, fade, and tap. So it enters through the same `/api/layers` catalog
 * as every WMS overlay and is rendered by the panels both clients already have —
 * the only genuinely new part is the **target**, and that rides on the layer
 * options mechanism which shipped in v0.104.0 for the wildlife layer.
 *
 * Two fields make it work without a second rendering path:
 *
 * - `derived` tells the client to build its tile URL from the derive service
 *   rather than the overlay proxy, and carries the ramp's words and colours as
 *   *data*. The legend belongs to the model, not to two hand-written client
 *   copies that can disagree about what "Promising water" is coloured.
 * - `profiles: ['potential']` is a tag no *shipped* client's Fish & Hunt profile
 *   carries. That is deliberate, and the same trick the vector layers use: a
 *   device still on an older bundle never lists a row it cannot draw, instead of
 *   requesting `/api/overlay/lake-fishing/…` and rendering a permanently blank
 *   layer. The tag is added to the profile in this same release.
 */

/** The profile tag that surfaces derived rows; see the note above. */
export const POTENTIAL_PROFILE_TAG = 'potential';

/** Panel group heading for the derived surfaces. */
export const POTENTIAL_GROUP = 'Potential (derived)';

/**
 * What every derived layer says about its own blank areas.
 *
 * "Blank ≠ broken" is doing more work here than on any WMS row: a derived
 * surface is genuinely absent until the cell under the viewport has been built,
 * and it is *permanently* absent on ground the model does not read at all (dry
 * land, for the lake model). A user who reads blank as "no fish here" has been
 * misled by us, not by NVE.
 */
const COVERAGE_NOTE =
  'Built per ~10 km area while you look at it, so a fresh area fills in rather than appearing at ' +
  'once. Ground the model does not read stays empty — that is not a verdict on it.';

/** `rgba()` for the panel's legend swatches. */
function swatch(color: readonly [number, number, number, number]): string {
  const [r, g, b, a] = color;
  return `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(2)})`;
}

/**
 * One derived model as a catalog row.
 *
 * The description states the two things a user must know before believing a
 * heatmap of an opinion: what it is built from, and that the colours are ranks
 * *within the area on screen* rather than a national score.
 */
export function derivedLayerMeta(model: DeriveModel): LayerMeta {
  return {
    id: model.layer,
    rev: model.rev,
    title: model.label,
    description:
      'Where to look, derived from Norwegian government data. Colours rank the water in view ' +
      'against itself — never an absolute score. Tap the map for the reasoning.',
    group: POTENTIAL_GROUP,
    attribution: 'Derived by Atlas from © Kartverket, NVE and NIBIO data',
    // A cell *is* a z11 tile, so below that there is nothing to draw and
    // nothing to prepare; above z13 the client overzooms the cell's own pixels.
    minzoom: CELL_ZOOM,
    maxzoom: CELL_MAX_TILE_ZOOM,
    // Deliberately not opaque: the surface is an opinion laid over the water,
    // and the shoreline underneath it is the evidence.
    defaultOpacity: 0.7,
    // The overlay proxy's identify route knows nothing about derived layers;
    // a tap is answered by the explain endpoint, which returns reasoning rather
    // than upstream attributes.
    identify: false,
    coverageNote: COVERAGE_NOTE,
    profiles: [POTENTIAL_PROFILE_TAG],
    derived: {
      vocabulary: model.vocabulary,
      legend: SURFACE_BANDS.map((band) => ({
        key: band.key,
        label: BAND_LABELS[model.vocabulary][band.key],
        color: swatch(band.color),
      })),
    },
    options: [
      {
        key: 'target',
        label: 'Tuned for',
        defaultValue: model.targets[0]!.value,
        choices: model.targets.map((target) => ({
          value: target.value,
          label: target.label,
          ...(target.caption ? { caption: target.caption } : {}),
        })),
      },
    ],
  };
}

/**
 * Every derived layer this build offers. The diagnostic `inputs` model is
 * excluded by its own declaration (`catalog: false`): no user is offered a
 * heatmap of an opinion nobody has formed yet.
 */
export function derivedLayerMetas(models: readonly DeriveModel[] = DERIVE_MODELS): LayerMeta[] {
  return models.filter((model) => model.catalog).map(derivedLayerMeta);
}
