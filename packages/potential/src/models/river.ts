/**
 * The river fishing model (ROADMAP § N5 → E4, design in
 * docs/FISH-HUNT-ENGINE.md § "River fishing potential").
 *
 * **One set of channel signals, two kinds of fish.** Pool, riffle, seam,
 * confluence, bend, size and bank cover describe what the water is doing, and
 * they describe it identically whether the fish in it was born there or came in
 * from the sea. The anadromous targets add exactly two things on top: a gate
 * (score only water laks and sjøørret can physically reach) and the barrier
 * pool (they stack under the first impassable falls). Building the character
 * signals twice would have been two models to keep in step.
 *
 * Like the lake model this file is pure arithmetic over rasters the caller has
 * prepared. Nothing here fetches, projects, or knows which way a stream flows in
 * lon/lat — the backend's adapter does all of that.
 *
 * Three rules inherited from the lake model, all load-bearing:
 *
 * - **The engine never branches on a species.** A target is a row of
 *   `riverWeights` plus the `anadromous` flag; adding harr is a data row.
 * - **A missing input reads as *unknown*, never as bad water**, and `combine()`
 *   renormalises per pixel so a reach with no elevation is scored by the signals
 *   that did arrive.
 * - **Gradient is measured in percent, never degrees.** nodemap classified
 *   pool/riffle from degrees and every cell came back "pool", because 4° is
 *   already a 7 % grade — a cascade. Real channels separate at fractions of a
 *   percent.
 */
import type { CombineTerm, Grid, Mask } from '../raster.js';
import {
  applyMask,
  combine,
  createGrid,
  createMask,
  distanceToMask,
  distanceTransform,
  fillNearest,
  focalMean,
  mapValues,
} from '../raster.js';
import {
  classifyChannel,
  membershipGrid,
  magnitudeFromDischarge,
  POOL_PERCENT,
  proximityField,
  RIFFLE_PERCENT,
  BEND_DEG,
  SEAM_BREAK_PERCENT,
} from '../signals.js';
import type { FishSpecies, RiverSignalKey } from '../species.js';
import { RIVER_SIGNALS } from '../species.js';

/**
 * How wide the fishable corridor is around the smallest channel, in metres.
 *
 * The surface answers "where along this river", so it is drawn on the water and
 * the bank a caster stands on — not on the whole valley. A brook is a couple of
 * metres wide and its bank is where you stand, so ~25 m covers both.
 */
export const CORRIDOR_MIN_M = 25;

/**
 * …and around the largest. Elvenett is a centreline with no width attribute, so
 * a river's own breadth has to be inferred from its size: the Glomma is 200 m
 * across in places and a 25 m corridor would draw a thread down the middle of
 * it. Scaling with magnitude keeps a brook's answer tight and still puts a
 * big river's far bank inside its own surface.
 */
export const CORRIDOR_MAX_M = 90;

/** Neighbourhood the bank's land cover is read over. */
const BANK_COVER_RADIUS_M = 90;

/** How far a confluence's mixing water reaches. */
const CONFLUENCE_HALF_M = 70;
const CONFLUENCE_MAX_M = 350;

/** How far below a barrier fish still stack, and how fast that falls away. */
const BARRIER_HALF_M = 150;
const BARRIER_MAX_M = 900;

/**
 * Metres a pixel must sit below a barrier before it counts as *below* it.
 *
 * Small on purpose, and only defensible because the elevation this is tested
 * against is the *monotonic channel profile* rather than the DTM. A metre was
 * the original figure, chosen to outrun raster noise, and on real water it
 * silenced the signal completely: Drammenselva's whole run past Hellefoss and
 * Vestfoss lies inside a two-metre band of the national 10 m model, so no
 * holding water anywhere cleared a one-metre bar. The profile removes the noise
 * instead of thresholding through it, which lets this be what it should always
 * have been — a tie-breaker, not a filter.
 */
const BARRIER_DROP_M = 0.1;

/**
 * How far from a mapped anadromous stretch a channel pixel still counts as that
 * stretch.
 *
 * `anadrome_strekninger_lin` and Elvenett are two independent digitisations of
 * the same rivers, so they do not lie on top of each other; ~60 m absorbs that
 * disagreement without letting a neighbouring tributary in.
 */
const ANADROMOUS_TOLERANCE_M = 60;

/**
 * Shade, overhang and food along a bank, 0..1, keyed by AR5 `artype`.
 *
 * Different from the lake table next door, and deliberately: a lake's bank is
 * scored for what it puts *into* the water (bog humus, farm runoff), while a
 * river's is scored for what it puts *over* it. Forest leads here — overhanging
 * cover, shade on a summer afternoon, and terrestrial insects falling in — where
 * on a lake shore it sits mid-table behind myr and farmland.
 *
 * Water classes are absent because they are not a bank, and `99 Ikke kartlagt`
 * is absent because AR5 stops at the tree line, where a missing class must read
 * as unknown rather than as barren ground.
 */
export const BANK_COVER_VALUE: Readonly<Record<number, number>> = {
  30: 1, // Skog
  60: 0.8, // Myr
  23: 0.6, // Innmarksbeite
  21: 0.5, // Fulldyrka jord
  22: 0.5, // Overflatedyrka jord
  50: 0.3, // Åpen fastmark
  11: 0.2, // Bebygd
  12: 0.15, // Samferdsel
};

/** Everything one cell's river model works from, already on the raster. */
export interface RiverInputs {
  /**
   * Real channels (`ltema` 3211) — the surface's spine. Lake through-flow
   * centrelines and fictitious connectors must already be gone: scoring the
   * latter would put the model on water that does not exist.
   */
  readonly channel: Mask;
  /**
   * Along-channel water-surface gradient in **percent**, on the channel only.
   * Null when the DTM did not answer, which costs pool and riffle both.
   */
  readonly gradientPercent: Grid | null;
  /** Change in that gradient across a reach, in percentage points. */
  readonly gradientBreakPercent: Grid | null;
  /** How far the channel turns across a reach, in degrees. */
  readonly bendDeg: Grid | null;
  /** 0..1 size of the reach, from Strahler order and catchment discharge. */
  readonly magnitude: Grid | null;
  /** Junctions where a real tributary meets a real river. */
  readonly confluences: Mask;
  /** Lake interiors — the lake model owns those pixels, so this one stays off. */
  readonly lakes: Mask;
  /** AR5 `artype` codes; nodata above the tree line and off the map. */
  readonly landCover: Grid | null;
  /**
   * Water the sea-run fish can actually reach. Null for an inland target, where
   * no such gate applies; an *empty* mask means the gate applies and this cell
   * has none — which scores nothing, and says so.
   */
  readonly anadromousReach: Mask | null;
  /** Migration barriers for this target's species. */
  readonly barriers: Mask;
  /**
   * Water-surface elevation **on the channel**, already smoothed and forced
   * downhill by the caller; null when there was no elevation to build it from.
   * Decides which side of a barrier is below it.
   *
   * Deliberately not the raw DTM. A barrier sits where the ground is steepest,
   * so a terrain sample there is drawn from bank, gorge or river more or less at
   * random — at Vestfoss the DTM covers 1.6 m to 12.6 m within three pixels,
   * which is ten times the drop being tested for. The monotonic profile can only
   * descend downstream, so comparing two points along it answers the question
   * actually being asked: which of these is further down the river.
   */
  readonly channelElevation: Grid | null;
}

export interface RiverSurface {
  /** Raw 0..1 score, nodata off the fishable corridor. */
  readonly score: Grid;
  /** Every term that contributed, for `explainPoint` and the manifest. */
  readonly terms: CombineTerm[];
  /** Was the surface restricted to mapped anadromous water? */
  readonly gated: boolean;
  readonly notes: string[];
}

const LABELS = new Map(RIVER_SIGNALS.map((s) => [s.key as RiverSignalKey, s.label]));

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
 * would fall back to "Seam: 54 %" — a number restated, which is exactly the
 * non-explanation D4 exists to rule out.
 */
export function describeRiverSignal(key: RiverSignalKey, value: number): string {
  switch (key) {
    case 'pool':
      return `slow, deep water — ${strength(value)} pool-like`;
    case 'riffle':
      return `broken, oxygenated water over a moderate grade — ${strength(value)} riffle`;
    case 'seam':
      return value > 0.05
        ? `a ${strength(value)} marked seam, where fast water meets slow`
        : 'the current runs on unchanged here';
    case 'confluence':
      return value > 0.02
        ? `${strength(value)} inside the mixing water of a tributary mouth`
        : 'no tributary joins near here';
    case 'bend':
      return value > 0.05
        ? `on a ${strength(value)} pronounced bend, where the current scours the outside deeper`
        : 'a straight reach';
    case 'magnitude':
      return value >= 0.7 ? 'a large river' : value >= 0.4 ? 'a middling river' : 'a small stream';
    case 'barrier-pool':
      // Zero covers two different facts and must not claim either: this water is
      // either nowhere near a barrier, or — the case that matters — *above* the
      // nearest one, where sea-run fish never get to.
      return value > 0.02
        ? `${strength(value)} inside the holding water below a migration barrier`
        : 'not in the holding water below a barrier';
    case 'cover':
      return `a ${strength(value)} sheltered bank — shade, overhang and insect fall`;
  }
}

/**
 * The river surface for one target.
 *
 * Terms are assembled first and combined last, so the same array that produced
 * the pixel is what the explain card reads — the card cannot drift from the
 * arithmetic, because it *is* the arithmetic.
 */
export function riverSurface(inputs: RiverInputs, opts: { species: FishSpecies }): RiverSurface {
  const { channel, lakes } = inputs;
  const { species } = opts;
  const weights = species.riverWeights;
  const notes: string[] = [];
  const terms: CombineTerm[] = [];
  const empty = (): Grid => createGrid(channel.width, channel.height, channel.cellSizeM);

  /** Add a term only if the species weights it and the input exists. */
  const add = (key: RiverSignalKey, grid: Grid | null, exclusive = false): void => {
    const weight = weights[key];
    if (!weight || !grid) return;
    terms.push({
      key,
      label: LABELS.get(key) ?? key,
      weight,
      grid,
      ...(exclusive ? { exclusive: true } : {}),
      describe: (value) => describeRiverSignal(key, value),
    });
  };

  // --- 1. The corridor: what this model is willing to speak about -----------
  // Values live on a one-pixel centreline; the corridor is where they are
  // *read*, so every channel-borne field is spread outward from its nearest
  // channel pixel. That spread is a Voronoi copy, not an interpolation — it
  // carries no gradient of its own, and so cannot manufacture structure the way
  // a focal measure over a wide band does (the trap the lake model's shoreline
  // curvature fell into).
  const toChannel = distanceToMask(channel);
  const spread = (grid: Grid | null): Grid | null => (grid ? fillNearest(grid) : null);
  const magnitudeSpread = spread(inputs.magnitude);

  const gradient = spread(inputs.gradientPercent);
  const corridor = createMask(channel.width, channel.height, channel.cellSizeM);
  const anadromousDistance = inputs.anadromousReach ? distanceToMask(inputs.anadromousReach) : null;
  for (let i = 0; i < corridor.data.length; i++) {
    const size = magnitudeSpread ? magnitudeSpread.data[i]! : 0;
    const width =
      CORRIDOR_MIN_M +
      (CORRIDOR_MAX_M - CORRIDOR_MIN_M) *
        (Number.isFinite(size) ? Math.max(0, Math.min(1, size)) : 0);
    if (toChannel.data[i]! > width) continue;
    // A lake in the middle of a river belongs to the lake model, which reads its
    // shores and its inflow mouths properly. Two surfaces claiming the same
    // pixel with different arithmetic is the one thing the split must not do.
    if (lakes.data[i] === 1) continue;
    // Whitewater is not holding water. Rather than score a waterfall low and
    // leave it on the map as a cool verdict, the model declines to speak: the
    // fish that *are* below it are found by `barrier-pool`, on the pool water
    // downstream where they actually hold.
    if (gradient && classifyChannel(gradient.data[i]!) === 'cascade') continue;
    if (anadromousDistance && anadromousDistance.data[i]! > ANADROMOUS_TOLERANCE_M) continue;
    corridor.data[i] = 1;
  }
  const inCorridor = (grid: Grid | null): Grid | null => (grid ? applyMask(grid, corridor) : null);

  if (inputs.anadromousReach) {
    const reachable = inputs.anadromousReach.data.some((v) => v === 1);
    notes.push(
      reachable
        ? `Scored only where ${species.nameNo} can reach — the mapped anadromous stretches.`
        : `No anadromous water is mapped here, so there is nothing for ${species.nameNo} to reach. Inland targets still read this network.`,
    );
  }

  // --- 2. Pool and riffle: one measurement, two mutually exclusive terms ----
  // A reach is one or the other, never both, so each term is present only on the
  // water it describes and absent — *unknown*, which `combine()` drops from the
  // denominator — on the rest. Carrying both everywhere would cap the score the
  // way averaging drop-off with shelf capped the lake model: the term for the
  // class you are *not* in contributes zero at full weight, and no water can
  // reach the hot end of the ramp.
  if (gradient) {
    const pool = membershipGrid(gradient, POOL_PERCENT);
    const riffle = membershipGrid(gradient, RIFFLE_PERCENT);
    const classOf = mapValues(gradient, (v) => (classifyChannel(v) === 'pool' ? 1 : 0));
    const onlyWhere = (grid: Grid, wantPool: boolean): Grid =>
      mapValues(grid, (v, x, y) => {
        const isPool = classOf.data[y * classOf.width + x] === 1;
        return isPool === wantPool ? v : Number.NaN;
      });
    add('pool', inCorridor(onlyWhere(pool, true)), true);
    add('riffle', inCorridor(onlyWhere(riffle, false)), true);
  } else {
    notes.push('No elevation here, so pool and riffle could not be told apart.');
  }

  // --- 3. Seams and bends: where the current does something ----------------
  add(
    'seam',
    inCorridor(
      inputs.gradientBreakPercent
        ? membershipGrid(spread(inputs.gradientBreakPercent)!, SEAM_BREAK_PERCENT)
        : null,
    ),
  );
  add(
    'bend',
    inCorridor(inputs.bendDeg ? membershipGrid(spread(inputs.bendDeg)!, BEND_DEG) : null),
  );

  // --- 4. Confluences ------------------------------------------------------
  const anyConfluence = inputs.confluences.data.some((v) => v === 1);
  add(
    'confluence',
    anyConfluence
      ? inCorridor(
          proximityField(inputs.confluences, {
            halfDistanceM: CONFLUENCE_HALF_M,
            maxDistanceM: CONFLUENCE_MAX_M,
          }),
        )
      : null,
  );

  // --- 5. River size -------------------------------------------------------
  add('magnitude', inCorridor(magnitudeSpread));

  // --- 6. Bank cover -------------------------------------------------------
  // Measured on land and read from the water: `focalMean` skips nodata rather
  // than counting it as zero, so a channel pixel inside the window of a forested
  // bank takes the forest's value. That borrowing is the point here, not a side
  // effect — AR5 classes the river itself as Ferskvann, which carries no cover.
  add(
    'cover',
    inputs.landCover
      ? inCorridor(
          focalMean(
            mapValues(inputs.landCover, (code) => BANK_COVER_VALUE[code] ?? Number.NaN),
            Math.max(1, Math.round(BANK_COVER_RADIUS_M / channel.cellSizeM)),
          ),
        )
      : null,
  );

  // --- 7. Below the barrier: the one piece of salmon knowledge a map can hold
  // Fish stack under the first wall they cannot pass, and *under* is the whole
  // claim — the water above a barrier holds nothing that came from the sea. The
  // DTM decides which side is which: each pixel is compared with the elevation
  // at its own nearest barrier, so a tributary joining below the falls is
  // included and the pool above it is not.
  if (weights['barrier-pool'] && inputs.barriers.data.some((v) => v === 1)) {
    const near = proximityField(inputs.barriers, {
      halfDistanceM: BARRIER_HALF_M,
      maxDistanceM: BARRIER_MAX_M,
    });
    if (inputs.channelElevation) {
      const { nearest } = distanceTransform(inputs.barriers);
      // Both readings come off the channel, so both must be read the same way:
      // the profile lives on a one-pixel centreline, and a corridor pixel takes
      // its own nearest channel value exactly as every other channel-borne field
      // here does. Comparing a spread value against a raw one would put the bank
      // on a different datum from the water beside it.
      const surface = fillNearest(inputs.channelElevation);
      add(
        'barrier-pool',
        inCorridor(
          mapValues(near, (v, x, y) => {
            const i = y * near.width + x;
            const source = nearest[i]!;
            if (source < 0) return 0;
            const here = surface.data[i]!;
            const wall = surface.data[source]!;
            if (!Number.isFinite(here) || !Number.isFinite(wall)) return Number.NaN;
            return here <= wall - BARRIER_DROP_M ? v : 0;
          }),
        ),
      );
    } else {
      // Without elevation the sides cannot be told apart, so the signal would
      // claim the water above the falls as well. Say nothing instead.
      notes.push(
        'No elevation here, so the water below each barrier could not be told from above it.',
      );
    }
  }

  if (terms.length === 0) {
    return {
      score: empty(),
      terms,
      gated: inputs.anadromousReach !== null,
      notes: [...notes, 'Nothing is known about this water yet.'],
    };
  }

  return {
    score: applyMask(combine(terms), corridor),
    terms,
    gated: inputs.anadromousReach !== null,
    notes,
  };
}

/**
 * A reach's absolute water quality, 0..1 — D5's *second* number: **how good is
 * this water at all**, as opposed to where in it.
 *
 * Percentile ranking guarantees a top decile whether or not one is deserved, so
 * without an absolute tier beside it a roadside ditch renders "prime" simply
 * because something has to. For flowing water the honest coarse measure is how
 * much water there is: NVE's `qnormal_mm3aar` gives mean discharge per
 * catchment, keyless, and a 300 m³/s river is better water than a 0.15 m³/s
 * brook in a way no amount of channel structure changes.
 *
 * The floor matters as much as the ceiling: a small stream is thin water, not
 * dead water — a hill burn full of small ørret is worth a evening — so this
 * bottoms out at a quarter rather than at zero.
 */
export function riverQuality(reach: {
  readonly dischargeM3s: number | null;
  /** Mapped as water sea-run fish reach: surveyed evidence that it holds them. */
  readonly anadromous: boolean;
}): number {
  const flow =
    reach.dischargeM3s === null ? null : 0.25 + 0.75 * magnitudeFromDischarge(reach.dischargeM3s);
  // A stretch on `anadrome_strekninger_lin` has been surveyed as salmon or
  // sea-trout water by the directorate. That is a stronger statement about the
  // water than our own discharge arithmetic, so it sets a floor rather than
  // being averaged into one.
  if (reach.anadromous) return Math.max(flow ?? 0, 0.7);
  return flow ?? 0.5; // neither promise nor condemn
}
