/**
 * How a finished surface is read: the percentile ramp, the words on the legend,
 * the absolute water-quality tier that keeps ranking honest, the contrast gate
 * that lets a surface say "nothing special here", and the best-spots search
 * that only runs once the gate agrees there is something to find.
 *
 * This is D5 of docs/FISH-HUNT-ENGINE.md, and the reason it is E1 rather than
 * E3 is that "a surface must never read as *this whole lake is equally good*"
 * is a **testable property**. It is tested in `golden.test.ts` against synthetic
 * grids, not eyeballed on a real lake later.
 *
 * Two numbers, kept honestly apart:
 *
 * - **Where in this water** — relative, sharp, the percentile rank. Guarantees
 *   contrast by construction, which is exactly why it cannot be trusted alone:
 *   ranking always produces a top decile, even on a featureless pond.
 * - **How good is this water at all** — absolute, coarse, few tiers, and
 *   supplied by the model from real priors (lake register, productivity), never
 *   inferred from the surface's own shape.
 */
import type { Grid, LocalMax } from './raster.js';
import { gridHistogram, gridStats, localMaxima, percentileRank, quantile } from './raster.js';

/** RGBA, 0..255. */
export type Rgba = readonly [number, number, number, number];

export type SurfaceBandKey = 'quiet' | 'worth-a-look' | 'promising' | 'prime';

export interface SurfaceBand {
  readonly key: SurfaceBandKey;
  /** Lowest percentile rank in this band. */
  readonly minRank: number;
  readonly color: Rgba;
}

/**
 * The ramp, in percentile ranks — so "prime" is the top 5 % of valid cells by
 * construction. Capping the hot area is the point: prime is rare by definition,
 * and a ramp that hands out red generously is a ramp nobody believes twice.
 *
 * Bands are stepped rather than interpolated so that what the legend says in
 * words is exactly what the pixels mean.
 */
export const SURFACE_BANDS: readonly SurfaceBand[] = [
  { key: 'quiet', minRank: 0, color: [70, 100, 130, 40] },
  { key: 'worth-a-look', minRank: 0.6, color: [90, 170, 140, 95] },
  { key: 'promising', minRank: 0.85, color: [232, 168, 56, 150] },
  { key: 'prime', minRank: 0.95, color: [216, 62, 48, 195] },
];

/** Which vocabulary a surface speaks — a fisher casts, a hunter looks. */
export type SurfaceVocabulary = 'fishing' | 'hunt';

/** Legend words. The score is never shown as a fake-absolute "78/100". */
export const BAND_LABELS: Record<SurfaceVocabulary, Record<SurfaceBandKey, string>> = {
  fishing: {
    quiet: 'Quiet',
    'worth-a-look': 'Worth a cast',
    promising: 'Promising water',
    prime: 'Prime',
  },
  hunt: {
    quiet: 'Quiet',
    'worth-a-look': 'Worth a look',
    promising: 'Promising ground',
    prime: 'Prime',
  },
};

/** Band for a percentile rank (0..1). */
export function bandForRank(rank: number): SurfaceBand {
  let band = SURFACE_BANDS[0]!;
  for (const candidate of SURFACE_BANDS) {
    if (rank >= candidate.minRank) band = candidate;
  }
  return band;
}

/** Legend text for a rank in the given vocabulary. */
export function labelForRank(rank: number, vocabulary: SurfaceVocabulary = 'fishing'): string {
  return BAND_LABELS[vocabulary][bandForRank(rank).key];
}

/** Colour for a rank; fully transparent for nodata. */
export function rampColor(rank: number): Rgba {
  if (!Number.isFinite(rank)) return [0, 0, 0, 0];
  return bandForRank(rank).color;
}

/**
 * Render a rank grid to row-major RGBA bytes, ready for the PNG encode in the
 * backend's derive service (E2). Nodata is transparent, so an unsurveyed lake
 * shows the basemap rather than a "no data" wash.
 */
export function renderRamp(rank: Grid): Uint8ClampedArray {
  const out = new Uint8ClampedArray(rank.width * rank.height * 4);
  for (let i = 0; i < rank.data.length; i++) {
    const [r, g, b, a] = rampColor(rank.data[i]!);
    const o = i * 4;
    out[o] = r;
    out[o + 1] = g;
    out[o + 2] = b;
    out[o + 3] = a;
  }
  return out;
}

/** What the contrast gate found. */
export interface ContrastReport {
  /** Does this surface have structure worth pointing at? */
  readonly standout: boolean;
  readonly validCells: number;
  /** Median raw score. */
  readonly median: number;
  /** Raw score at the hot quantile (top 5 % by default). */
  readonly hotThreshold: number;
  /** `hotThreshold − median`, on the raw 0..1 score. */
  readonly spread: number;
  /** Plain-language verdict, shown to the user as-is. */
  readonly reason: string;
}

export interface ContrastOptions {
  /** Quantile that counts as "hot". Default 0.95 — prime is the top 5 %. */
  readonly hotQuantile?: number;
  /** Minimum hot−median separation on the raw score. Default 0.08. */
  readonly minSpread?: number;
  /** Below this many valid cells there is nothing to rank. Default 64. */
  readonly minValidCells?: number;
}

/**
 * Decide whether a surface has real structure, or is just noise being ranked.
 *
 * Percentile ranking guarantees a top decile whether or not one is deserved, so
 * this is its counterweight: if the hot quantile is not meaningfully separated
 * from the median on the **raw** score, the surface says *"no standout
 * structure here"* and is drawn flat and cool. A model that can admit it found
 * nothing is more trustworthy than one that always finds something — and a
 * blank answer that explains itself is not a broken layer.
 */
export function contrastGate(score: Grid, opts: ContrastOptions = {}): ContrastReport {
  const hotQuantile = opts.hotQuantile ?? 0.95;
  const minSpread = opts.minSpread ?? 0.08;
  const minValidCells = opts.minValidCells ?? 64;

  const stats = gridStats(score);
  if (stats.count < minValidCells) {
    return {
      standout: false,
      validCells: stats.count,
      median: stats.count > 0 ? stats.mean : Number.NaN,
      hotThreshold: Number.NaN,
      spread: 0,
      reason:
        stats.count === 0
          ? 'No data for this area yet.'
          : 'Too little of this area is covered to rank anything.',
    };
  }

  const histogram = gridHistogram(score);
  const median = quantile(histogram, 0.5);
  const hotThreshold = quantile(histogram, hotQuantile);
  const spread = hotThreshold - median;
  const standout = spread >= minSpread;
  const hotPercent = Math.round((1 - hotQuantile) * 100);
  return {
    standout,
    validCells: stats.count,
    median,
    hotThreshold,
    spread,
    reason: standout
      ? `The best ${hotPercent} % stands clear of the rest of this area.`
      : 'No standout structure here — this area reads much the same throughout.',
  };
}

/** How good the water or ground is *at all* — absolute, coarse, four tiers. */
export type QualityTier = 'poor' | 'fair' | 'good' | 'excellent';

export const QUALITY_TIER_LABELS: Record<QualityTier, string> = {
  poor: 'Marginal',
  fair: 'Ordinary',
  good: 'Good',
  excellent: 'Excellent',
};

/** Tier for an absolute 0..1 quality score supplied by the model's priors. */
export function qualityTier(absolute: number): QualityTier {
  if (!Number.isFinite(absolute)) return 'fair';
  if (absolute < 0.3) return 'poor';
  if (absolute < 0.5) return 'fair';
  if (absolute < 0.7) return 'good';
  return 'excellent';
}

/** A ranked surface, ready to render and to read. */
export interface SurfaceSummary {
  /** Percentile rank of every valid cell — what the ramp draws. */
  readonly rank: Grid;
  readonly contrast: ContrastReport;
  /**
   * Absolute tier, or null when the model supplied no prior. Null is honest:
   * an absolute tier inferred from the surface's own mean would be circular.
   */
  readonly tier: QualityTier | null;
  readonly tierLabel: string | null;
}

/** Rank a raw score surface and run the gate over it. */
export function summariseSurface(
  score: Grid,
  opts: ContrastOptions & { absolute?: number } = {},
): SurfaceSummary {
  const contrast = contrastGate(score, opts);
  const tier = opts.absolute === undefined ? null : qualityTier(opts.absolute);
  return {
    rank: percentileRank(score),
    contrast,
    tier,
    tierLabel: tier === null ? null : QUALITY_TIER_LABELS[tier],
  };
}

/** A spot worth walking to. */
export interface Spot extends LocalMax {
  /** Percentile rank of this spot within its surface, 0..1. */
  readonly rank: number;
}

export interface BestSpotsResult {
  readonly spots: Spot[];
  readonly contrast: ContrastReport;
}

/**
 * Up to `limit` local maxima of a surface, thinned so they are real
 * alternatives rather than neighbours of one hotspot — the raw material for
 * "best spots in view" (E6).
 *
 * The gate runs first and its verdict is binding: on a flat surface this
 * returns **no spots at all**, because numbering eight arbitrary points on a
 * featureless pond is precisely the failure D5 exists to prevent.
 */
export function bestSpots(
  score: Grid,
  opts: ContrastOptions & { limit?: number; minSeparationM?: number } = {},
): BestSpotsResult {
  const contrast = contrastGate(score, opts);
  if (!contrast.standout) return { spots: [], contrast };

  const minSeparationM = opts.minSeparationM ?? 150;
  const maxima = localMaxima(score, {
    minSeparationCells: Math.max(1, minSeparationM / score.cellSizeM),
    minValue: contrast.hotThreshold,
    limit: opts.limit ?? 8,
  });
  const rank = percentileRank(score);
  return {
    spots: maxima.map((m) => ({ ...m, rank: rank.data[m.y * rank.width + m.x]! })),
    contrast,
  };
}
