/**
 * The hunt model (design in docs/FISH-HUNT-ENGINE.md § "Hunt potential").
 *
 * **Eight quarries, one set of terrain signals.** A roe deer's field edge, a
 * moose's browse, a capercaillie's mature pine and a ptarmigan's tree-line band
 * are all read from the same four rasters — AR5 land cover, SR16 stand height
 * and species, the DTM, and the surveyed functional areas — and the difference
 * between them is a row of weights in `species.ts`, never a code path here. That
 * is the same rule the lake and river models keep, and it is what lets someone
 * who hunts review this without reading TypeScript.
 *
 * Like its siblings this file is pure arithmetic over rasters the caller has
 * prepared: nothing here fetches, projects, or knows what a kommune is.
 *
 * Two things this model does that the fishing models do not, both forced by the
 * ground it reads:
 *
 * - **It scores dry land, which is most of the cell.** The lake model speaks
 *   about a shore band and the river model about a corridor; a hunt surface has
 *   no such natural mask, so the exclusions are explicit — water, buildings and
 *   road surfaces are not huntable ground and are left unscored rather than
 *   scored low.
 * - **Absence has three different meanings and they must not be flattened.**
 *   AR5 stops at the tree line, SR16 stops outside the forest model, and
 *   `artfunksjon` covers only ground somebody has surveyed. All three read as
 *   *unknown* — `combine()` renormalises past them — and only the third is ever
 *   a bonus: a surveyed calving area is evidence, an unsurveyed hillside is not
 *   evidence of nothing.
 */
import type { CombineTerm, Grid, Mask } from '../raster.js';
import {
  applyMask,
  aspectDegrees,
  combine,
  createGrid,
  createMask,
  focalMean,
  mapValues,
  maskFromGrid,
  slopePercent,
} from '../raster.js';
import type { Band } from '../signals.js';
import {
  avoidanceField,
  classMask,
  edgeProximity,
  membershipGrid,
  proximityField,
  southness,
  topographicPositionM,
} from '../signals.js';
import type { HuntSignalKey, Quarry } from '../species.js';
import { HUNT_SIGNALS } from '../species.js';

/** AR5 `artype` codes the model reads. Forest is the pivot of most signals. */
export const AR5_FOREST = [30];
export const AR5_FARMLAND = [21, 22, 23];
export const AR5_MYR = [60];
/** Built-up ground and road surface: not huntable, and the disturbance source. */
export const AR5_DEVELOPED = [11, 12];
/** AR5's own water classes — excluded from the surface like the lake polygons. */
export const AR5_WATER = [81, 82];

/** SR16 `SRRTRESLAG`: the only national source that separates pine from spruce. */
export const SR16_SPRUCE = 1;
export const SR16_PINE = 2;
export const SR16_DECIDUOUS = 3;

/**
 * Dense regrowth and thicket, as dominant stand height in metres.
 *
 * The band that hides a roe deer and feeds a moose: past ~14 m the canopy has
 * closed and lifted, and the ground under it is open and empty.
 */
export const YOUNG_COVER_M: Band = { min: 0.5, peakMin: 2, peakMax: 7, max: 14 };

/** Closed mature stand — bedding, shelter and the daytime half of a deer's day. */
export const MATURE_COVER_M: Band = { min: 8, peakMin: 15, peakMax: 45, max: 70 };

/**
 * Where a stand stops counting as young and starts counting as mature.
 *
 * The two cover terms are **exclusive** either side of this, exactly as pool and
 * riffle are on a river: a stand is one or the other, and a quarry that values
 * both (a moose browses regrowth and beds in timber) would otherwise have every
 * pixel scored by the term it fails as well as the one it passes — which caps
 * the whole surface below the hot end of the ramp. nodemap paid for this lesson
 * on drop-off versus shelf; it is the same arithmetic.
 */
export const STAND_SPLIT_M = 10;

/** Regrowth height a browser actually eats at — shoots within reach. */
export const BROWSE_HEIGHT_M: Band = { min: 0.3, peakMin: 1, peakMax: 6, max: 12 };

/** Topographic position, in metres above the surroundings, that reads as a ridge. */
export const RIDGE_TPI_M: Band = { min: 0, peakMin: 8, peakMax: 60, max: 200 };

/** How far a forest↔farmland edge pulls, and how fast it decays. */
const FARM_EDGE_HALF_M = 90;
const FARM_EDGE_MAX_M = 600;

/** The same for a bog fringe, which game works more tightly. */
const MYR_EDGE_HALF_M = 70;
const MYR_EDGE_MAX_M = 450;

/** Open water: a moose wallow, a drinking place, a ptarmigan's damp hollow. */
const WATER_HALF_M = 200;
const WATER_MAX_M = 1500;

/** Window the tree-species mix is read over — a stand, not a pixel. */
const SPECIES_RADIUS_M = 90;

/** Neighbourhood a ridge is measured against. */
const TPI_RADIUS_M = 300;

/**
 * What a missing tree-species reading is worth to the browse term.
 *
 * SR16 stops outside its forest model, and regrowth on the edge of it is still
 * regrowth. Scoring it as if it were pure spruce would demote exactly the young
 * ground the browse term exists to find, so an unknown mix takes the middling
 * factor and says so in the card.
 */
const UNKNOWN_SPECIES_BROWSE = 0.7;

/**
 * Share of a quarry's weighted signals that must be readable at a pixel before
 * the model will score it at all.
 *
 * Half, which sounds lax and is not: a forest quarry above the tree line keeps
 * barely a third of its weight (AR5 and SR16 both stop there), while a ptarmigan
 * quarry on the same ground keeps most of its own, because its heaviest signal
 * is the tree-line band itself. So the gate lands exactly where it should —
 * silencing the models that are guessing, leaving the one that is reading.
 *
 * Exclusive terms cost a little evidence by construction (a mature stand cannot
 * satisfy `cover-young`), which is accepted: measured on real cells the worst
 * case is a fifth of the weight, well inside the margin.
 */
const MIN_EVIDENCE = 0.5;

/** Everything one cell's hunt model works from, already on the raster. */
export interface HuntInputs {
  /** AR5 `artype` codes; nodata above the tree line and off the map. */
  readonly landCover: Grid | null;
  /** Elevation in metres, or null when the DTM did not answer. */
  readonly terrain: Grid | null;
  /** SR16 `SRRHOYDEO` dominant stand height in **metres**; nodata off the model. */
  readonly treeHeightM: Grid | null;
  /** SR16 `SRRTRESLAG`: 1 spruce · 2 pine · 3 deciduous; nodata off the model. */
  readonly treeSpecies: Grid | null;
  /** Lakes and real channels — not huntable ground, and the water signal's source. */
  readonly water: Mask;
  /**
   * Roads and dwellings. Game avoids traffic and shooting near houses is
   * regulated, so this drives an *avoidance* field rather than a proximity one.
   */
  readonly disturbance: Mask;
  /**
   * Surveyed functional areas for this quarry, 0..1 by `verdi`, **nodata off the
   * surveyed ground**. Presence-only: the absence of a polygon means nobody
   * looked, never that nothing lives there.
   */
  readonly artfunksjon: Grid | null;
  /**
   * Local tree-line elevation in metres, or null when this area cannot say —
   * see `treeLineElevationM`. A quarry whose band is measured against it cannot
   * be scored without it.
   */
  readonly treeLineM: number | null;
}

export interface HuntSurface {
  /** Raw 0..1 score, nodata off huntable ground. */
  readonly score: Grid;
  /** Every term that contributed, for `explainPoint` and the manifest. */
  readonly terms: CombineTerm[];
  readonly notes: string[];
}

const LABELS = new Map(HUNT_SIGNALS.map((s) => [s.key as HuntSignalKey, s.label]));

/** Percentage as a word, so the explain card never reads like a spreadsheet. */
function strength(value: number): string {
  return value >= 0.75 ? 'strongly' : value >= 0.4 ? 'moderately' : 'weakly';
}

/**
 * The sentence one signal contributes to the explain card.
 *
 * Exported, and used by the model itself, because the card is rendered long
 * after the surface was derived: the backend persists each signal's value per
 * cell but cannot persist a closure, so without a shared function here the card
 * would fall back to "Browse: 54 %" — a number restated, which is exactly the
 * non-explanation D4 exists to rule out.
 */
export function describeHuntSignal(
  key: HuntSignalKey,
  value: number,
  ctx: { quarry: Quarry },
): string {
  switch (key) {
    case 'edge-farmland':
      return value > 0.05
        ? `${strength(value)} inside the pull of a forest–farmland edge`
        : `no field edge within ${FARM_EDGE_MAX_M} m — confirmed absent, not missing data`;
    case 'edge-myr':
      return value > 0.05
        ? `${strength(value)} inside a bog fringe, on the forest side of it`
        : 'no bog fringe near here';
    case 'cover-young':
      return value > 0.05
        ? `${strength(value)} dense young cover — regrowth and thicket`
        : 'open under the trees, with nothing to hide in';
    case 'cover-mature':
      return value > 0.05
        ? `a ${strength(value)} closed mature stand — bedding and shelter`
        : 'no closed mature stand here';
    case 'pine-mature':
      return value > 0.05
        ? `${strength(value)} old pine, which is what a lek wants`
        : 'no mature pine here';
    case 'browse':
      return value > 0.05
        ? `${strength(value)} browse — shoots within reach, with the deciduous share counted`
        : 'nothing within reach to browse';
    case 'water':
      return value > 0.05 ? `${strength(value)} close to open water` : 'no open water near here';
    case 'slope':
      return value > 0.05
        ? `ground ${strength(value)} inside the slope ${ctx.quarry.nameNo.toLowerCase()} uses`
        : `steeper ground than ${ctx.quarry.nameNo.toLowerCase()} use`;
    case 'warmth':
      return value > 0.05
        ? `a ${strength(value)} sun-facing slope`
        : 'a shaded, north-facing slope';
    case 'treeline':
      return value > 0.05
        ? `${strength(value)} inside the height band around the local tree line`
        : 'outside the height band around the local tree line';
    case 'rocky-ridge':
      return value > 0.05
        ? `${strength(value)} on exposed stony ground above the forest`
        : 'not on an exposed ridge';
    case 'quiet':
      return value >= 0.75
        ? `well away from roads and buildings (${ctx.quarry.disturbanceBufferM} m is this quarry's distance)`
        : `${strength(1 - value)} disturbed by roads or buildings nearby`;
    case 'artfunksjon':
      return `inside a surveyed functional area for ${ctx.quarry.nameNo.toLowerCase()} — grazing, calving or lek`;
  }
}

/**
 * The hunt surface for one quarry.
 *
 * Terms are assembled first and combined last, so the same array that produced
 * the pixel is what the explain card reads — the card cannot drift from the
 * arithmetic, because it *is* the arithmetic.
 */
export function huntSurface(inputs: HuntInputs, opts: { quarry: Quarry }): HuntSurface {
  const { quarry } = opts;
  const weights = quarry.weights;
  const notes: string[] = [];
  const terms: CombineTerm[] = [];

  const shape = inputs.landCover ?? inputs.terrain ?? inputs.treeHeightM;
  const width = shape?.width ?? inputs.water.width;
  const height = shape?.height ?? inputs.water.height;
  const cellSizeM = shape?.cellSizeM ?? inputs.water.cellSizeM;
  const empty = (): Grid => createGrid(width, height, cellSizeM);

  /**
   * Add a term only if the quarry weights it, the input exists, and the input
   * has something to say *here*.
   *
   * The last of those is not pedantry: SR16 stops at the forest model's edge, so
   * a cell of open fjell hands the cover terms a grid that is nodata end to end.
   * Kept, it would be persisted as an empty signal plane and the explain card
   * would report "no young cover data" as though an upstream had failed, when
   * what actually happened is that there are no young stands here at all.
   */
  const add = (key: HuntSignalKey, grid: Grid | null, exclusive = false): void => {
    const weight = weights[key];
    if (!weight || !grid || !grid.data.some((v) => Number.isFinite(v))) return;
    terms.push({
      key,
      label: LABELS.get(key) ?? key,
      weight,
      grid,
      ...(exclusive ? { exclusive: true } : {}),
      describe: (value) => describeHuntSignal(key, value, { quarry }),
    });
  };

  // A quarry that lives at the tree line cannot be scored without one. Every
  // other signal it carries — young cover, bog fringe, water — exists in a
  // lowland spruce plantation too, so scoring them there would draw a confident
  // ptarmigan surface on ground no ptarmigan has ever seen. Say nothing instead.
  if (quarry.treeLineBandM && inputs.treeLineM === null) {
    return {
      score: empty(),
      terms,
      notes: [
        `${quarry.nameNo} is scored against the local tree line, and this area has none — so nothing is scored here.`,
      ],
    };
  }

  // --- 1. Edges: where two land-cover classes meet -------------------------
  // The edge mask is taken on the *forest* side (`edgeMask` returns cells of the
  // first argument), so a bog fringe peaks in the timber a deer stands in rather
  // than out on the open mire.
  if (inputs.landCover) {
    const forest = classMask(inputs.landCover, AR5_FOREST);
    const farmland = classMask(inputs.landCover, AR5_FARMLAND);
    const myr = classMask(inputs.landCover, AR5_MYR);
    add(
      'edge-farmland',
      edgeProximity(forest, farmland, {
        halfDistanceM: FARM_EDGE_HALF_M,
        maxDistanceM: FARM_EDGE_MAX_M,
      }),
    );
    add(
      'edge-myr',
      edgeProximity(forest, myr, { halfDistanceM: MYR_EDGE_HALF_M, maxDistanceM: MYR_EDGE_MAX_M }),
    );
  } else {
    notes.push('No land cover here, so field edges and bog fringes could not be read.');
  }

  // --- 2. Stand structure from SR16 ----------------------------------------
  // A grid that answered with nothing is the same fact as no grid at all: SR16
  // stops where its forest model stops, and above that line "no stand height"
  // must read as unknown rather than as ground with no trees on it.
  const hasHeight =
    inputs.treeHeightM !== null && inputs.treeHeightM.data.some((v) => Number.isFinite(v));
  if (hasHeight) {
    const height01 = inputs.treeHeightM!;
    const youngHere = (grid: Grid, wantYoung: boolean): Grid =>
      mapValues(grid, (v, x, y) => {
        const h = height01.data[y * height01.width + x]!;
        if (!Number.isFinite(h)) return Number.NaN;
        return h < STAND_SPLIT_M === wantYoung ? v : Number.NaN;
      });
    add('cover-young', youngHere(membershipGrid(height01, YOUNG_COVER_M), true), true);
    add('cover-mature', youngHere(membershipGrid(height01, MATURE_COVER_M), false), true);

    const radius = Math.max(1, Math.round(SPECIES_RADIUS_M / cellSizeM));
    const share = (code: number): Grid | null =>
      inputs.treeSpecies
        ? focalMean(
            mapValues(inputs.treeSpecies, (v) => (Number.isFinite(v) ? (v === code ? 1 : 0) : NaN)),
            radius,
          )
        : null;

    // Mature *pine* is the capercaillie signal, and AR5 cannot answer it: its
    // `Treslag` separates conifer from deciduous and stops there. SR16's
    // `SRRTRESLAG` is the only national layer that says pine rather than spruce,
    // which is why it is fetched despite the plan once calling it redundant.
    const pine = share(SR16_PINE);
    add(
      'pine-mature',
      pine
        ? mapValues(membershipGrid(height01, MATURE_COVER_M), (v, x, y) => {
            const p = pine.data[y * pine.width + x]!;
            return Number.isFinite(v) && Number.isFinite(p) ? v * p : Number.NaN;
          })
        : null,
    );

    const deciduous = share(SR16_DECIDUOUS);
    add(
      'browse',
      mapValues(membershipGrid(height01, BROWSE_HEIGHT_M), (v, x, y) => {
        if (!Number.isFinite(v)) return Number.NaN;
        const d = deciduous ? deciduous.data[y * deciduous.width + x]! : Number.NaN;
        // Rowan, willow and birch carry a moose through the winter, and a stand
        // with none of them is thinner browse — but never worthless, since the
        // field layer SR16 does not see is browse too.
        return v * (Number.isFinite(d) ? 0.4 + 0.6 * d : UNKNOWN_SPECIES_BROWSE);
      }),
    );
  } else {
    notes.push('No stand-height model here, so cover, pine and browse could not be read.');
  }

  // --- 3. Water ------------------------------------------------------------
  add(
    'water',
    proximityField(inputs.water, { halfDistanceM: WATER_HALF_M, maxDistanceM: WATER_MAX_M }),
  );

  // --- 4. Terrain ----------------------------------------------------------
  if (inputs.terrain) {
    add('slope', membershipGrid(slopePercent(inputs.terrain), quarry.slopeBandPercent));
    // Flat ground has no aspect, so `southness` is nodata there and the pixel is
    // scored by its other signals rather than being called north-facing.
    add('warmth', southness(aspectDegrees(inputs.terrain)));

    if (inputs.treeLineM !== null) {
      const line = inputs.treeLineM;
      const relative = mapValues(inputs.terrain, (v) => (Number.isFinite(v) ? v - line : NaN));
      if (quarry.treeLineBandM) add('treeline', membershipGrid(relative, quarry.treeLineBandM));

      // A ridge only reads as *rocky* above the forest; below it the same
      // landform is a wooded knoll. Known forest demotes it; unknown cover
      // (which above the tree line is most of AR5) leaves it alone.
      const ridge = membershipGrid(topographicPositionM(inputs.terrain, TPI_RADIUS_M), RIDGE_TPI_M);
      const forest = inputs.landCover ? classMask(inputs.landCover, AR5_FOREST) : null;
      add(
        'rocky-ridge',
        mapValues(ridge, (v, x, y) => {
          const i = y * width + x;
          if (!Number.isFinite(v)) return Number.NaN;
          if (relative.data[i]! < 0) return 0; // below the tree line: not rocky ground
          return forest?.data[i] === 1 ? 0 : v;
        }),
      );
    }
  } else {
    notes.push('No elevation here, so slope, warmth and the tree-line band could not be read.');
  }

  // --- 5. Disturbance ------------------------------------------------------
  // The quarry's own buffer sets the scale: a roe deer feeds 100 m from a barn,
  // a red deer keeps four times that. Expressed as avoidance so the *value* is
  // low near a road — a penalty is never a negative weight, because the combine
  // renormalises on weights and a negative one would make the denominator lie.
  if (inputs.landCover) {
    add(
      'quiet',
      avoidanceField(inputs.disturbance, {
        halfDistanceM: quarry.disturbanceBufferM,
        maxDistanceM: quarry.disturbanceBufferM * 5,
      }),
    );
  }

  // --- 6. Surveyed functional areas ----------------------------------------
  // Presence-only, and the one term whose *absence* is not a fact: nodata off
  // the surveyed polygons, so a hillside nobody walked is scored by everything
  // else rather than marked empty of game.
  add('artfunksjon', inputs.artfunksjon);

  if (terms.length === 0) {
    return { score: empty(), terms, notes: [...notes, 'Nothing is known about this ground yet.'] };
  }

  // What the model is willing to speak about: dry, undeveloped ground. Water,
  // buildings and road surface are not huntable and are left unscored rather
  // than scored low — a cool verdict over a housing estate is still a verdict.
  const huntable = createMask(width, height, cellSizeM);
  const offGround = inputs.landCover
    ? maskFromGrid(inputs.landCover, (v) => [...AR5_DEVELOPED, ...AR5_WATER].includes(v))
    : null;

  // …and ground it has actually read. `combine()` renormalises over whatever
  // answered, which is right for one missing input and wrong when most of them
  // are missing: above the tree line AR5 and SR16 both stop, so a forest quarry
  // is left being scored by "gentle, quiet, near water" — and the live drive
  // found exactly that, elg's hottest ground in Vågå averaging 1 161 m of open
  // fjell. A model with a tenth of its evidence is not entitled to an opinion,
  // so the pixel goes unscored and the ptarmigan targets — whose signals are
  // *designed* for that ground — keep theirs.
  const totalWeight = terms.reduce((sum, t) => sum + t.weight, 0);
  let unread = 0;
  let candidate = 0;
  for (let i = 0; i < huntable.data.length; i++) {
    if (inputs.water.data[i] === 1 || offGround?.data[i] === 1) continue;
    candidate++;
    let read = 0;
    for (const term of terms) if (Number.isFinite(term.grid.data[i]!)) read += term.weight;
    if (read >= MIN_EVIDENCE * totalWeight) huntable.data[i] = 1;
    else unread++;
  }
  if (unread > 0 && candidate > 0) {
    const share = Math.round((unread / candidate) * 100);
    if (share >= 5) {
      notes.push(
        `${share} % of the ground here is left unscored: too few of ${quarry.nameNo.toLowerCase()}'s signals could be read there — usually above the tree line, where AR5 and SR16 both stop.`,
      );
    }
  }

  return { score: applyMask(combine(terms), huntable), terms, notes };
}

/**
 * How good this ground is for the quarry *at all*, 0..1 — D5's **second**
 * number, and here it comes from outside the terrain entirely.
 *
 * Percentile ranking guarantees a top decile whether one is deserved or not, so
 * a cell in a kommune that shoots four moose a year would otherwise render the
 * same confident reds as one in Stange. SSB's felte-vilt tables answer that at
 * kommune level, back to 1986-87, and a season's harvest is the bluntest honest
 * statement available about whether the animal is really there in numbers.
 *
 * **A count, not a density** — deliberately, and it is the weakness of this
 * term: no keyless per-kommune huntable-area figure exists (SSB publishes no
 * felt-per-10-km² table and Kartverket's kommuneinfo carries no area), so a
 * large thinly-populated kommune and a small dense one are not distinguished.
 * The tier is four coarse words and the manifest quotes the real number and the
 * season beside it, which is the honest way to ship a prior this rough.
 */
export function huntQuality(prior: {
  /** Animals felled in the kommune last season, or null where no table exists. */
  readonly harvest: number | null;
  /** The count that reads as strong ground for this quarry — `Quarry.strongHarvest`. */
  readonly strongHarvest: number | null;
}): number | undefined {
  if (prior.harvest === null || prior.strongHarvest === null || !(prior.strongHarvest > 0)) {
    return undefined;
  }
  // Linear against the quarry's own p90, which lands the four tiers where the
  // real distribution does: a kommune at the national median comes out
  // *Ordinary*, the upper quartile *Good*, and only the genuine strongholds
  // *Excellent*. A log scale was tried first and flattened all three together.
  const t = Math.min(1, Math.max(0, prior.harvest / prior.strongHarvest));
  // Floors at "marginal" rather than zero: a kommune that shot none last season
  // may still hold animals, and the surface is about ground rather than bag.
  return Math.min(0.95, 0.15 + 0.8 * t);
}
