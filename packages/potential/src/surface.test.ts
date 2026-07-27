import { describe, expect, it } from 'vitest';
import {
  bandForRank,
  bestSpots,
  contrastGate,
  createGrid,
  explainPoint,
  gridOf,
  labelForRank,
  qualityTier,
  rampColor,
  renderRamp,
  summariseSurface,
} from './index.js';
import type { CombineTerm } from './index.js';

describe('ramp', () => {
  it('reserves the hot band for the top 5 %', () => {
    expect(bandForRank(0).key).toBe('quiet');
    expect(bandForRank(0.7).key).toBe('worth-a-look');
    expect(bandForRank(0.9).key).toBe('promising');
    expect(bandForRank(0.99).key).toBe('prime');
  });

  it('speaks in words, and in the right vocabulary', () => {
    expect(labelForRank(0.7, 'fishing')).toBe('Worth a cast');
    expect(labelForRank(0.7, 'hunt')).toBe('Worth a look');
    expect(labelForRank(0.99, 'hunt')).toBe('Prime');
  });

  it('renders nodata fully transparent, so an underived area shows the basemap', () => {
    expect(rampColor(Number.NaN)).toEqual([0, 0, 0, 0]);
    const rgba = renderRamp(gridOf(2, 1, 10, (x) => (x === 0 ? Number.NaN : 0.99)));
    expect(Array.from(rgba.slice(0, 4))).toEqual([0, 0, 0, 0]);
    expect(rgba[7]).toBeGreaterThan(150);
  });
});

describe('contrast gate', () => {
  it('accepts a surface with a real hot corner', () => {
    // The corner has to be big enough to reach the hot quantile: a hotspot
    // smaller than the top 5 % is, correctly, not what the gate is measuring.
    const g = gridOf(40, 40, 10, (x, y) => (x > 28 && y > 28 ? 0.9 : 0.2));
    const report = contrastGate(g);
    expect(report.standout).toBe(true);
    expect(report.spread).toBeGreaterThan(0.5);
    expect(report.reason).toMatch(/best 5 %/);
  });

  it('rejects noise around a constant level', () => {
    let seed = 1;
    const noise = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const g = gridOf(40, 40, 10, () => 0.5 + (noise() - 0.5) * 0.02);
    expect(contrastGate(g).standout).toBe(false);
  });

  it('says so when there is too little data to rank at all', () => {
    expect(contrastGate(createGrid(20, 20, 10)).reason).toMatch(/No data/);
    const sparse = gridOf(20, 20, 10, (x, y) => (x + y < 4 ? 1 : Number.NaN));
    expect(contrastGate(sparse).reason).toMatch(/Too little/);
    expect(contrastGate(sparse).standout).toBe(false);
  });

  it('takes the hot threshold and the separation floor from options', () => {
    const g = gridOf(40, 40, 10, (x) => (x > 35 ? 0.6 : 0.5));
    expect(contrastGate(g, { minSpread: 0.05 }).standout).toBe(true);
    expect(contrastGate(g, { minSpread: 0.2 }).standout).toBe(false);
  });
});

describe('quality tier', () => {
  it('is coarse, absolute, and separate from the ranking', () => {
    expect(qualityTier(0.1)).toBe('poor');
    expect(qualityTier(0.45)).toBe('fair');
    expect(qualityTier(0.6)).toBe('good');
    expect(qualityTier(0.9)).toBe('excellent');
  });

  it('is null rather than invented when the model supplies no prior', () => {
    const summary = summariseSurface(gridOf(20, 20, 10, (x) => x / 20));
    expect(summary.tier).toBeNull();
    expect(summary.tierLabel).toBeNull();
  });
});

describe('best spots', () => {
  it('spreads spots out and stops at the limit', () => {
    const g = gridOf(60, 60, 10, (x, y) => {
      const peaks: [number, number][] = [
        [10, 10],
        [50, 10],
        [10, 50],
        [50, 50],
      ];
      return Math.max(...peaks.map(([px, py]) => 1 - Math.hypot(x - px, y - py) / 20), 0);
    });
    const { spots } = bestSpots(g, { minSeparationM: 200, limit: 3 });
    expect(spots).toHaveLength(3);
    for (let i = 0; i < spots.length; i++) {
      for (let j = i + 1; j < spots.length; j++) {
        expect(
          Math.hypot(spots[i]!.x - spots[j]!.x, spots[i]!.y - spots[j]!.y) * 10,
        ).toBeGreaterThanOrEqual(200);
      }
    }
  });
});

describe('explain', () => {
  const terms: CombineTerm[] = [
    {
      key: 'inlet',
      label: 'Inflow mouth',
      weight: 1,
      grid: gridOf(2, 1, 10, (x) => (x === 0 ? 0.9 : 0.1)),
      describe: (v) => `${Math.round(v * 100)} m from the inflow`,
    },
    {
      key: 'shore-cover',
      label: 'Shore cover',
      weight: 0.5,
      grid: gridOf(2, 1, 10, (x) => (x === 0 ? Number.NaN : 0.8)),
    },
  ];

  it('leads with the factor that actually drove the score', () => {
    const rank = gridOf(2, 1, 10, (x) => (x === 0 ? 0.97 : 0.2));
    const why = explainPoint(terms, 0, 0, { rank });
    expect(why.score).toBe(97);
    expect(why.bandLabel).toBe('Prime');
    expect(why.factors[0]!.key).toBe('inlet');
    expect(why.factors[0]!.rating).toBe('good');
    expect(why.summary).toContain('90 m from the inflow');
  });

  it('names what it does not know, and renormalises the weights it used', () => {
    const rank = gridOf(2, 1, 10, () => 0.5);
    const why = explainPoint(terms, 0, 0, { rank });
    expect(why.missing).toEqual(['Shore cover']);
    expect(why.summary).toContain('No shore cover data here');
    // Only the inlet term applied, so it carries the whole weight.
    expect(why.factors).toHaveLength(1);
    expect(why.factors[0]!.weight).toBeCloseTo(1, 10);
  });

  it('mixes in factors from outside the raster', () => {
    const rank = gridOf(2, 1, 10, () => 0.5);
    const why = explainPoint(terms, 1, 0, {
      rank,
      extra: [
        {
          key: 'depth-band',
          label: 'Holding depth',
          score: 1,
          weight: 0.7,
          rating: 'good',
          detail: 'inside the summer band 4–9 m',
        },
      ],
    });
    expect(why.factors.map((f) => f.key)).toContain('depth-band');
    const total = why.factors.reduce((sum, f) => sum + f.weight, 0);
    expect(total).toBeCloseTo(1, 10);
  });

  it('admits when nothing is derived for a point', () => {
    const why = explainPoint(terms, 0, 0, { rank: createGrid(2, 1, 10) });
    expect(Number.isNaN(why.score)).toBe(true);
    expect(why.summary).toBe('Nothing is derived for this point.');
  });
});
