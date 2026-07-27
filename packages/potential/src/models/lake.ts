/**
 * The lake fishing model (ROADMAP § N5 → E3, design in
 * docs/FISH-HUNT-ENGINE.md § "Lake fishing potential").
 *
 * **Two models behind one layer, chosen by data — and the depth-free shore
 * model is the main one.** Only 607 of Norway's 267 194 lakes carry an NVE depth
 * survey, so the bathymetric path runs on 2.9 % of water and the shore path on
 * the rest. The modelling budget follows that split: the shore signals below are
 * the ones a user actually meets, and they have to discriminate on their own or
 * the layer is the flat "worth a cast everywhere" wash that D5 exists to prevent.
 *
 * This file is pure arithmetic over rasters the caller has already prepared.
 * Nothing here fetches, projects or knows what a lake polygon looks like in
 * lon/lat — the backend's adapter does all of that, which is what keeps the
 * opinions testable in the quality gate and eventually runnable on a phone.
 *
 * Two rules inherited from nodemap, both load-bearing:
 *
 * - **The engine never branches on a species.** Everything species-specific
 *   arrives as `FishSpecies` weights and bands; adding røye is a data row.
 * - **A missing input reads as *unknown*, never as bad water.** Every term is
 *   nodata where its input has nothing to say, and `combine()` renormalises per
 *   pixel, so a cell with no DTM is scored by the signals that did arrive rather
 *   than penalised for the one that did not.
 */
import type { CombineTerm, Grid, Mask } from '../raster.js';
import {
  applyMask,
  combine,
  createGrid,
  createMask,
  fillNearest,
  focalMean,
  mapValues,
  maskFromGrid,
} from '../raster.js';
import type { Band } from '../signals.js';
import {
  boundaryBand,
  dropOffField,
  membership,
  membershipGrid,
  mouthMask,
  nearshoreSlopePercent,
  proximityField,
  shelfField,
  shorelineStructure,
  structureField,
} from '../signals.js';
import type { FishSpecies, LakeSignalKey, Season } from '../species.js';
import { depthBandFor, describeDepthBand, LAKE_SIGNALS } from '../species.js';

/**
 * How far from the bank the depth-free model is willing to say anything.
 *
 * Beyond this the shore signals are silent by construction (they are gated to
 * the shore band) and the only survivors would be the lake-wide priors, which
 * are constant — so scoring open water would hand a large flat area to the
 * percentile ranking and squeeze the real contrast along the bank into the top
 * few percent. Unsurveyed open water is *unknown*, and the map says so by
 * drawing nothing there.
 */
export const SHORE_BAND_M = 150;

/** Neighbourhood the shoreline's concavity is measured over — bay-sized. */
const STRUCTURE_RADIUS_M = 120;

/**
 * Ring at the bank in which shoreline curvature is *measured* (as opposed to
 * where it is applied, which is the whole fishable band). Three pixels of the
 * derive raster — wide enough to survive a rasterised shoreline's jaggedness,
 * narrow enough that "how far from the bank am I" cannot leak into it.
 */
const SHORE_MEASURE_BAND_M = 30;

/** Dry ring just outside the waterline that the drop-off is inferred from. */
const NEARSHORE_RING_M = 60;

/** How far the ring's slope is spread across the adjacent water. */
const NEARSHORE_SPREAD_M = 60;

/** Ring around the shoreline in which a stream cell counts as a mouth. */
const MOUTH_RING_M = 40;

/** Window the bank's land cover is read over. */
const SHORE_COVER_RADIUS_M = 120;

/**
 * Shoreline terrain steepness, in **percent**, read as an inferred drop-off.
 *
 * A bog shore runs at a few percent and shelves out shallow; a forest bank sits
 * around 10–30 %; rock steep enough to promise a break underwater starts near
 * 25 % and a genuine cliff reaches several hundred. Past 400 % it is far more
 * likely to be a DTM artefact — a building edge, a quarry wall — than lake
 * bottom, so the membership falls away again rather than saturating.
 */
export const NEARSHORE_STEEP_PERCENT: Band = { min: 0, peakMin: 25, peakMax: 200, max: 400 };

/** Bottom gradient that reads as a break rather than a slope, in percent. */
export const BOTTOM_STEEP_PERCENT: Band = { min: 2, peakMin: 8, peakMax: 60, max: 120 };

/** Bottom gradient that reads as a shelf or flat — the other half of structure. */
export const BOTTOM_FLAT_PERCENT: Band = { min: -1, peakMin: -1, peakMax: 2, max: 6 };

/**
 * Productivity of the bank behind each land-cover class, 0..1 — how much food a
 * shore of this kind puts into the water.
 *
 * Keyed by AR5 `artype`. Myr leads: humic bog water carries insects and the
 * margins are where trout patrol. Farmland runs close behind for the blunt
 * reason that its runoff is fertiliser. Forest gives shade and terrestrial
 * insect fall. Open rock and heath give little, and built-up shoreline less.
 * Water classes are absent on purpose — they are not a bank — and `99 Ikke
 * kartlagt` is absent because AR5 stops at the tree line, where a missing class
 * must read as unknown rather than as barren ground.
 */
export const SHORE_COVER_VALUE: Readonly<Record<number, number>> = {
  60: 1, // Myr
  21: 0.9, // Fulldyrka jord
  22: 0.9, // Overflatedyrka jord
  23: 0.85, // Innmarksbeite
  30: 0.7, // Skog
  50: 0.3, // Åpen fastmark
  11: 0.25, // Bebygd
  12: 0.2, // Samferdsel
};

/** Everything one cell's lake model works from, already on the raster. */
export interface LakeInputs {
  /** Filled lake polygons — the interior, not the outline (see `fillRings`). */
  readonly water: Mask;
  /** Elevation in metres, or null when the DTM did not answer. */
  readonly terrain: Grid | null;
  /**
   * Interpolated depth below the surface, in metres, nodata off any surveyed
   * lake. Null when this cell has no survey at all — the ~97 % case.
   */
  readonly depthM: Grid | null;
  /** Real channels (`ltema` 3211) entering the water. */
  readonly inflows: Mask;
  /** The single descending channel per lake — its outlet. */
  readonly outflows: Mask;
  /**
   * 0..1 size of the inflow nearest each pixel, from Strahler order or
   * discharge. Null falls back to treating every inflow as equal, which is what
   * a network with no order attribute deserves.
   */
  readonly inflowMagnitude: Grid | null;
  /** AR5 `artype` codes; nodata above the tree line and off the map. */
  readonly landCover: Grid | null;
  /** Per-lake productivity prior, 0..1, painted over the lake; nodata elsewhere. */
  readonly productivity: Grid | null;
  /** Per-lake regulation term, 0..1 (low = drawdown zone); nodata elsewhere. */
  readonly regulated: Grid | null;
}

export interface LakeSurface {
  /** Raw 0..1 score, nodata off the fishable water. */
  readonly score: Grid;
  /** Every term that contributed, for `explainPoint` and the manifest. */
  readonly terms: CombineTerm[];
  /** Did any pixel here score from a real depth survey? */
  readonly bathymetric: boolean;
  /** "Summer band 4–9 m" — the band actually in use, never applied silently. */
  readonly depthBandLabel: string | null;
  readonly notes: string[];
}

const LABELS = new Map(LAKE_SIGNALS.map((s) => [s.key as LakeSignalKey, s.label]));

/** Percentage as a word, so the explain card never reads like a spreadsheet. */
function strength(value: number): string {
  return value >= 0.75 ? 'strongly' : value >= 0.4 ? 'moderately' : 'weakly';
}

/**
 * The sentence one signal contributes to the explain card.
 *
 * Exported, and used by the model itself, because the card is rendered **long
 * after** the surface was derived: the backend persists each signal's value per
 * cell but cannot persist a closure, so without a shared function here the card
 * would fall back to "Inflow mouth: 54 %" — a number restated, which is exactly
 * the non-explanation D4 exists to rule out. One function, two callers, no way
 * for the wording to drift from the arithmetic that earned it.
 */
export function describeLakeSignal(
  key: LakeSignalKey,
  value: number,
  ctx: { species: FishSpecies; season: Season },
): string {
  switch (key) {
    case 'nearshore-slope':
      return `the bank is ${strength(value)} steep, so a drop-off is inferred (no depth survey)`;
    case 'cove':
      return value > 0.05
        ? `a ${strength(value)} concave shoreline — a bay or a narrows`
        : 'a straight shoreline';
    case 'headland':
      return value > 0.05
        ? `a ${strength(value)} convex shoreline — a point or island`
        : 'a straight shoreline';
    case 'inlet':
      return `${strength(value)} inside an inflow mouth's cold, food-bearing water`;
    case 'outlet':
      return `${strength(value)} inside the outlet's current`;
    case 'shore-cover':
      return `a ${strength(value)} productive bank — bog, field or forest`;
    case 'productivity':
      return `a ${strength(value)} productive lake for its region`;
    case 'regulated':
      return value < 0.5
        ? 'inside a regulated lake’s drawdown zone — dead water'
        : 'not a regulated lake';
    case 'structure':
      return `${strength(value)} on a break or shelf — NVE depth survey`;
    case 'depth-band': {
      const band = describeDepthBand(ctx.species, ctx.season);
      return band
        ? `${strength(value)} inside the ${band.toLowerCase()}`
        : `${strength(value)} inside the holding depth`;
    }
    case 'wind-fetch':
      return `${strength(value)} onto this bank in today's wind`;
  }
}

/**
 * The lake surface for one target.
 *
 * Terms are assembled first and combined last, so the same array that produced
 * the pixel is what the explain card reads — the card cannot drift from the
 * arithmetic, because it *is* the arithmetic.
 */
export function lakeSurface(
  inputs: LakeInputs,
  opts: { species: FishSpecies; season: Season },
): LakeSurface {
  const { water } = inputs;
  const { species, season } = opts;
  const weights = species.lakeWeights;
  const notes: string[] = [];
  const terms: CombineTerm[] = [];

  /** Add a term only if the species weights it and the input exists. */
  const add = (key: LakeSignalKey, grid: Grid | null): void => {
    const weight = weights[key];
    if (!weight || !grid) return;
    terms.push({
      key,
      label: LABELS.get(key) ?? key,
      weight,
      grid,
      describe: (value) => describeLakeSignal(key, value, { species, season }),
    });
  };

  const shoreBand = boundaryBand(water, SHORE_BAND_M);

  // --- 1. Nearshore slope: the depth-free stand-in for bathymetry -----------
  // Steepness at the waterline continues underwater. It is *inferred*, and both
  // the label and the sentence say so — passing it off as a survey would be the
  // one dishonest thing this model could do.
  const nearshore = inputs.terrain
    ? membershipGrid(
        nearshoreSlopePercent(inputs.terrain, water, {
          ringM: NEARSHORE_RING_M,
          spreadM: NEARSHORE_SPREAD_M,
          shoreBandM: SHORE_BAND_M,
        }),
        NEARSHORE_STEEP_PERCENT,
      )
    : null;
  if (!inputs.terrain) notes.push('No elevation here, so no drop-off could be inferred.');
  add('nearshore-slope', nearshore);

  // --- 2. Shoreline geometry: structure at zero data cost -------------------
  // Measured in a narrow ring at the bank and then carried inward from the
  // *nearest* shoreline point, rather than evaluated at every pixel of the
  // fishable band. Curvature is a property of the shoreline; evaluated across a
  // 150 m band it instead measures how far out you are, because the fraction of
  // water in view keeps rising as you leave the bank. On a plain round pond that
  // alone manufactured a smooth gradient — and therefore a "standout" — out of a
  // lake with no structure whatsoever, which is exactly the lie D5 forbids.
  const shape = shorelineStructure(water, {
    radiusM: STRUCTURE_RADIUS_M,
    shoreBandM: SHORE_MEASURE_BAND_M,
  });
  const alongShore = (field: Grid): Grid => applyMask(fillNearest(field), shoreBand);
  add('cove', alongShore(shape.coves));
  add('headland', alongShore(shape.headlands));

  // --- 3. Inflow and outflow mouths: the backbone signal --------------------
  // Elvenett runs every stream straight through its lake, so proximity to the
  // raw network lights a band down the middle of the water. `mouthMask` clips to
  // the shoreline ring; the caller has already dropped the through-flow
  // centrelines and the fictitious connectors on `ltema`. Both halves are
  // needed — this is the primary signal of the primary model.
  const mouths = mouthMask(inputs.inflows, water, { ringM: MOUTH_RING_M });
  const inletProximity = proximityField(mouths, { halfDistanceM: 60, maxDistanceM: 400 });
  // A 4th-order inflow outranks a trickle, and Strahler gives that for free.
  const inlet = applyMask(
    inputs.inflowMagnitude
      ? mapValues(inletProximity, (v, x, y) => {
          const m = inputs.inflowMagnitude!.data[y * water.width + x]!;
          // Never scale to zero on a missing order: an unattributed inflow is
          // still an inflow. Half weight is the honest discount.
          return v * (Number.isFinite(m) ? 0.5 + 0.5 * m : 0.5);
        })
      : inletProximity,
    water,
  );
  add('inlet', inlet);

  const outletMouths = mouthMask(inputs.outflows, water, { ringM: MOUTH_RING_M });
  add(
    'outlet',
    applyMask(proximityField(outletMouths, { halfDistanceM: 50, maxDistanceM: 250 }), water),
  );

  // --- 4. Bank land cover: the productivity term ----------------------------
  // The bank's cover is measured on land but has to be *read* from the water.
  // `focalMean` skips nodata rather than counting it as zero, so a water pixel
  // inside the window of a bog bank takes the bog's value — that borrowing is
  // the point here, not a side effect. Unmapped classes (99, above the tree
  // line) stay nodata and simply drop out.
  const shoreCover = inputs.landCover
    ? applyMask(
        focalMean(
          mapValues(inputs.landCover, (code) => SHORE_COVER_VALUE[code] ?? Number.NaN),
          Math.max(1, Math.round(SHORE_COVER_RADIUS_M / water.cellSizeM)),
        ),
        shoreBand,
      )
    : null;
  add('shore-cover', shoreCover);

  // --- 5. Lake-register priors ---------------------------------------------
  add('productivity', inputs.productivity);
  add('regulated', inputs.regulated);

  // --- 6. Bathymetry, where a survey exists (the 2.9 % case) ----------------
  const band = depthBandFor(species, season);
  let bathymetric = false;
  if (inputs.depthM && band) {
    bathymetric = true;
    // max(drop-off, shelf), never their average: the two are mutually exclusive
    // by construction, so averaging cancels them and caps the score below the
    // hot end of the ramp. nodemap rendered a surveyed lake as a faint wash for
    // exactly this reason.
    const structure = structureField(
      dropOffField(inputs.depthM, {
        steepPercent: BOTTOM_STEEP_PERCENT,
        depthBandM: band,
      }),
      shelfField(inputs.depthM, { flatPercent: BOTTOM_FLAT_PERCENT, shallowM: band }),
    );
    add('structure', structure);
    add('depth-band', membershipGrid(inputs.depthM, band));
  } else if (inputs.depthM && !band) {
    notes.push(`${species.nameNo} is a river target, so the depth survey is not read here.`);
  }

  if (terms.length === 0) {
    return {
      score: createGrid(water.width, water.height, water.cellSizeM),
      terms,
      bathymetric,
      depthBandLabel: null,
      notes: [...notes, 'Nothing is known about this water yet.'],
    };
  }

  // Score only what the model can honestly speak about: the fishable band, plus
  // any water a survey reaches. Everywhere else stays nodata and draws nothing.
  const fishable = createMask(water.width, water.height, water.cellSizeM);
  const surveyed = inputs.depthM && band ? maskFromGrid(inputs.depthM, () => true) : null;
  for (let i = 0; i < fishable.data.length; i++) {
    fishable.data[i] = shoreBand.data[i] === 1 || surveyed?.data[i] === 1 ? 1 : 0;
  }

  return {
    score: applyMask(combine(terms), fishable),
    terms,
    bathymetric,
    depthBandLabel: bathymetric ? describeDepthBand(species, season) : null,
    notes,
  };
}

/**
 * A lake's absolute productivity prior, 0..1 — D5's *second* number: **how good
 * is this water at all**, as opposed to where in it.
 *
 * Percentile ranking guarantees a top decile whether or not one is deserved, so
 * without an absolute tier beside it a featureless mountain tarn renders "prime"
 * simply because something has to be. All three inputs come free with the lake
 * register, and none of them is a per-pixel signal — this is a coarse verdict
 * about the whole lake, and it is reported as one of four words.
 */
export function lakeProductivity(lake: {
  readonly elevationM: number | null;
  readonly areaKm2: number | null;
  readonly catchmentKm2: number | null;
}): number {
  const nutrients: { value: number; weight: number }[] = [];

  // Catchment relative to lake area: a large catchment feeding a small lake
  // delivers nutrients and keeps the water turning over.
  if (lake.catchmentKm2 !== null && lake.areaKm2 !== null && lake.areaKm2 > 0) {
    const ratio = lake.catchmentKm2 / lake.areaKm2;
    nutrients.push({
      value: Math.max(0, Math.min(1, (Math.log10(Math.max(ratio, 0.1)) + 1) / 3)),
      weight: 0.8,
    });
  }
  // Area: small waters warm through and are productive per hectare; very large
  // ones are colder and thinner. A weak term, and weighted like one.
  if (lake.areaKm2 !== null) {
    nutrients.push({
      value: membership(Math.log10(Math.max(lake.areaKm2, 1e-4)), {
        min: -4,
        peakMin: -2,
        peakMax: 0.3,
        max: 3,
      }),
      weight: 0.4,
    });
  }

  if (lake.elevationM === null && nutrients.length === 0) return 0.5; // neither promise nor condemn

  const weights = nutrients.reduce((sum, p) => sum + p.weight, 0);
  const nutrient =
    weights > 0 ? nutrients.reduce((sum, p) => sum + p.weight * p.value, 0) / weights : 0.5;

  // Altitude **limits** rather than averages. The growing season shortens and
  // the water turns oligotrophic with height, and no catchment can undo that:
  // a mountain tarn's 8:1 catchment ratio is 8:1 of bare rock. Averaging the
  // two let a 1300 m tarn come out "Ordinary" on the strength of a nutrient
  // term that altitude had already invalidated.
  //
  // The floor matters as much as the ceiling: a high lake is thin water, not
  // dead water — røye live there and are worth fishing for — so this bottoms
  // out at a quarter rather than at zero.
  if (lake.elevationM === null) return nutrient;
  const season = membership(lake.elevationM, { min: -50, peakMin: -50, peakMax: 200, max: 1400 });
  return nutrient * (0.25 + 0.75 * season);
}

/**
 * Regulation term, 0..1. A regulated lake's drawdown zone is dead water: the
 * littoral is scoured bare every season, so the shore signals that carry this
 * model are measuring a bank the fish do not use.
 *
 * Expressed as a low *value* rather than a negative weight, because
 * `combine()`'s per-pixel renormalisation needs positive weights to mean
 * anything — a rule the primitive enforces, and this is the case it exists for.
 */
export function lakeRegulation(kind: string | null): number {
  return kind !== null && /regulert/i.test(kind) ? 0.25 : 1;
}
