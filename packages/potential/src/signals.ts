/**
 * Named signals — one function per thing the models actually claim about the
 * ground (ROADMAP § N5 / E1, design in docs/FISH-HUNT-ENGINE.md).
 *
 * `raster.ts` is arithmetic; this file is the vocabulary. A signal turns a
 * measurement (bottom slope, distance to an inflow, shoreline curvature) into a
 * **broad, smooth 0..1 field**, because the models combine fields and one-pixel
 * thresholds speckle — de-speckling afterwards was one of nodemap's recurring
 * costs. Anything that stays in physical units keeps the unit in its name
 * (`...Percent`, `...M`, `...M3s`) and is fed through `membershipGrid()` by the
 * caller, so the band in use is always visible rather than baked in.
 *
 * Nothing here knows about a species: a species is weights plus bands
 * (`species.ts`), never a code path.
 */
import type { Grid, Mask } from './raster.js';
import {
  applyMask,
  createGrid,
  createMask,
  distanceToMask,
  focalFraction,
  focalMean,
  mapValues,
  maskAt,
  maskFromGrid,
  maxOf,
  slopePercent,
} from './raster.js';

/**
 * A trapezoidal band: 0 below `min`, rising to 1 across `[peakMin, peakMax]`,
 * back to 0 at `max`. Every threshold in the engine is one of these rather than
 * a hard cut, so a fish 10 cm outside the trout band is not scored zero.
 */
export interface Band {
  readonly min: number;
  readonly peakMin: number;
  readonly peakMax: number;
  readonly max: number;
}

/** Membership of `x` in `band`, 0..1. */
export function membership(x: number, band: Band): number {
  const { min, peakMin, peakMax, max } = band;
  if (!Number.isFinite(x)) return Number.NaN;
  if (x <= min || x >= max) return 0;
  if (x < peakMin) return peakMin === min ? 1 : (x - min) / (peakMin - min);
  if (x > peakMax) return max === peakMax ? 1 : (max - x) / (max - peakMax);
  return 1;
}

/** Membership applied cell-wise; nodata stays nodata (unknown, not excluded). */
export function membershipGrid(grid: Grid, band: Band): Grid {
  return mapValues(grid, (v) => membership(v, band));
}

/** Shift a band by `deltaM` metres — how the seasonal depth shift is applied. */
export function shiftBand(band: Band, delta: number): Band {
  return {
    min: band.min + delta,
    peakMin: band.peakMin + delta,
    peakMax: band.peakMax + delta,
    max: band.max + delta,
  };
}

/**
 * Distance-decay field from a mask: 1 on the feature, halving every
 * `halfDistanceM`, and clipped to 0 beyond `maxDistanceM`.
 *
 * Zero, not nodata, past the edge: "far from any inflow" is a *known* fact
 * about the pixel, unlike an input that was never surveyed there. An empty mask
 * therefore yields an all-zero field, and a caller that means "this input is
 * missing" must leave the term out entirely rather than pass an empty mask.
 */
export function proximityField(
  mask: Mask,
  opts: { halfDistanceM: number; maxDistanceM?: number },
): Grid {
  const half = opts.halfDistanceM;
  if (!(half > 0)) throw new Error('proximityField: halfDistanceM must be positive');
  const maxDistance = opts.maxDistanceM ?? Number.POSITIVE_INFINITY;
  const distance = distanceToMask(mask);
  const out = createGrid(mask.width, mask.height, mask.cellSizeM, 0);
  for (let i = 0; i < out.data.length; i++) {
    const d = distance.data[i]!;
    // An empty mask yields +∞ everywhere, which must read as 0 ("no inflow in
    // this cell"), not as nodata — going through mapValues would silently turn
    // the whole field unknown, and unknown drops out of the combine.
    out.data[i] = !Number.isFinite(d) || d > maxDistance ? 0 : Math.pow(2, -d / half);
  }
  return out;
}

/** The inverse: 1 far away, 0 on the feature — disturbance from roads and buildings. */
export function avoidanceField(
  mask: Mask,
  opts: { halfDistanceM: number; maxDistanceM?: number },
): Grid {
  const near = proximityField(mask, opts);
  return mapValues(near, (v) => 1 - v);
}

/** Cells of `a` that touch `b` orthogonally — a forest↔farmland edge, a bog fringe. */
export function edgeMask(a: Mask, b: Mask): Mask {
  const out = createMask(a.width, a.height, a.cellSizeM);
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      if (!maskAt(a, x, y)) continue;
      if (
        maskAt(b, x - 1, y) ||
        maskAt(b, x + 1, y) ||
        maskAt(b, x, y - 1) ||
        maskAt(b, x, y + 1)
      ) {
        out.data[y * a.width + x] = 1;
      }
    }
  }
  return out;
}

/** Decay field around the boundary between two land-cover classes. */
export function edgeProximity(
  a: Mask,
  b: Mask,
  opts: { halfDistanceM: number; maxDistanceM?: number },
): Grid {
  return proximityField(edgeMask(a, b), opts);
}

/** Cells of `mask` within `bandM` metres of its own boundary — the shore band. */
export function boundaryBand(mask: Mask, bandM: number): Mask {
  const outside = createMask(mask.width, mask.height, mask.cellSizeM);
  for (let i = 0; i < mask.data.length; i++) outside.data[i] = mask.data[i] === 1 ? 0 : 1;
  const distance = distanceToMask(outside);
  const band = createMask(mask.width, mask.height, mask.cellSizeM);
  for (let i = 0; i < band.data.length; i++) {
    band.data[i] = mask.data[i] === 1 && distance.data[i]! <= bandM ? 1 : 0;
  }
  return band;
}

/** Coves, headlands and the raw curvature they come from. */
export interface ShorelineStructure {
  /**
   * −1 (water wrapping land: a point or headland tip) … +1 (land wrapping
   * water: a cove or a narrows), nodata outside the shore band.
   */
  readonly curvature: Grid;
  /** The positive half — coves, bays, narrows. */
  readonly coves: Grid;
  /** The negative half — points, headlands, island shores. */
  readonly headlands: Grid;
}

/**
 * Shoreline geometry from the water polygon alone — classic structure at zero
 * data cost, and one of the few lake signals that needs no upstream beyond the
 * lake outline itself.
 *
 * The measure is simply how much of a neighbourhood is land: a shore cell
 * inside a bay sees mostly land, one off a headland tip sees mostly water.
 * Gating to the shore band matters — without it the middle of an open lake
 * reads as a giant "headland", which is meaningless.
 */
export function shorelineStructure(
  water: Mask,
  opts: { radiusM: number; shoreBandM: number },
): ShorelineStructure {
  const radiusCells = Math.max(1, Math.round(opts.radiusM / water.cellSizeM));
  const waterFraction = focalFraction(water, radiusCells);
  const band = boundaryBand(water, opts.shoreBandM);
  const curvature = applyMask(
    mapValues(waterFraction, (f) => 1 - 2 * f),
    band,
  );
  return {
    curvature,
    coves: mapValues(curvature, (c) => Math.max(0, Math.min(1, c))),
    headlands: mapValues(curvature, (c) => Math.max(0, Math.min(1, -c))),
  };
}

/**
 * Nearshore terrain slope pushed onto the water, in **percent** — the
 * depth-free stand-in for bathymetry, and the reason the shore model works at
 * all for the ~97 % of Norwegian lakes NVE has never surveyed.
 *
 * Steepness at the waterline continues underwater: a cliff shore means a
 * drop-off, a flat bog shore means shallows. Slope is measured on the dry ring
 * just outside the shoreline, then spread across the adjacent water and gated
 * to the shore band. It is *inferred*, and every caller is expected to label it
 * as such rather than pass it off as a survey.
 */
export function nearshoreSlopePercent(
  terrain: Grid,
  water: Mask,
  opts: { ringM: number; spreadM: number; shoreBandM: number },
): Grid {
  const land = createMask(water.width, water.height, water.cellSizeM);
  for (let i = 0; i < land.data.length; i++) land.data[i] = water.data[i] === 1 ? 0 : 1;
  const toWater = distanceToMask(water);
  const ring = createMask(water.width, water.height, water.cellSizeM);
  for (let i = 0; i < ring.data.length; i++) {
    ring.data[i] = land.data[i] === 1 && toWater.data[i]! <= opts.ringM ? 1 : 0;
  }
  const ringSlope = applyMask(slopePercent(terrain), ring);
  const spreadCells = Math.max(1, Math.round(opts.spreadM / water.cellSizeM));
  return applyMask(focalMean(ringSlope, spreadCells), boundaryBand(water, opts.shoreBandM));
}

/**
 * Drop-off: steep bottom inside a fishable depth range. Where a survey exists
 * this is the strongest structure a lake has — fish hold on the break, not on
 * the slope's whole length.
 */
export function dropOffField(depthM: Grid, opts: { steepPercent: Band; depthBandM: Band }): Grid {
  const steep = membershipGrid(slopePercent(depthM), opts.steepPercent);
  const inBand = membershipGrid(depthM, opts.depthBandM);
  return mapValues(steep, (s, x, y) => {
    const b = inBand.data[y * inBand.width + x]!;
    return Number.isFinite(b) ? s * b : Number.NaN;
  });
}

/** Shelf: flat bottom in shallow water — the other half of lake structure. */
export function shelfField(depthM: Grid, opts: { flatPercent: Band; shallowM: Band }): Grid {
  const flat = membershipGrid(slopePercent(depthM), opts.flatPercent);
  const shallow = membershipGrid(depthM, opts.shallowM);
  return mapValues(flat, (f, x, y) => {
    const s = shallow.data[y * shallow.width + x]!;
    return Number.isFinite(s) ? f * s : Number.NaN;
  });
}

/**
 * `max(drop-off, shelf)` — **never their average.**
 *
 * The two are mutually exclusive by construction (steep ≠ flat), so averaging
 * made them cancel, capped the combined score below the hot end of the ramp,
 * and rendered a surveyed lake as a faint wash. nodemap paid for this lesson;
 * it is a named function here so it cannot quietly become a mean again.
 */
export function structureField(dropOff: Grid, shelf: Grid): Grid {
  return maxOf(dropOff, shelf);
}

/**
 * Mouths of streams entering or leaving a water body: the stream mask clipped
 * to a ring around the shoreline.
 *
 * This mask is the whole reason the primary lake signal works. Elvenett runs
 * every stream *straight through* the lake, so proximity to the raw network
 * lights a broad band down the middle of the water instead of the inflows. The
 * caller filters the network on `ltema` first (3211 real channel, 3103 lake
 * through-flow centreline, 3299 fictitious connector — exclude entirely);
 * clipping to the shore ring is the second half of the same defence.
 */
export function mouthMask(streams: Mask, water: Mask, opts: { ringM: number }): Mask {
  const toWater = distanceToMask(water);
  const outside = createMask(water.width, water.height, water.cellSizeM);
  for (let i = 0; i < outside.data.length; i++) outside.data[i] = water.data[i] === 1 ? 0 : 1;
  const toLand = distanceToMask(outside);
  const mouths = createMask(streams.width, streams.height, streams.cellSizeM);
  for (let i = 0; i < mouths.data.length; i++) {
    if (streams.data[i] !== 1) continue;
    const near = water.data[i] === 1 ? toLand.data[i]! : toWater.data[i]!;
    mouths.data[i] = near <= opts.ringM ? 1 : 0;
  }
  return mouths;
}

/**
 * South-facing warmth from an aspect grid, 1 due south … 0 due north. Flat
 * ground (nodata aspect) has no warmth signal and stays unknown.
 */
export function southness(aspect: Grid): Grid {
  return mapValues(aspect, (a) => (1 + Math.cos(((a - 180) * Math.PI) / 180)) / 2);
}

/**
 * Topographic position: how high a cell sits relative to its surroundings.
 * Positive = ridge or knoll, negative = hollow or draw. In metres, so callers
 * band it explicitly.
 */
export function topographicPositionM(terrain: Grid, radiusM: number): Grid {
  const radiusCells = Math.max(1, Math.round(radiusM / terrain.cellSizeM));
  const background = focalMean(terrain, radiusCells);
  return mapValues(terrain, (v, x, y) => {
    const b = background.data[y * background.width + x]!;
    return Number.isFinite(b) ? v - b : Number.NaN;
  });
}

/** Cells whose value is inside a class range — the AR5/SR16 classification helper. */
export function classMask(grid: Grid, codes: readonly number[]): Mask {
  const set = new Set(codes);
  return maskFromGrid(grid, (v) => set.has(v));
}

// ---------------------------------------------------------------------------
// Channel signals (rivers)
// ---------------------------------------------------------------------------

/**
 * Force a longitudinal profile to be non-increasing downstream.
 *
 * A DTM sampled along a channel is noisy by tens of centimetres, and water does
 * not flow uphill; without this the gradient alternates sign every few samples
 * and every reach classifies as "cascade". `profile[0]` must be the upstream
 * end.
 */
export function monotonicDownstream(profile: readonly number[]): number[] {
  const out: number[] = [];
  let running = Number.POSITIVE_INFINITY;
  for (const z of profile) {
    if (Number.isFinite(z) && z < running) running = z;
    out.push(Number.isFinite(running) ? running : Number.NaN);
  }
  return out;
}

/**
 * Along-channel water-surface gradient in **percent**, sampled over a window.
 *
 * Percent because degrees are physically wrong for water: nodemap's flat-<4° /
 * fast-≥9° split made every cell a pool, since 4° is a 7 % grade. Real channels
 * separate at fractions of a percent — see `POOL_PERCENT` / `RIFFLE_PERCENT`.
 */
export function gradientPercentProfile(
  profile: readonly number[],
  spacingM: number,
  windowM = 0,
): number[] {
  if (!(spacingM > 0)) throw new Error('gradientPercentProfile: spacingM must be positive');
  const half = Math.max(1, Math.round(windowM / spacingM / 2));
  const out: number[] = [];
  for (let i = 0; i < profile.length; i++) {
    const a = Math.max(0, i - half);
    const b = Math.min(profile.length - 1, i + half);
    const za = profile[a]!;
    const zb = profile[b]!;
    const run = (b - a) * spacingM;
    out.push(
      run > 0 && Number.isFinite(za) && Number.isFinite(zb)
        ? (Math.abs(za - zb) / run) * 100
        : Number.NaN,
    );
  }
  return out;
}

/** Slow, deep water. Pools start at fractions of a percent, not degrees. */
export const POOL_PERCENT: Band = { min: -1, peakMin: -1, peakMax: 0.15, max: 0.3 };

/** Broken, oxygenated holding water — the band that actually fishes. */
export const RIFFLE_PERCENT: Band = { min: 0.3, peakMin: 0.45, peakMax: 6.5, max: 9 };

/** Too steep to hold fish: whitewater and falls. */
export const CASCADE_PERCENT: Band = { min: 6.5, peakMin: 9, peakMax: 100, max: 100 };

export type ChannelClass = 'pool' | 'riffle' | 'cascade';

/** Classify a reach from its gradient in percent (strongest membership wins). */
export function classifyChannel(gradientPercent: number): ChannelClass {
  const pool = membership(gradientPercent, POOL_PERCENT);
  const riffle = membership(gradientPercent, RIFFLE_PERCENT);
  const cascade = membership(gradientPercent, CASCADE_PERCENT);
  if (cascade > riffle && cascade > pool) return 'cascade';
  return riffle >= pool ? 'riffle' : 'pool';
}

/** Seconds in a Julian year — the unit bridge for NVE's annual discharge figure. */
const SECONDS_PER_YEAR = 31_557_600;

/**
 * NVE Nedborfelt2 `qnormal_mm3aar` (million m³ per year) → mean discharge in
 * m³/s. Sanity check from the review: Glomma's catchment reports ≈24 362, which
 * is the ≈772 m³/s the river is known for.
 *
 * Use *this* field for river size. `arealregineenhet_km2` measures a REGINE
 * administrative sub-unit and is not a catchment area at all — misreading it as
 * one is a documented dead end.
 */
export function dischargeM3s(qnormalMm3aar: number): number {
  return (qnormalMm3aar * 1e6) / SECONDS_PER_YEAR;
}

/**
 * River magnitude 0..1 on a log scale — a 2 m³/s brook and a 700 m³/s river are
 * different animals, and the character models need to know which one they are
 * reading. 0.1 m³/s → 0, 1000 m³/s → 1.
 */
export function magnitudeFromDischarge(m3s: number): number {
  if (!(m3s > 0)) return 0;
  const t = (Math.log10(m3s) + 1) / 4;
  return Math.max(0, Math.min(1, t));
}

/**
 * Strahler order → 0..1 magnitude, for segments with no catchment figure. Order
 * 1 is a trickle; Norway's largest rivers reach 8.
 */
export function magnitudeFromStrahler(order: number): number {
  if (!Number.isFinite(order) || order < 1) return 0;
  return Math.max(0, Math.min(1, (order - 1) / 6));
}
