/**
 * The D5 golden tests — the acceptance criteria for the lake model written down
 * as code.
 *
 * The standing requirement is that a surface must never read as "this whole lake
 * is equally good", and must be *allowed* to say "nothing special here".
 * FISH-HUNT-ENGINE.md § D5 makes that a golden test rather than an eyeball on a
 * real lake later, for a good reason: percentile ranking guarantees a top decile
 * whether or not one is deserved, so the honesty of every surface the engine
 * will ever draw rests on the gate below.
 *
 * Two synthetic lakes, run through the **real** `lakeSurface()` model rather
 * than a local imitation of it — a golden test that scores its own private
 * arithmetic proves nothing about what ships:
 *
 *   1. a featureless pond → must report **no standout**;
 *   2. one drop-off and one inflow → must produce **exactly two maxima**.
 */
import { describe, expect, it } from 'vitest';
import {
  bestSpots,
  contrastGate,
  createMask,
  explainPoint,
  fishSpecies,
  gridOf,
  lakeProductivity,
  lakeRegulation,
  lakeSurface,
  maskOf,
  summariseSurface,
} from './index.js';
import type { Grid, LakeInputs, Mask } from './index.js';

const SIZE = 81;
const CELL_M = 10;
const CX = 40;
const CY = 40;
const RADIUS = 30;

const ORRET = fishSpecies('orret')!;

/** A round lake, 600 m across, centred in the cell. */
function roundLake(): Mask {
  return maskOf(SIZE, SIZE, CELL_M, (x, y) => Math.hypot(x - CX, y - CY) <= RADIUS);
}

/** Shore-model inputs with nothing supplied but the pieces a test names. */
function inputs(over: Partial<LakeInputs> & { water: Mask }): LakeInputs {
  const empty = createMask(SIZE, SIZE, CELL_M);
  return {
    terrain: null,
    depthM: null,
    inflows: empty,
    outflows: empty,
    inflowMagnitude: null,
    landCover: null,
    productivity: null,
    regulated: null,
    ...over,
  };
}

const surfaceFor = (over: Partial<LakeInputs> & { water: Mask }) =>
  lakeSurface(inputs(over), { species: ORRET, season: 'summer' });

describe('D5 — a surface must be allowed to say "nothing special here"', () => {
  it('reports no standout on a featureless pond', () => {
    // Flat bog all round, no inflow anywhere.
    const surface = surfaceFor({
      water: roundLake(),
      terrain: gridOf(SIZE, SIZE, CELL_M, () => 100),
    });

    const gate = contrastGate(surface.score);
    expect(gate.standout).toBe(false);
    expect(gate.reason).toMatch(/No standout structure/);

    // And nothing is offered as a spot — numbering eight arbitrary points on a
    // featureless pond is precisely the failure this gate exists to prevent.
    expect(bestSpots(surface.score).spots).toEqual([]);
  });

  it('finds exactly two maxima on a lake with one drop-off and one inlet', () => {
    // One short cliff on the western shore; gentle bog everywhere else.
    const terrain = gridOf(SIZE, SIZE, CELL_M, (x, y) => {
      const west = x < CX - RADIUS && Math.abs(y - CY) < 5;
      return west ? 100 + (CX - RADIUS - x) * 12 : 100;
    });
    // One stream entering from the north, stopping at the shore.
    const inflows = maskOf(SIZE, SIZE, CELL_M, (x, y) => x === CX && y <= CY - RADIUS + 2);

    const surface = surfaceFor({ water: roundLake(), terrain, inflows });
    const summary = summariseSurface(surface.score, { absolute: 0.55 });

    expect(summary.contrast.standout).toBe(true);
    expect(summary.tier).toBe('good');
    // No survey here, so the shore model ran and says so by omission.
    expect(surface.bathymetric).toBe(false);
    expect(surface.depthBandLabel).toBeNull();

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
    const terrain = gridOf(SIZE, SIZE, CELL_M, (x) => 100 + Math.max(0, CX - RADIUS - x) * 12);
    const inflows = maskOf(SIZE, SIZE, CELL_M, (x, y) => x === CX && y <= CY - RADIUS + 2);
    const { rank } = summariseSurface(surfaceFor({ water: roundLake(), terrain, inflows }).score);

    let valid = 0;
    let prime = 0;
    for (const v of rank.data) {
      if (!Number.isFinite(v)) continue;
      valid++;
      if (v >= 0.95) prime++;
    }
    expect(valid).toBeGreaterThan(1000);
    // "Prime" is the top ~5 % of valid cells — not a calibration hope, a property.
    expect(prime / valid).toBeLessThan(0.08);
  });
});

describe('the lake model chooses its half by data, not by configuration', () => {
  const water = roundLake();
  /** A bowl: 0 m at the bank, deepest in the middle. */
  const depthM = (peak: number): Grid =>
    gridOf(SIZE, SIZE, CELL_M, (x, y) => {
      const r = Math.hypot(x - CX, y - CY);
      return r <= RADIUS ? (1 - r / RADIUS) * peak : Number.NaN;
    });

  it('reads a survey when one exists, and names the band in use', () => {
    const surface = lakeSurface(inputs({ water, depthM: depthM(20) }), {
      species: ORRET,
      season: 'summer',
    });
    expect(surface.bathymetric).toBe(true);
    // Ørret's 1–6 m band shifts 3 m deeper in summer, and the label says so
    // rather than the shift happening silently.
    expect(surface.depthBandLabel).toBe('Summer band 4–9 m');
    expect(surface.terms.map((t) => t.key)).toEqual(
      expect.arrayContaining(['structure', 'depth-band']),
    );
  });

  it('scores open water only where a survey reaches it', () => {
    const mid = CY * SIZE + CX;
    // Shore model: the middle of a 600 m lake is 300 m out, past the 150 m
    // band, so it is *unknown* and draws nothing — not a cool-coloured verdict.
    expect(Number.isNaN(surfaceFor({ water }).score.data[mid]!)).toBe(true);
    // Bathymetric model: the survey reaches the middle, so it is scored.
    const surveyed = lakeSurface(inputs({ water, depthM: depthM(20) }), {
      species: ORRET,
      season: 'summer',
    });
    expect(Number.isFinite(surveyed.score.data[mid]!)).toBe(true);
  });

  it('never scores dry land', () => {
    const surface = surfaceFor({ water, terrain: gridOf(SIZE, SIZE, CELL_M, () => 100) });
    expect(Number.isNaN(surface.score.data[0]!)).toBe(true);
  });

  it('leaves a term out entirely when its input is missing', () => {
    const withoutDtm = surfaceFor({ water });
    expect(withoutDtm.terms.map((t) => t.key)).not.toContain('nearshore-slope');
    expect(withoutDtm.notes.join(' ')).toMatch(/No elevation here/);

    const withDtm = surfaceFor({ water, terrain: gridOf(SIZE, SIZE, CELL_M, () => 100) });
    expect(withDtm.terms.map((t) => t.key)).toContain('nearshore-slope');
  });

  it('weights a big inflow above a trickle', () => {
    const inflows = maskOf(SIZE, SIZE, CELL_M, (x, y) => x === CX && y <= CY - RADIUS + 2);
    const at = (magnitude: number | null) => {
      const surface = lakeSurface(
        inputs({
          water,
          inflows,
          inflowMagnitude: magnitude === null ? null : gridOf(SIZE, SIZE, CELL_M, () => magnitude),
        }),
        { species: ORRET, season: 'summer' },
      );
      const term = surface.terms.find((t) => t.key === 'inlet')!;
      return term.grid.data[(CY - RADIUS + 3) * SIZE + CX]!;
    };
    // A 4th-order river outranks a first-order trickle at the same distance.
    expect(at(1)).toBeGreaterThan(at(0.2));
    // An unattributed inflow is still an inflow: discounted, never demoted to
    // the trickle it might not be.
    expect(at(null)).toBeGreaterThan(at(0.2));
    expect(at(null)).toBeLessThanOrEqual(at(1));
  });
});

describe('the absolute tier — D5’s second number', () => {
  it('rates a lowland lake with a large catchment above a high mountain tarn', () => {
    const lowland = lakeProductivity({ elevationM: 90, areaKm2: 0.8, catchmentKm2: 40 });
    const tarn = lakeProductivity({ elevationM: 1300, areaKm2: 0.05, catchmentKm2: 0.4 });
    expect(lowland).toBeGreaterThan(tarn);
    expect(lowland).toBeGreaterThan(0.5);
    expect(tarn).toBeLessThan(0.35);
  });

  it('neither promises nor condemns a lake the register says nothing about', () => {
    expect(lakeProductivity({ elevationM: null, areaKm2: null, catchmentKm2: null })).toBe(0.5);
  });

  it('marks a regulated lake down as a low value, never a negative weight', () => {
    expect(lakeRegulation('InnsjøRegulert')).toBeLessThan(0.5);
    expect(lakeRegulation('Innsjø')).toBe(1);
    expect(lakeRegulation(null)).toBe(1);
  });
});
