/**
 * Cost guard for the primitives at the real derive size.
 *
 * A derive cell is a fixed z11 tile rasterised at 1024² (≈9.6 m/px at 60°N), so
 * that is the size every primitive has to be comfortable at. The design target
 * is single-digit to ~50 ms each — but this suite runs inside a docker build on
 * a host that is also serving everything else, and a loaded runner has already
 * turned a 1.7 s test into a 5 s timeout once in this repo. Asserting the design
 * target would produce red builds with nothing wrong in them, and a red build
 * silently leaves the last release undeployed.
 *
 * So the ceiling here is deliberately an order of magnitude above the target:
 * it exists to catch an accidental O(n²) (which at 1024² is minutes, not
 * milliseconds), not to police a few milliseconds of jitter. The measured
 * numbers are printed so a regression is visible even when the gate stays green.
 */
import { describe, expect, it } from 'vitest';
import {
  combine,
  distanceTransform,
  fillNearest,
  focalMean,
  gridOf,
  idw,
  localMaxima,
  maskOf,
  percentileRank,
  slopePercent,
} from './index.js';
import type { SamplePoint } from './index.js';

const N = 1024;
const CELL_M = 9.6;
/**
 * Generous by design: the loaded release host can stretch the IDW primitive
 * past 5 s, while the accidental O(n²) regressions this guards against take
 * minutes at 1024². The per-test 30 s timeout remains the hard hang ceiling.
 */
const CEILING_MS = 10_000;

function timed(name: string, run: () => unknown): number {
  const started = performance.now();
  run();
  const ms = performance.now() - started;
  console.log(`  ${name.padEnd(20)} ${ms.toFixed(1)} ms @ ${N}²`);
  return ms;
}

describe(`primitives at ${N}²`, () => {
  const terrain = gridOf(
    N,
    N,
    CELL_M,
    (x, y) => Math.sin(x / 60) * 40 + Math.cos(y / 90) * 25 + y / 12,
  );
  const sparse = maskOf(N, N, CELL_M, (x, y) => (x * 7 + y * 13) % 4096 === 0);
  const samples: SamplePoint[] = [];
  for (let i = 0; i < 500; i++) {
    samples.push({ x: (i * 137) % N, y: (i * 251) % N, value: (i % 40) + 1 });
  }

  it('stays well inside the ceiling for every primitive', () => {
    const measured: Record<string, number> = {
      slopePercent: timed('slopePercent', () => slopePercent(terrain)),
      distanceTransform: timed('distanceTransform', () => distanceTransform(sparse)),
      focalMean: timed('focalMean r=16', () => focalMean(terrain, 16)),
      fillNearest: timed('fillNearest', () => fillNearest(terrain)),
      percentileRank: timed('percentileRank', () => percentileRank(terrain)),
      idw: timed('idw 500 pts', () => idw(N, N, CELL_M, samples, { searchRadiusCells: 64 })),
      combine: timed('combine ×3', () =>
        combine([
          { key: 'a', label: 'A', weight: 1, grid: terrain },
          { key: 'b', label: 'B', weight: 1, grid: terrain },
          { key: 'c', label: 'C', weight: 1, grid: terrain },
        ]),
      ),
      localMaxima: timed('localMaxima', () =>
        localMaxima(terrain, { minSeparationCells: 16, limit: 8 }),
      ),
    };
    for (const [name, ms] of Object.entries(measured)) {
      expect(ms, `${name} took ${ms.toFixed(0)} ms at ${N}²`).toBeLessThan(CEILING_MS);
    }
  });

  it('is independent of the focal radius (separable box, not a kernel per cell)', () => {
    const small = timed('focalMean r=2', () => focalMean(terrain, 2));
    const large = timed('focalMean r=64', () => focalMean(terrain, 64));
    // A naive kernel would be ~1000× slower at r=64; a running window is flat.
    expect(large).toBeLessThan(Math.max(small * 6, 400));
  });
});
