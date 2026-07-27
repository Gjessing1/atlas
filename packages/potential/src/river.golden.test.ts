/**
 * The golden tests for the river model — E4's acceptance criteria written down
 * as code, the way `golden.test.ts` holds the lake model's.
 *
 * The same D5 requirement applies and is the reason these are tests rather than
 * a later eyeball on a real river: a surface must never read as "this whole
 * river is equally good", and must be *allowed* to say nothing stands out.
 * Percentile ranking manufactures a top decile on any input, so every honest
 * thing the river surface will ever say rests on the arithmetic below.
 *
 * A synthetic river, run through the **real** `riverSurface()` — a golden test
 * that scores its own private imitation proves nothing about what ships.
 */
import { describe, expect, it } from 'vitest';
import {
  bestSpots,
  classifyChannel,
  contrastGate,
  createGrid,
  createMask,
  curvatureDegProfile,
  describeRiverSignal,
  explainPoint,
  fishSpecies,
  gradientBreakProfile,
  maskOf,
  monotonicDownstream,
  resampleLine,
  riverQuality,
  riverSurface,
  sampleAlong,
  smoothProfile,
  summariseSurface,
} from './index.js';
import type { Grid, Mask, RiverInputs } from './index.js';

const SIZE = 121;
const CELL_M = 10;
/** The channel runs straight down column `CX`, top (upstream) to bottom. */
const CX = 60;

const ORRET = fishSpecies('orret')!;
const LAKS = fishSpecies('laks')!;

/** A one-pixel channel down the middle of the raster. */
function channelMask(): Mask {
  return maskOf(SIZE, SIZE, CELL_M, (x) => x === CX);
}

/** Values burned on the channel only; nodata everywhere else. */
function onChannel(valueAt: (y: number) => number): Grid {
  const grid = createGrid(SIZE, SIZE, CELL_M);
  for (let y = 0; y < SIZE; y++) grid.data[y * SIZE + CX] = valueAt(y);
  return grid;
}

function inputs(over: Partial<RiverInputs> = {}): RiverInputs {
  const empty = createMask(SIZE, SIZE, CELL_M);
  return {
    channel: channelMask(),
    gradientPercent: null,
    gradientBreakPercent: null,
    bendDeg: null,
    magnitude: null,
    confluences: empty,
    lakes: empty,
    landCover: null,
    anadromousReach: null,
    barriers: empty,
    channelElevation: null,
    ...over,
  };
}

/**
 * A river that runs 200 m of riffle, then 400 m of flat pool, then riffle again
 * — the profile every reach-scale signal here exists to read.
 */
function stepGradient(): Grid {
  return onChannel((y) => (y > 40 && y < 80 ? 0.05 : 2.5));
}

const surfaceFor = (over: Partial<RiverInputs>, species = ORRET) =>
  riverSurface(inputs(over), { species });

describe('the channel profile, measured along the water', () => {
  it('reads pool and riffle in percent, where degrees would call everything a pool', () => {
    // Real channels separate at fractions of a percent.
    expect(classifyChannel(0.1)).toBe('pool');
    expect(classifyChannel(2)).toBe('riffle');
    // nodemap classified in degrees and called anything under 4° flat. 4° is a
    // 7 % grade — fast, broken water — so every cell came back "pool" and the
    // layer rendered as a featureless ribbon.
    expect(classifyChannel(7)).toBe('riffle');
    expect(classifyChannel(12)).toBe('cascade');
  });

  it('forces the profile downhill before measuring, and smooths first', () => {
    // A DTM over water is noisy by tens of centimetres, and the running minimum
    // is unforgiving of it: the single low sample at index 3 pins the profile
    // and the next four samples read as dead-flat pool.
    const noisy = [100, 99.6, 99.2, 97.5, 98.4, 98, 97.6, 97.2];
    const raw = monotonicDownstream(noisy);
    expect(raw[4]).toBe(97.5);
    expect(raw[6]).toBe(raw[4]);

    // Averaged first, the same channel keeps descending through the noise.
    const smoothed = monotonicDownstream(smoothProfile(noisy, 3));
    expect(smoothed[6]).toBeLessThan(smoothed[4]!);
  });

  it('finds the seam where the grade changes, not where it is merely steep', () => {
    // 300 m of riffle running out into 300 m of pool, sampled every 30 m.
    const gradient = [...Array(10).fill(2.5), ...Array(10).fill(0.05)] as number[];
    const breaks = gradientBreakProfile(gradient, 30, 120);
    const insideRiffle = breaks[2]!;
    const atTransition = breaks[10]!;
    expect(atTransition).toBeGreaterThan(2);
    // Steady riffle is not a seam, however fast it runs.
    expect(insideRiffle).toBe(0);
  });

  it('measures a bend across a reach, so a wobbly digitisation is not one', () => {
    const straight = Array.from({ length: 21 }, (_, i) => ({ x: i, y: i % 2 === 0 ? 0 : 0.05 }));
    const corner = Array.from({ length: 21 }, (_, i) =>
      i < 10 ? { x: i, y: 0 } : { x: 10, y: i - 10 },
    );
    const window = 120;
    expect(
      Math.max(...curvatureDegProfile(straight, 30, window).filter(Number.isFinite)),
    ).toBeLessThan(10);
    expect(
      Math.max(...curvatureDegProfile(corner, 30, window).filter(Number.isFinite)),
    ).toBeGreaterThan(70);
  });

  it('resamples to even spacing, keeping the network nodes it was handed', () => {
    // Densely digitised head, one long generalised tail — Elvenett all over.
    const line = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 20, y: 0 },
    ];
    const samples = resampleLine(line, 3);
    expect(samples[0]).toEqual({ x: 0, y: 0 });
    expect(samples[samples.length - 1]).toEqual({ x: 20, y: 0 });
    for (let i = 1; i < samples.length - 1; i++) {
      expect(
        Math.hypot(samples[i]!.x - samples[i - 1]!.x, samples[i]!.y - samples[i - 1]!.y),
      ).toBeCloseTo(3, 6);
    }
  });

  it('samples a grid along a path', () => {
    const grid = onChannel((y) => y);
    expect(
      sampleAlong(grid, [
        { x: CX, y: 10 },
        { x: CX, y: 20 },
      ]),
    ).toEqual([10, 20]);
  });
});

describe('D5 — a river surface must be allowed to say "nothing special here"', () => {
  it('reports no standout on a uniform channel', () => {
    const surface = surfaceFor({
      gradientPercent: onChannel(() => 2.5),
      gradientBreakPercent: onChannel(() => 0),
      bendDeg: onChannel(() => 0),
    });
    const gate = contrastGate(surface.score);
    expect(gate.standout).toBe(false);
    expect(gate.reason).toMatch(/No standout structure/);
    expect(bestSpots(surface.score).spots).toEqual([]);
  });

  it('finds the pool and its seams on a river that has some', () => {
    const gradient = stepGradient();
    const surface = surfaceFor({
      gradientPercent: gradient,
      gradientBreakPercent: onChannel((y) =>
        Math.abs(y - 40) < 3 || Math.abs(y - 80) < 3 ? 2.4 : 0,
      ),
      bendDeg: onChannel(() => 0),
    });
    const summary = summariseSurface(surface.score);
    expect(summary.contrast.standout).toBe(true);

    // The pool and the riffle are told apart, and each pixel carries exactly one
    // of the two: a reach is not both, and scoring it as both would cap the
    // whole surface below the hot end of the ramp.
    const pool = surface.terms.find((t) => t.key === 'pool')!;
    const riffle = surface.terms.find((t) => t.key === 'riffle')!;
    const at = (grid: Grid, y: number) => grid.data[y * SIZE + CX]!;
    expect(at(pool.grid, 60)).toBeGreaterThan(0.9);
    expect(Number.isNaN(at(riffle.grid, 60))).toBe(true);
    expect(at(riffle.grid, 20)).toBeGreaterThan(0.9);
    expect(Number.isNaN(at(pool.grid, 20))).toBe(true);

    // And the hot end is where the seam is, which is what the model claims.
    const { spots } = bestSpots(surface.score, { minSeparationM: 150, limit: 8 });
    expect(spots.length).toBeGreaterThan(0);
    for (const spot of spots) expect(Math.abs(spot.x - CX)).toBeLessThanOrEqual(9);
  });

  it('keeps the hot band rare by construction', () => {
    const { rank } = summariseSurface(
      surfaceFor({
        gradientPercent: stepGradient(),
        gradientBreakPercent: onChannel((y) => (Math.abs(y - 40) < 3 ? 2.4 : 0)),
      }).score,
    );
    let valid = 0;
    let prime = 0;
    for (const v of rank.data) {
      if (!Number.isFinite(v)) continue;
      valid++;
      if (v >= 0.95) prime++;
    }
    expect(valid).toBeGreaterThan(500);
    expect(prime / valid).toBeLessThan(0.1);
  });
});

describe('what the river model refuses to score', () => {
  it('leaves whitewater unscored rather than colouring it cool', () => {
    // A 20 % grade is a cascade — no fish holds there, and a low score would
    // still be a verdict on water the model has nothing to say about.
    const surface = surfaceFor({ gradientPercent: onChannel((y) => (y < 60 ? 20 : 2.5)) });
    expect(Number.isNaN(surface.score.data[30 * SIZE + CX]!)).toBe(true);
    expect(Number.isFinite(surface.score.data[90 * SIZE + CX]!)).toBe(true);
  });

  it('stays off the lakes, which belong to the lake model', () => {
    const lakes = maskOf(SIZE, SIZE, CELL_M, (_, y) => y > 50 && y < 70);
    const surface = surfaceFor({ gradientPercent: onChannel(() => 2.5), lakes });
    expect(Number.isNaN(surface.score.data[60 * SIZE + CX]!)).toBe(true);
    expect(Number.isFinite(surface.score.data[20 * SIZE + CX]!)).toBe(true);
  });

  it('never scores dry ground far from any channel', () => {
    const surface = surfaceFor({ gradientPercent: onChannel(() => 2.5) });
    expect(Number.isNaN(surface.score.data[60 * SIZE + 5]!)).toBe(true);
  });

  it('widens its corridor with the river, because Elvenett carries no width', () => {
    const brook = surfaceFor({
      gradientPercent: onChannel(() => 2.5),
      magnitude: onChannel(() => 0),
    });
    const glomma = surfaceFor({
      gradientPercent: onChannel(() => 2.5),
      magnitude: onChannel(() => 1),
    });
    const width = (g: Grid) => {
      let n = 0;
      for (let x = 0; x < SIZE; x++) if (Number.isFinite(g.data[60 * SIZE + x]!)) n++;
      return n * CELL_M;
    };
    expect(width(brook.score)).toBeLessThan(60);
    expect(width(glomma.score)).toBeGreaterThan(150);
  });

  it('leaves a term out entirely when its input is missing', () => {
    const noDtm = surfaceFor({});
    expect(noDtm.terms.map((t) => t.key)).not.toContain('pool');
    expect(noDtm.terms.map((t) => t.key)).not.toContain('riffle');
    expect(noDtm.notes.join(' ')).toMatch(/pool and riffle could not be told apart/);
  });
});

describe('the anadromous half — a gate and a barrier, nothing else', () => {
  const gradient = () => onChannel(() => 2.5);
  /** Only the lower half of the channel is mapped as anadromous water. */
  const reach = () => maskOf(SIZE, SIZE, CELL_M, (x, y) => x === CX && y >= 60);

  it('scores only water the fish can reach', () => {
    const surface = surfaceFor({ gradientPercent: gradient(), anadromousReach: reach() }, LAKS);
    expect(surface.gated).toBe(true);
    expect(Number.isFinite(surface.score.data[80 * SIZE + CX]!)).toBe(true);
    expect(Number.isNaN(surface.score.data[20 * SIZE + CX]!)).toBe(true);
  });

  it('reads the whole network for an inland target on the same water', () => {
    const surface = surfaceFor({ gradientPercent: gradient() }, ORRET);
    expect(surface.gated).toBe(false);
    expect(Number.isFinite(surface.score.data[20 * SIZE + CX]!)).toBe(true);
  });

  it('says so plainly when a cell holds no anadromous water at all', () => {
    const surface = surfaceFor(
      { gradientPercent: gradient(), anadromousReach: createMask(SIZE, SIZE, CELL_M) },
      LAKS,
    );
    expect(surface.notes.join(' ')).toMatch(/No anadromous water is mapped here/);
    expect(surface.score.data.every((v) => Number.isNaN(v))).toBe(true);
  });

  it('boosts the water below a barrier and never the water above it', () => {
    // Water falling to the south, with the barrier halfway down.
    const channelElevation = createGrid(SIZE, SIZE, CELL_M, 0);
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) channelElevation.data[y * SIZE + x] = 300 - y * 2;
    }
    const barriers = maskOf(SIZE, SIZE, CELL_M, (x, y) => x === CX && y === 60);
    const surface = surfaceFor(
      { gradientPercent: gradient(), channelElevation, barriers, anadromousReach: null },
      LAKS,
    );
    const term = surface.terms.find((t) => t.key === 'barrier-pool')!;
    expect(term).toBeDefined();
    const below = term.grid.data[65 * SIZE + CX]!;
    const above = term.grid.data[55 * SIZE + CX]!;
    // Same distance from the falls, opposite sides of it. Fish stack under a
    // wall, never over it, and the channel profile is what knows which is which.
    expect(below).toBeGreaterThan(0.5);
    expect(above).toBe(0);
  });

  /**
   * The live drive's second finding. Drammenselva past Hellefoss and Vestfoss
   * lies inside a two-metre band of the national 10 m model, so a threshold set
   * to outrun DTM noise silenced the signal on every real barrier in the cell —
   * a term carrying the joint-heaviest weight for laks, contributing nothing,
   * with nothing in the output to say so. The profile is monotonic, so a nearly
   * flat river must still resolve its own two sides.
   */
  it('still tells the sides apart on water that barely falls at all', () => {
    const channelElevation = createGrid(SIZE, SIZE, CELL_M, 0);
    for (let y = 0; y < SIZE; y++) {
      // 2 cm a pixel — a couple of metres of fall across the whole cell.
      for (let x = 0; x < SIZE; x++) channelElevation.data[y * SIZE + x] = 4 - y * 0.02;
    }
    const barriers = maskOf(SIZE, SIZE, CELL_M, (x, y) => x === CX && y === 60);
    const surface = surfaceFor(
      { gradientPercent: gradient(), channelElevation, barriers, anadromousReach: null },
      LAKS,
    );
    const term = surface.terms.find((t) => t.key === 'barrier-pool')!;
    expect(term).toBeDefined();
    expect(term.grid.data[70 * SIZE + CX]!).toBeGreaterThan(0.4);
    expect(term.grid.data[50 * SIZE + CX]!).toBe(0);
  });

  it('says nothing about barriers rather than guessing without elevation', () => {
    const barriers = maskOf(SIZE, SIZE, CELL_M, (x, y) => x === CX && y === 60);
    const surface = surfaceFor({ gradientPercent: gradient(), barriers }, LAKS);
    expect(surface.terms.map((t) => t.key)).not.toContain('barrier-pool');
    expect(surface.notes.join(' ')).toMatch(/below each barrier could not be told from above/);
  });
});

describe('the explain card reads the same arithmetic that drew the pixel', () => {
  it('names the strongest signal in words, not as a restated percentage', () => {
    const gradient = stepGradient();
    const surface = surfaceFor({
      gradientPercent: gradient,
      gradientBreakPercent: onChannel((y) => (Math.abs(y - 40) < 3 ? 2.4 : 0)),
      bendDeg: onChannel(() => 0),
    });
    const summary = summariseSurface(surface.score);
    const why = explainPoint(surface.terms, CX, 60, { rank: summary.rank, vocabulary: 'fishing' });
    expect(why.factors.length).toBeGreaterThan(0);
    // Weights are renormalised over the factors that actually applied here.
    expect(why.factors.reduce((sum, f) => sum + f.weight, 0)).toBeCloseTo(1, 5);
    expect(why.summary).toMatch(/pool|seam|riffle|bend/);
  });

  it('gives every signal a sentence a person could have written', () => {
    for (const key of [
      'pool',
      'riffle',
      'seam',
      'confluence',
      'bend',
      'magnitude',
      'barrier-pool',
      'cover',
    ] as const) {
      const text = describeRiverSignal(key, 0.8);
      expect(text).toBeTruthy();
      expect(text).not.toMatch(/%/);
    }
    // Size is described as what it is, not as a fraction of an unstated maximum.
    expect(describeRiverSignal('magnitude', 0.9)).toMatch(/large river/);
    expect(describeRiverSignal('magnitude', 0.1)).toMatch(/small stream/);
  });
});

describe('the absolute tier — D5’s second number for flowing water', () => {
  it('rates a big river above a brook, and neither at zero', () => {
    const glomma = riverQuality({ dischargeM3s: 772, anadromous: false });
    const brook = riverQuality({ dischargeM3s: 0.15, anadromous: false });
    expect(glomma).toBeGreaterThan(brook);
    expect(brook).toBeGreaterThanOrEqual(0.25);
    expect(glomma).toBeGreaterThan(0.9);
  });

  it('treats surveyed anadromous water as good water on the directorate’s say-so', () => {
    const small = riverQuality({ dischargeM3s: 0.4, anadromous: false });
    const salmon = riverQuality({ dischargeM3s: 0.4, anadromous: true });
    expect(salmon).toBeGreaterThan(small);
    expect(salmon).toBeGreaterThanOrEqual(0.7);
  });

  it('neither promises nor condemns water NVE gives no discharge for', () => {
    expect(riverQuality({ dischargeM3s: null, anadromous: false })).toBe(0.5);
  });
});
