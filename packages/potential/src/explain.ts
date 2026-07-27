/**
 * Per-point explanation — D4 of docs/FISH-HUNT-ENGINE.md: **nothing scores
 * without saying why.**
 *
 * The score is a heatmap of an opinion, so the opinion has to be inspectable.
 * Tapping the surface answers in the same `ConditionFactor[]` shape the weather
 * card already renders — factor, rating, weight and a plain-language reason
 * naming its source — so the identify card needs no new rendering path and the
 * two halves of a spot ("prime structure · best window 05:10–08:00") read as
 * one thought.
 *
 * The headline number is the **rank within this surface**, never a fake
 * absolute: 0–100 here means "top n % of this area", which is the only claim
 * the model can honestly make.
 */
import type { ConditionFactor, FactorRating } from '@atlas/conditions';
import type { CombineTerm, Grid } from './raster.js';
import type { SurfaceBandKey, SurfaceVocabulary } from './surface.js';
import { BAND_LABELS, bandForRank } from './surface.js';

export interface PotentialExplanation {
  /** 0..100 — the percentile rank of this point within its own surface. */
  readonly score: number;
  /**
   * The ramp band, or **null where nothing is derived**.
   *
   * Null rather than the coolest band, because they mean opposite things: a
   * `quiet` pixel is a judgement ("this water is not special"), an underived one
   * is an absence ("we do not model dry land, or this lake was never reached").
   * Collapsing the two would let a client label the middle of a field "Quiet"
   * — a verdict on ground the engine never looked at.
   */
  readonly band: SurfaceBandKey | null;
  readonly bandLabel: string | null;
  readonly factors: ConditionFactor[];
  /** Labels of signals that have nothing to say here — unknown, not bad. */
  readonly missing: string[];
  readonly summary: string;
}

export interface ExplainContext {
  /** The rank grid from `summariseSurface()`. */
  readonly rank: Grid;
  readonly vocabulary?: SurfaceVocabulary;
  /**
   * Factors from outside the raster — the target's depth band, a GBIF presence
   * check, the `@atlas/conditions` window. Weighted alongside the raster terms.
   */
  readonly extra?: readonly ConditionFactor[];
}

function ratingFor(score: number): FactorRating {
  return score >= 0.7 ? 'good' : score >= 0.45 ? 'fair' : 'poor';
}

function cap(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Explain one cell of a combined surface. */
export function explainPoint(
  terms: readonly CombineTerm[],
  x: number,
  y: number,
  ctx: ExplainContext,
): PotentialExplanation {
  const vocabulary = ctx.vocabulary ?? 'fishing';
  const rank = ctx.rank.data[y * ctx.rank.width + x] ?? Number.NaN;
  const derived = Number.isFinite(rank);
  const band = derived ? bandForRank(rank).key : null;
  const bandLabel = band === null ? null : BAND_LABELS[vocabulary][band];

  const present: ConditionFactor[] = [];
  const missing: string[] = [];
  for (const term of terms) {
    const value = term.grid.data[y * term.grid.width + x];
    if (value === undefined || !Number.isFinite(value)) {
      // An `exclusive` term is absent because this pixel is in the other state,
      // not because an upstream failed. Reporting "no pool data here" about a
      // riffle the model read perfectly would be a lie about the data.
      if (!term.exclusive) missing.push(term.label);
      continue;
    }
    present.push({
      key: term.key,
      label: term.label,
      score: value,
      weight: term.weight,
      rating: ratingFor(value),
      detail: term.describe?.(value) ?? `${term.label}: ${Math.round(value * 100)} %`,
    });
  }
  for (const extra of ctx.extra ?? []) present.push(extra);

  // Renormalise over the factors that actually applied here — the same rule
  // `combine()` uses per pixel, so the card's weights match the arithmetic.
  const total = present.reduce((sum, f) => sum + f.weight, 0);
  const factors = present
    .map((f) => ({ ...f, weight: total > 0 ? f.weight / total : 0 }))
    .sort((a, b) => b.weight * b.score - a.weight * a.score);

  const top = factors[0];
  const missingNote = missing.length
    ? ` No ${missing.map((m) => m.toLowerCase()).join(', ')} data here.`
    : '';
  const summary = !derived
    ? 'Nothing is derived for this point.'
    : top
      ? `${bandLabel}. ${cap(top.detail.replace(/\.\s*$/, ''))}.${missingNote}`
      : `${bandLabel}.${missingNote}`;

  return {
    score: derived ? Math.round(rank * 100) : Number.NaN,
    band,
    bandLabel,
    factors,
    missing,
    summary,
  };
}
