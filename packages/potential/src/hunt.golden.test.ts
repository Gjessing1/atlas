/**
 * The golden tests for the hunt model — E5's acceptance criteria written down as
 * code, the way `golden.test.ts` holds the lake model's and `river.golden.test.ts`
 * the river's.
 *
 * D5's requirement is sharper here than anywhere else in the engine, because a
 * hunt surface covers the *whole cell* rather than a shore band or a channel
 * corridor. A hundred square kilometres of ordinary spruce forest must be
 * allowed to come back saying nothing stands out — percentile ranking will
 * happily manufacture a top 5 % out of rounding noise, and on a surface this
 * large that would put eight numbered "best stands" on ground with no structure
 * whatsoever.
 *
 * Synthetic ground, run through the **real** `huntSurface()`: a golden test that
 * scores its own private imitation proves nothing about what ships.
 */
import { describe, expect, it } from 'vitest';
import {
  bestSpots,
  contrastGate,
  createGrid,
  createMask,
  describeHuntSignal,
  explainPoint,
  gridOf,
  HUNT_SIGNALS,
  huntQuality,
  huntSurface,
  qualityTier,
  maskOf,
  quarry,
  STAND_SPLIT_M,
  summariseSurface,
  treeLineElevationM,
} from './index.js';
import type { Grid, HuntInputs, HuntSignalKey } from './index.js';

const SIZE = 121;
const CELL_M = 10;

const RADYR = quarry('radyr')!;
const ELG = quarry('elg')!;
const STORFUGL = quarry('storfugl')!;
const LIRYPE = quarry('lirype')!;
const HJORT = quarry('hjort')!;

/** AR5 codes: 30 forest · 21 fulldyrka jord · 60 myr · 11 bebygd · 81 ferskvann. */
function landCoverOf(fn: (x: number, y: number) => number): Grid {
  return gridOf(SIZE, SIZE, CELL_M, fn);
}

function inputs(over: Partial<HuntInputs> = {}): HuntInputs {
  return {
    landCover: landCoverOf(() => 30),
    terrain: gridOf(SIZE, SIZE, CELL_M, () => 200),
    treeHeightM: gridOf(SIZE, SIZE, CELL_M, () => 18),
    treeSpecies: gridOf(SIZE, SIZE, CELL_M, () => 1),
    water: createMask(SIZE, SIZE, CELL_M),
    disturbance: createMask(SIZE, SIZE, CELL_M),
    artfunksjon: null,
    treeLineM: null,
    ...over,
  };
}

const at = (grid: Grid, x: number, y: number): number => grid.data[y * SIZE + x]!;

describe('hunt surface — D5: it must be allowed to find nothing', () => {
  it('reports no standout over uniform forest', () => {
    const surface = huntSurface(inputs(), { quarry: RADYR });
    const gate = contrastGate(surface.score);
    expect(gate.standout).toBe(false);
    expect(gate.reason).toContain('No standout structure');
    // And the shortlist obeys the gate rather than numbering eight tied pixels.
    expect(bestSpots(surface.score).spots).toHaveLength(0);
  });

  it('finds the field edge when there is one, and puts its spots on it', () => {
    const edgeX = 60;
    const surface = huntSurface(
      inputs({
        // Farmland to the west, young forest to the east — the roe deer's lead.
        landCover: landCoverOf((x) => (x < edgeX ? 21 : 30)),
        treeHeightM: gridOf(SIZE, SIZE, CELL_M, (x) => (x < edgeX ? 0 : 4)),
      }),
      { quarry: RADYR },
    );
    const result = bestSpots(surface.score, { limit: 4 });
    expect(result.contrast.standout).toBe(true);
    expect(result.spots.length).toBeGreaterThan(0);
    for (const spot of result.spots) {
      expect(Math.abs(spot.x - edgeX)).toBeLessThan(12); // within ~120 m of the edge
    }
  });
});

describe('hunt surface — young and mature cover are exclusive', () => {
  const surface = huntSurface(
    inputs({
      // North half regrowth, south half timber; a moose weights both.
      treeHeightM: gridOf(SIZE, SIZE, CELL_M, (_x, y) => (y < 60 ? 4 : 20)),
    }),
    { quarry: ELG },
  );
  const term = (key: string) => surface.terms.find((t) => t.key === key)!;

  it('marks each cover term absent on the stand the other describes', () => {
    expect(term('cover-young').exclusive).toBe(true);
    expect(term('cover-mature').exclusive).toBe(true);
    expect(at(term('cover-young').grid, 30, 90)).toBeNaN(); // mature half
    expect(at(term('cover-mature').grid, 30, 30)).toBeNaN(); // young half
    expect(at(term('cover-young').grid, 30, 30)).toBeGreaterThan(0.9);
    expect(at(term('cover-mature').grid, 30, 90)).toBeGreaterThan(0.9);
  });

  it('does not cap the score with the term a stand cannot satisfy', () => {
    // The claim, stated as arithmetic: without exclusivity the mature half
    // would carry cover-young = 0 at its full weight, and no timber anywhere
    // could reach the hot end of the ramp.
    const timber = { x: 30, y: 90 };
    let weighted = 0;
    let weights = 0;
    for (const term of surface.terms) {
      const v = at(term.grid, timber.x, timber.y);
      weighted += term.weight * (Number.isFinite(v) ? v : 0);
      weights += term.weight;
    }
    const capped = weighted / weights;
    expect(at(surface.score, timber.x, timber.y)).toBeGreaterThan(capped);
    expect(STAND_SPLIT_M).toBeGreaterThan(0);
  });
});

describe('hunt surface — roe-deer rut habitat', () => {
  const surface = huntSurface(
    inputs({
      // A buck patrols the young edge but beds in closed timber through the
      // heat of an August day, so both halves must survive as evidence.
      treeHeightM: gridOf(SIZE, SIZE, CELL_M, (_x, y) => (y < 60 ? 4 : 20)),
    }),
    { quarry: RADYR },
  );
  const term = (key: HuntSignalKey) => surface.terms.find((candidate) => candidate.key === key)!;

  it('counts mature timber as modest bedding cover', () => {
    expect(RADYR.weights['cover-mature']).toBe(0.4);
    expect(RADYR.weights['cover-mature']).toBeLessThan(RADYR.weights['cover-young']!);
    expect(term('cover-mature').exclusive).toBe(true);
    expect(at(term('cover-mature').grid, 30, 90)).toBeGreaterThan(0.9);
    expect(at(surface.score, 30, 90)).toBeGreaterThan(0);
  });

  it('keeps a hard-zero field edge as evidence, not missing data', () => {
    const why = describeHuntSignal('edge-farmland', 0, { quarry: RADYR });
    expect(why).toContain('within 600 m');
    expect(why).toContain('confirmed absent');

    const edge = term('edge-farmland');
    expect(at(edge.grid, 30, 90)).toBe(0);
    expect(Number.isFinite(at(edge.grid, 30, 90))).toBe(true);

    const card = explainPoint(surface.terms, 30, 90, {
      rank: surface.score,
      vocabulary: 'hunt',
    });
    expect(card.missing).not.toContain(edge.label);
    expect(card.factors.find((factor) => factor.key === edge.key)).toMatchObject({
      score: 0,
      detail: expect.stringContaining('confirmed absent'),
    });
  });
});

describe('hunt surface — presence-only inputs never penalise', () => {
  it('leaves unsurveyed ground exactly as it was', () => {
    const base = huntSurface(inputs(), { quarry: RADYR });
    // A surveyed functional area in one corner, nodata everywhere else.
    const surveyed = createGrid(SIZE, SIZE, CELL_M);
    for (let y = 0; y < 20; y++) for (let x = 0; x < 20; x++) surveyed.data[y * SIZE + x] = 1;
    const withSurvey = huntSurface(inputs({ artfunksjon: surveyed }), { quarry: RADYR });

    expect(at(withSurvey.score, 100, 100)).toBeCloseTo(at(base.score, 100, 100), 10);
    expect(at(withSurvey.score, 10, 10)).toBeGreaterThan(at(base.score, 10, 10));
  });

  it('scores ground with no land cover from the signals that did arrive', () => {
    const surface = huntSurface(inputs({ landCover: null }), { quarry: RADYR });
    expect(Number.isFinite(at(surface.score, 60, 60))).toBe(true);
    expect(surface.notes.join(' ')).toContain('No land cover');
  });
});

describe('hunt surface — what it refuses to speak about', () => {
  it('leaves water, buildings and road surface unscored', () => {
    const surface = huntSurface(
      inputs({
        landCover: landCoverOf((x, y) => (y < 10 ? 11 : y < 20 ? 12 : x < 10 ? 81 : 30)),
        water: maskOf(SIZE, SIZE, CELL_M, (x, y) => x < 10 && y >= 20),
      }),
      { quarry: RADYR },
    );
    expect(at(surface.score, 60, 5)).toBeNaN(); // bebygd
    expect(at(surface.score, 60, 15)).toBeNaN(); // samferdsel
    expect(at(surface.score, 5, 60)).toBeNaN(); // lake
    expect(Number.isFinite(at(surface.score, 60, 60))).toBe(true);
  });

  it('declines a tree-line quarry where there is no tree line', () => {
    const surface = huntSurface(inputs({ treeLineM: null }), { quarry: LIRYPE });
    expect(surface.terms).toHaveLength(0);
    expect([...surface.score.data].every((v) => Number.isNaN(v))).toBe(true);
    expect(surface.notes.join(' ')).toContain('tree line');
  });

  it('scores the tree-line band once the line is known', () => {
    const surface = huntSurface(
      inputs({
        // A hillside rising north to south through the local tree line at 900 m.
        terrain: gridOf(SIZE, SIZE, CELL_M, (_x, y) => 700 + y * 4),
        landCover: landCoverOf((_x, y) => (y < 50 ? 30 : 50)),
        treeHeightM: gridOf(SIZE, SIZE, CELL_M, (_x, y) => (y < 50 ? 14 : 0)),
        treeLineM: 900,
      }),
      { quarry: LIRYPE },
    );
    const band = surface.terms.find((t) => t.key === 'treeline')!;
    // Lirype's band peaks within ±100 m of the line, so row 50 (exactly 900 m)
    // is full membership and the valley floor 200 m below it is well down the
    // rising edge — which is the whole point of measuring against the *local*
    // line rather than a national elevation.
    expect(at(band.grid, 60, 50)).toBe(1);
    expect(at(band.grid, 60, 0)).toBeLessThan(0.5);
  });
});

describe('tree line derivation', () => {
  const terrain = gridOf(SIZE, SIZE, CELL_M, (_x, y) => 400 + y * 5);

  it('reads the elevation where mapped forest gives out', () => {
    // Forest up to row 80 ⇒ 800 m; above that bare fjell.
    const line = treeLineElevationM(
      maskOf(SIZE, SIZE, CELL_M, (_x, y) => y <= 80),
      terrain,
    );
    expect(line.elevationM).toBeGreaterThan(760);
    expect(line.elevationM).toBeLessThan(810);
    expect(line.reason).toContain('tree line');
  });

  it('says nothing rather than guessing when it is forest throughout', () => {
    const line = treeLineElevationM(
      maskOf(SIZE, SIZE, CELL_M, () => true),
      terrain,
    );
    expect(line.elevationM).toBeNull();
    expect(line.reason).toContain('above this area');
  });

  it('refuses a "line" that is only where the hill ran out', () => {
    // Nordmarka, as the live drive found it: forest to the highest ground, with
    // enough lake and farmland that the forest fraction never approaches one.
    // The 95th percentile of forest elevation is a real number and a meaningless
    // tree line — scoring ptarmigan against it would paint the Oslo woods.
    const line = treeLineElevationM(
      // Forest from a quarter of the way up to the summit, with the low ground
      // given over to lake and farmland.
      maskOf(SIZE, SIZE, CELL_M, (_x, y) => y > 30),
      terrain,
    );
    expect(line.forestFraction).toBeGreaterThan(0.5);
    expect(line.forestFraction).toBeLessThan(0.9);
    expect(line.elevationM).toBeNull();
    expect(line.reason).toContain('highest ground');
  });

  it('takes the lowest ground when the area is all above the line', () => {
    const line = treeLineElevationM(createMask(SIZE, SIZE, CELL_M), terrain);
    expect(line.elevationM).toBe(400);
    expect(line.forestFraction).toBe(0);
  });
});

describe('hunt quality — the absolute tier', () => {
  it('rises with the kommune harvest and floors rather than zeroing', () => {
    const strongHarvest = ELG.strongHarvest;
    const none = huntQuality({ harvest: 0, strongHarvest })!;
    const few = huntQuality({ harvest: 4, strongHarvest })!;
    const many = huntQuality({ harvest: 400, strongHarvest })!;
    expect(none).toBeGreaterThan(0.1);
    expect(few).toBeGreaterThan(none);
    expect(many).toBeGreaterThan(few);
    expect(many).toBeLessThanOrEqual(0.95);
  });

  it('lands the tiers where the national distribution actually sits', () => {
    // Measured over the 2025-2026 tables: among kommuner that shoot any elg at
    // all, the median is 73 and the 90th percentile 228. A median kommune must
    // not read "Excellent" — the first cut of this did exactly that.
    expect(qualityTier(huntQuality({ harvest: 73, strongHarvest: ELG.strongHarvest })!)).toBe(
      'fair',
    );
    expect(qualityTier(huntQuality({ harvest: 131, strongHarvest: ELG.strongHarvest })!)).toBe(
      'good',
    );
    expect(qualityTier(huntQuality({ harvest: 629, strongHarvest: ELG.strongHarvest })!)).toBe(
      'excellent',
    );
    // And hjort is judged on its own distribution, which runs four times higher.
    expect(qualityTier(huntQuality({ harvest: 131, strongHarvest: HJORT.strongHarvest })!)).toBe(
      'fair',
    );
  });

  it('has no opinion where no table exists', () => {
    expect(huntQuality({ harvest: null, strongHarvest: 230 })).toBeUndefined();
    // Every småvilt quarry: SSB discontinued the per-kommune rype series in
    // 1991-92, so there is no prior to have an opinion with.
    expect(LIRYPE.strongHarvest).toBeNull();
    expect(huntQuality({ harvest: 12, strongHarvest: LIRYPE.strongHarvest })).toBeUndefined();
  });
});

describe('hunt signals speak plainly', () => {
  it('has a sentence for every signal, at both ends of the range', () => {
    for (const signal of HUNT_SIGNALS) {
      for (const value of [0, 0.5, 1]) {
        const text = describeHuntSignal(signal.key as HuntSignalKey, value, { quarry: STORFUGL });
        expect(text.length).toBeGreaterThan(10);
        expect(text).not.toMatch(/\d+ %/); // never a number restated
      }
    }
  });

  it('ranks a capercaillie surface on mature pine rather than on spruce', () => {
    const pineEast = huntSurface(
      inputs({
        treeHeightM: gridOf(SIZE, SIZE, CELL_M, () => 22),
        treeSpecies: gridOf(SIZE, SIZE, CELL_M, (x) => (x > 60 ? 2 : 1)),
      }),
      { quarry: STORFUGL },
    );
    const summary = summariseSurface(pineEast.score);
    expect(at(summary.rank, 100, 60)).toBeGreaterThan(at(summary.rank, 20, 60));
  });
});
