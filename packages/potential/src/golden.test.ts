/**
 * The D5 golden tests — the acceptance criteria for E1 written down as code.
 *
 * The standing requirement is that a surface must never read as "this whole
 * lake is equally good", and must be *allowed* to say "nothing special here".
 * FISH-HUNT-ENGINE.md § D5 makes that an E1 golden test rather than an E3
 * eyeball, for a good reason: percentile ranking guarantees a top decile
 * whether or not one is deserved, so the honesty of every surface the engine
 * will ever draw rests on the gate below.
 *
 * Two synthetic lakes, built from the primitives exactly as the E3 lake model
 * will build them:
 *
 *   1. a featureless pond → must report **no standout**;
 *   2. one drop-off and one inflow → must produce **exactly two maxima**.
 */
import { describe, expect, it } from 'vitest';
import {
  applyMask,
  bestSpots,
  combine,
  contrastGate,
  createMask,
  explainPoint,
  gridOf,
  maskOf,
  membershipGrid,
  mouthMask,
  nearshoreSlopePercent,
  proximityField,
  shorelineStructure,
  summariseSurface,
} from './index.js';
import type { CombineTerm, Grid, Mask } from './index.js';

const SIZE = 81;
const CELL_M = 10;
const CX = 40;
const CY = 40;
const RADIUS = 30;

/** A round lake, 600 m across, centred in the cell. */
function roundLake(): Mask {
  return maskOf(SIZE, SIZE, CELL_M, (x, y) => Math.hypot(x - CX, y - CY) <= RADIUS);
}

/**
 * Assemble a lake surface from the shore-model signals — the depth-free model
 * that runs for ~97 % of Norwegian lakes.
 */
function lakeSurface(opts: { water: Mask; terrain: Grid; streams: Mask }): {
  score: Grid;
  terms: CombineTerm[];
} {
  const { water, terrain, streams } = opts;
  const shore = shorelineStructure(water, { radiusM: 120, shoreBandM: 120 });
  const nearshore = membershipGrid(
    nearshoreSlopePercent(terrain, water, { ringM: 60, spreadM: 60, shoreBandM: 120 }),
    { min: 0, peakMin: 25, peakMax: 200, max: 400 },
  );
  const mouths = mouthMask(streams, water, { ringM: 40 });
  const inlet = applyMask(proximityField(mouths, { halfDistanceM: 60, maxDistanceM: 300 }), water);

  const terms: CombineTerm[] = [
    {
      key: 'inlet',
      label: 'Inflow mouth',
      weight: 1,
      grid: inlet,
      describe: (v) => `${Math.round(v * 100)} % of the way to an inflow mouth`,
    },
    {
      key: 'nearshore-slope',
      label: 'Nearshore drop-off',
      weight: 0.8,
      grid: nearshore,
      describe: () => 'steep shoreline terrain, so a drop-off is inferred',
    },
    { key: 'cove', label: 'Cove', weight: 0.5, grid: shore.coves },
  ];
  return { score: applyMask(combine(terms), water), terms };
}

describe('D5 — a surface must be allowed to say "nothing special here"', () => {
  it('reports no standout on a featureless pond', () => {
    const water = roundLake();
    // Flat bog all round, no inflow anywhere.
    const surface = lakeSurface({
      water,
      terrain: gridOf(SIZE, SIZE, CELL_M, () => 100),
      streams: createMask(SIZE, SIZE, CELL_M),
    });

    const gate = contrastGate(surface.score);
    expect(gate.standout).toBe(false);
    expect(gate.reason).toMatch(/No standout structure/);

    // And nothing is offered as a spot — numbering eight arbitrary points on a
    // featureless pond is precisely the failure this gate exists to prevent.
    expect(bestSpots(surface.score).spots).toEqual([]);
  });

  it('finds exactly two maxima on a lake with one drop-off and one inlet', () => {
    const water = roundLake();
    // One short cliff on the western shore; gentle bog everywhere else.
    const terrain = gridOf(SIZE, SIZE, CELL_M, (x, y) => {
      const west = x < CX - RADIUS && Math.abs(y - CY) < 5;
      return west ? 100 + (CX - RADIUS - x) * 12 : 100;
    });
    // One stream entering from the north, stopping at the shore.
    const streams = maskOf(SIZE, SIZE, CELL_M, (x, y) => x === CX && y <= CY - RADIUS + 2);

    const surface = lakeSurface({ water, terrain, streams });
    const summary = summariseSurface(surface.score, { absolute: 0.55 });

    expect(summary.contrast.standout).toBe(true);
    expect(summary.tier).toBe('good');

    // 250 m on a 600 m lake: closer than that and two "spots" are the same lie
    // seen twice. The cliff's hot band is ~200 m of shore, and its ends differ
    // by under 1 % of score — real structure, but one place to stand.
    const { spots } = bestSpots(surface.score, { minSeparationM: 250, limit: 8 });
    expect(spots).toHaveLength(2);

    // One at the northern inflow, one against the western cliff.
    const northern = spots.find((s) => s.y < CY)!;
    const western = spots.find((s) => s.x < CX - 10)!;
    expect(northern).toBeDefined();
    expect(western).toBeDefined();
    expect(Math.abs(northern.x - CX)).toBeLessThan(8);
    expect(northern.y).toBeLessThan(CY - 15);

    // Both sit at the hot end of the ramp, and the ramp says so in words.
    for (const spot of spots) expect(spot.rank).toBeGreaterThanOrEqual(0.95);

    // And each can say why it is there (D4).
    const why = explainPoint(surface.terms, northern.x, northern.y, {
      rank: summary.rank,
      vocabulary: 'fishing',
    });
    expect(why.band).toBe('prime');
    expect(why.bandLabel).toBe('Prime');
    expect(why.factors[0]!.key).toBe('inlet');
    expect(why.summary).toContain('inflow mouth');
  });

  it('ranks the whole surface, so the hot band stays rare by construction', () => {
    const water = roundLake();
    const terrain = gridOf(SIZE, SIZE, CELL_M, (x) => 100 + Math.max(0, CX - RADIUS - x) * 12);
    const streams = maskOf(SIZE, SIZE, CELL_M, (x, y) => x === CX && y <= CY - RADIUS + 2);
    const { rank } = summariseSurface(lakeSurface({ water, terrain, streams }).score);

    let valid = 0;
    let prime = 0;
    for (const v of rank.data) {
      if (!Number.isFinite(v)) continue;
      valid++;
      if (v >= 0.95) prime++;
    }
    expect(valid).toBeGreaterThan(2000);
    // "Prime" is the top ~5 % of valid cells — not a calibration hope, a property.
    expect(prime / valid).toBeLessThan(0.08);
  });
});
