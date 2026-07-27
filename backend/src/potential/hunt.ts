import {
  classMask,
  createGrid,
  createMask,
  describeHuntSignal,
  fillRings,
  huntQuality,
  huntSurface,
  HUNT_SEASON_REFERENCE,
  quarry as findQuarry,
  QUARRIES,
  treeLineElevationM,
  weightsCaption,
  WILDLIFE_ACT_REFERENCE,
  AR5_DEVELOPED,
  AR5_FOREST,
  type Grid,
  type HuntInputs,
  type HuntSignalKey,
  type Mask,
  type Quarry,
} from '@atlas/potential';
import { burnPaths, projectToRaster, type CellRaster } from './cells.js';
import {
  inputFailed,
  STREAM_REAL_CHANNEL,
  type CellInputs,
  type HarvestPrior,
  type ProtectedArea,
  type WildlifeArea,
} from './inputs.js';
import type { DeriveModel, ModelResult } from './models.js';

/**
 * The adapter between NIBIO's, Kartverket's, Miljødirektoratet's and SSB's data
 * and `@atlas/potential`'s hunt model (ROADMAP § N5 → E5).
 *
 * Everything geographic and everything administrative happens here — projecting
 * polygons onto the cell raster, painting water and disturbance, deciding which
 * surveyed areas belong to which quarry, and turning a cell centre into a
 * kommune's harvest figures. The engine sees only grids, a tree-line elevation
 * and a row of weights.
 *
 * **The hunt surface says more in words than either fishing surface does**, and
 * that is deliberate: hunting ground carries legal weight that terrain does not.
 * Three of the notes below exist for that reason alone — the protected-area
 * advisory, the seasons link, and the standing reminder that the map is never
 * permission. None of them is a signal; all of them are things a heatmap must
 * not be read without.
 */

/** Every quarry is a target — the model is one arithmetic, eight weightings. */
const HUNT_TARGETS = QUARRIES;

function project(raster: CellRaster, [lng, lat]: readonly [number, number]): [number, number] {
  const [x, y] = projectToRaster(raster, lng, lat);
  return [x, y];
}

/** Fill one feature's rings into `into`, projected onto the cell raster. */
function fillFeature(
  raster: CellRaster,
  rings: readonly (readonly (readonly [number, number])[])[],
  into: Mask,
): void {
  fillRings(
    into,
    rings.map((ring) => ring.map((c) => project(raster, c))),
  );
}

/**
 * How much a surveyed area is worth, 0..1 — `verdi` graded by what the area is
 * *for*.
 *
 * Naturbase's own value scale carries most of it (A svært viktig … D ikke
 * verdisatt), but the function matters too: a capercaillie lek or a calving
 * ground is a place animals return to, where a `trekkvei` is a line they cross.
 */
const AREA_VALUE: Readonly<Record<string, number>> = { A: 1, B: 0.85, C: 0.7, D: 0.6 };
const AREA_FUNCTION: Readonly<Record<number, number>> = {
  1: 0.95, // beiteområde
  2: 0.7, // trekkvei
  3: 1, // hiområde
  4: 0.8, // myte/hårfelling
  5: 0.8, // overnatting
  6: 0.75, // rasteområde
  7: 1, // spill/parringsområde — the storfugl lek
  8: 1, // yngleområde
  9: 0.85, // leveområde
};

/**
 * A surveyed area's contribution, kept **above the middle of the range on
 * purpose**.
 *
 * This term is evidence *for* ground, never against it: a polygon somebody
 * walked and graded C must not score lower than the unsurveyed forest beside
 * it, or being surveyed becomes a penalty — which is exactly the presence-only
 * rule the whole input is governed by. So the grade moves the bonus between 0.6
 * and 1.0 rather than across the full scale.
 */
export function wildlifeAreaValue(area: WildlifeArea): number {
  const value = AREA_VALUE[(area.value ?? '').toUpperCase()] ?? 0.7;
  const purpose = area.functionCode === null ? 0.8 : (AREA_FUNCTION[area.functionCode] ?? 0.8);
  return 0.6 + 0.4 * value * purpose;
}

/** Surveyed areas for this quarry, painted; nodata everywhere unsurveyed. */
function paintWildlife(
  raster: CellRaster,
  areas: readonly WildlifeArea[],
  quarry: Quarry,
): { grid: Grid | null; areas: WildlifeArea[] } {
  // `norskNavn` carries the plain Norwegian species name — `Elg`, `Storfugl`,
  // `Lirype` — which is the same string the quarry table already holds, so the
  // join needs no mapping table that could rot.
  const mine = areas.filter(
    (a) => (a.species ?? '').toLowerCase() === quarry.nameNo.toLowerCase() && a.rings.length > 0,
  );
  if (mine.length === 0) return { grid: null, areas: [] };

  const grid = createGrid(raster.size, raster.size, raster.cellSizeM);
  const scratch = createMask(raster.size, raster.size, raster.cellSizeM);
  for (const area of mine) {
    scratch.data.fill(0);
    fillFeature(raster, area.rings, scratch);
    const value = wildlifeAreaValue(area);
    for (let i = 0; i < scratch.data.length; i++) {
      // Overlapping surveys keep the stronger grade rather than averaging: two
      // surveys of the same ground are two pieces of evidence, not a dilution.
      if (scratch.data[i] === 1 && !(grid.data[i]! >= value)) grid.data[i] = value;
    }
  }
  return { grid, areas: mine };
}

/** Lakes and real channels — not huntable, and the water signal's source. */
function paintWater(raster: CellRaster, inputs: CellInputs): Mask {
  const water = createMask(raster.size, raster.size, raster.cellSizeM);
  for (const lake of inputs.lakes) fillFeature(raster, lake.rings, water);
  for (const stream of inputs.streams) {
    if (stream.ltema !== STREAM_REAL_CHANNEL) continue;
    burnPaths(raster, stream.paths, water);
  }
  return water;
}

/**
 * Roads and dwellings, read off AR5's own `Bebygd` and `Samferdsel` classes.
 *
 * Not from OSM, which would be the obvious source: the derive service has no
 * vector-tile reader and adding one for a single term would buy a dependency
 * chain to answer a question AR5 already answers nationally, in a raster we
 * fetch anyway, as the actual mapped *footprint* of the road rather than a
 * centreline.
 *
 * The known cost is thin features: a forest track narrower than the 9.6 m cell
 * loses the majority vote and drops out. That matters less than it sounds —
 * disturbance is measured over hundreds of metres, so a road detected on half
 * its length produces the same field as one detected whole — and the tracks it
 * misses are the quiet ones a hunter walks in on, not the ones traffic runs on.
 */
function paintDisturbance(raster: CellRaster, landCover: Grid | null): Mask {
  if (!landCover) return createMask(raster.size, raster.size, raster.cellSizeM);
  return classMask(landCover, AR5_DEVELOPED);
}

/**
 * Hunt potential — the Fish & Hunt profile's dry-ground surface.
 *
 * The target is a quarry because the same hillside is read completely
 * differently for each: a roe deer's day is spent within 100 m of a field edge,
 * a capercaillie's within one old pine stand, a ptarmigan's in a band around
 * the tree line that no lowland cell contains at all. The engine branches on
 * none of them — a target selects a row of weights, two bands and a buffer.
 */
export const huntModel: DeriveModel = {
  layer: 'hunt',
  label: 'Hunt potential',
  targets: HUNT_TARGETS.map((q) => ({
    value: q.id,
    label: q.nameNo,
    caption: weightsCaption(q.nameEn, q.weights, 'terrain and cover'),
  })),
  rev: 1,
  catalog: true,
  inputs: {
    terrain: true,
    lakes: true,
    streams: true,
    landCover: true,
    treeHeight: true,
    treeSpecies: true,
    wildlifeAreas: true,
    protectedAreas: true,
    harvest: true,
  },
  vocabulary: 'hunt',
  describeSignal(key, value, target) {
    const quarry = findQuarry(target) ?? HUNT_TARGETS[0]!;
    return describeHuntSignal(key as HuntSignalKey, value, { quarry });
  },
  run(inputs: CellInputs, target: string): ModelResult {
    const { raster } = inputs;
    const quarry = findQuarry(target) ?? HUNT_TARGETS[0]!;

    // AR5 decides three separate things here — which ground is huntable at all,
    // where the edges are, and where the forest stops — so a *failed* fetch
    // cannot be treated like AR5's ordinary silence above the tree line. Failing
    // the cell sends it down the path the queue already has (`jobs.ts` → status
    // `failed`, re-asked by the client) instead of drawing a confident surface
    // over ground nothing was read from.
    if (inputFailed(inputs, 'landCover')) {
      const reason = inputs.records.find((r) => r.id === 'landCover')?.detail ?? 'no answer';
      throw new Error(`cannot read the land cover this surface rests on (${reason})`);
    }

    const water = paintWater(raster, inputs);
    const { grid: artfunksjon, areas } = paintWildlife(raster, inputs.wildlifeAreas, quarry);
    const treeLine =
      inputs.landCover && inputs.terrain
        ? treeLineElevationM(classMask(inputs.landCover, AR5_FOREST), inputs.terrain)
        : null;

    const modelInputs: HuntInputs = {
      landCover: inputs.landCover,
      terrain: inputs.terrain,
      treeHeightM: inputs.treeHeight,
      treeSpecies: inputs.treeSpecies,
      water,
      disturbance: paintDisturbance(raster, inputs.landCover),
      artfunksjon,
      treeLineM: treeLine?.elevationM ?? null,
    };
    const surface = huntSurface(modelInputs, { quarry });

    const felt = inputs.harvest?.felt[quarry.id] ?? null;
    return {
      score: surface.score,
      absolute: huntQuality({ harvest: felt, strongHarvest: quarry.strongHarvest }),
      notes: [
        ...surface.notes,
        ...describeCell(inputs, quarry, {
          treeLineReason: treeLine?.reason ?? null,
          areas,
          harvest: inputs.harvest,
        }),
      ],
      terms: surface.terms,
    };
  },
};

/**
 * Plain-language notes for the manifest — what was read, what it is not, and
 * the two legal facts a hunting heatmap must never be read without.
 */
function describeCell(
  inputs: CellInputs,
  quarry: Quarry,
  ctx: {
    treeLineReason: string | null;
    areas: readonly WildlifeArea[];
    harvest: HarvestPrior | null;
  },
): string[] {
  const notes: string[] = [];

  if (ctx.treeLineReason) notes.push(ctx.treeLineReason);

  if (ctx.areas.length > 0) {
    const leks = ctx.areas.filter((a) => a.functionCode === 7).length;
    notes.push(
      `${ctx.areas.length} surveyed ${quarry.nameNo.toLowerCase()} area${ctx.areas.length === 1 ? '' : 's'} here` +
        (leks > 0 ? `, including ${leks} spillplass${leks === 1 ? '' : 'er'}` : '') +
        ' (Naturbase). Surveys are presence-only: unmapped ground has not been looked at.',
    );
  } else if (inputFailed(inputs, 'wildlifeAreas')) {
    // The distinction the river model paid for: an upstream that did not answer
    // must never be reported as ground nobody surveyed.
    notes.push('The surveyed-areas layer did not answer, so none could be counted here.');
  }

  // Protection is advisory and never a signal, but silence about it is not an
  // option either — and "no protected areas here" is a claim only a *successful*
  // fetch may make.
  if (inputFailed(inputs, 'protectedAreas')) {
    notes.push('Protected areas could not be checked for this area — check Naturbase yourself.');
  } else if (inputs.protectedAreas.length > 0) {
    notes.push(describeProtection(inputs.protectedAreas));
  }

  const felt = ctx.harvest?.felt[quarry.id] ?? null;
  if (ctx.harvest?.kommuneName && felt !== null) {
    notes.push(
      `${ctx.harvest.kommuneName} felled ${felt} ${quarry.nameNo.toLowerCase()} in ${ctx.harvest.season} (SSB). ` +
        'A kommune-wide count, so it sets how good the ground is *at all*, never where in it.',
    );
  }

  // Seasons are a link and a date, never a restated pair: the jakttidsforskrift
  // varies by kommune, can be amended, and expires in 2028. See species.ts.
  notes.push(
    `${HUNT_SEASON_REFERENCE.guidance}${ctx.harvest?.kommuneName ? ` (${ctx.harvest.kommuneName})` : ''} — ` +
      `${HUNT_SEASON_REFERENCE.url} (checked ${HUNT_SEASON_REFERENCE.asOf}).`,
  );
  notes.push(
    `The map is never permission: hunting in Norway needs the landowner's, everywhere. ${WILDLIFE_ACT_REFERENCE.name} ` +
      `(${WILDLIFE_ACT_REFERENCE.lawId}) governs the rest — ${WILDLIFE_ACT_REFERENCE.url}.`,
  );
  return notes;
}

/** Name the protected areas and link the forskrift that actually governs each. */
function describeProtection(areas: readonly ProtectedArea[]): string {
  const named = areas.slice(0, 3).map((a) => {
    const kind = a.kind ? ` (${a.kind.toLowerCase()})` : '';
    return `${a.name ?? 'unnamed area'}${kind}${a.regulationUrl ? ` — ${a.regulationUrl}` : ''}`;
  });
  const more = areas.length > named.length ? ` and ${areas.length - named.length} more` : '';
  return (
    `Protected area${areas.length === 1 ? '' : 's'} here: ${named.join('; ')}${more}. ` +
    'What each verneforskrift allows is not derivable from the map — read it before hunting.'
  );
}
