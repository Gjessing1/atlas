/**
 * Raster primitives for the Fish & Hunt potential engine (ROADMAP § N5 / E1,
 * design in docs/FISH-HUNT-ENGINE.md § D1).
 *
 * Pure TypeScript over `Float32Array`, deliberately *not* GDAL: every operation
 * the four models need is small and well understood (Horn slope, exact
 * Euclidean distance transform, box-blur focal mean, Bresenham burn, inverse
 * distance weighting, nearest-valid fill, weighted combine). Shelling out would
 * buy a ~1 GB image layer, Python, a second deployment unit and untestable
 * business logic in the backend — which architecture rule 1 forbids outright.
 *
 * Conventions that hold across every function here:
 *
 * - Row-major `data[y * width + x]`, origin top-left, square cells. `y` grows
 *   *south*, so anything compass-shaped (aspect) converts explicitly.
 * - **NaN is nodata, and nodata means "unknown", never "bad".** This is the
 *   calibration lesson that cost nodemap the most: several inputs have partial
 *   coverage (AR5 stops at the tree line), so an uncovered pixel must drop out
 *   of the denominator rather than score zero. `combine()` renormalises
 *   per-pixel for exactly this reason.
 * - Every function returns a new grid unless its name says `burn` (those mutate
 *   in place, because rasterising a few thousand line segments into a fresh
 *   allocation each time is the one place where copying actually shows up).
 * - Everything is O(width·height) with small constants — the separable box
 *   blur, the two-pass distance transform and the histogram-based percentiles
 *   are all chosen over their naive forms for that reason, and `perf.test.ts`
 *   holds the line at 1024².
 */

/** A single-band float raster. NaN = nodata. */
export interface Grid {
  readonly width: number;
  readonly height: number;
  /** Ground size of one (square) cell, in metres. */
  readonly cellSizeM: number;
  /** Row-major `[y * width + x]`. */
  readonly data: Float32Array;
}

/** A binary raster (1 = set). Masks carry geometry, grids carry values. */
export interface Mask {
  readonly width: number;
  readonly height: number;
  readonly cellSizeM: number;
  /** Row-major `[y * width + x]`, 0 or 1. */
  readonly data: Uint8Array;
}

/** Anything with raster dimensions — lets shape checks accept grids and masks alike. */
type Shaped = { readonly width: number; readonly height: number; readonly cellSizeM: number };

/** Large-but-finite stand-in for +∞ inside the distance transform (∞−∞ would be NaN). */
const FAR = 1e20;

function assertSameShape(a: Shaped, b: Shaped, what: string): void {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`${what}: size mismatch ${a.width}×${a.height} vs ${b.width}×${b.height}`);
  }
  if (a.cellSizeM !== b.cellSizeM) {
    throw new Error(`${what}: cell size mismatch ${a.cellSizeM} vs ${b.cellSizeM}`);
  }
}

/** Allocate a grid, filled with `fill` (NaN — i.e. nodata — by default). */
export function createGrid(
  width: number,
  height: number,
  cellSizeM: number,
  fill = Number.NaN,
): Grid {
  if (width <= 0 || height <= 0) throw new Error('createGrid: width and height must be positive');
  const data = new Float32Array(width * height);
  if (fill !== 0) data.fill(fill);
  return { width, height, cellSizeM, data };
}

/** Build a grid from a per-cell function — the workhorse of the synthetic-grid tests. */
export function gridOf(
  width: number,
  height: number,
  cellSizeM: number,
  fn: (x: number, y: number) => number,
): Grid {
  const grid = createGrid(width, height, cellSizeM, 0);
  for (let y = 0, i = 0; y < height; y++) {
    for (let x = 0; x < width; x++, i++) grid.data[i] = fn(x, y);
  }
  return grid;
}

/** Allocate a mask, all cells clear. */
export function createMask(width: number, height: number, cellSizeM: number): Mask {
  if (width <= 0 || height <= 0) throw new Error('createMask: width and height must be positive');
  return { width, height, cellSizeM, data: new Uint8Array(width * height) };
}

/** Build a mask from a per-cell predicate. */
export function maskOf(
  width: number,
  height: number,
  cellSizeM: number,
  fn: (x: number, y: number) => boolean,
): Mask {
  const mask = createMask(width, height, cellSizeM);
  for (let y = 0, i = 0; y < height; y++) {
    for (let x = 0; x < width; x++, i++) mask.data[i] = fn(x, y) ? 1 : 0;
  }
  return mask;
}

/** Classify a grid into a mask. Nodata never satisfies the predicate. */
export function maskFromGrid(grid: Grid, predicate: (value: number) => boolean): Mask {
  const mask = createMask(grid.width, grid.height, grid.cellSizeM);
  for (let i = 0; i < grid.data.length; i++) {
    const v = grid.data[i]!;
    mask.data[i] = Number.isFinite(v) && predicate(v) ? 1 : 0;
  }
  return mask;
}

/** A mask as a 0/1 grid, so mask geometry can flow through the value primitives. */
export function maskToGrid(mask: Mask): Grid {
  const grid = createGrid(mask.width, mask.height, mask.cellSizeM, 0);
  for (let i = 0; i < mask.data.length; i++) grid.data[i] = mask.data[i]!;
  return grid;
}

/** Value at `(x, y)`, or NaN outside the raster. */
export function valueAt(grid: Grid, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= grid.width || y >= grid.height) return Number.NaN;
  return grid.data[y * grid.width + x]!;
}

/** Set `(x, y)`; out-of-bounds writes are ignored rather than throwing. */
export function setValue(grid: Grid, x: number, y: number, value: number): void {
  if (x < 0 || y < 0 || x >= grid.width || y >= grid.height) return;
  grid.data[y * grid.width + x] = value;
}

/** Is a cell of `mask` set? Outside the raster counts as clear. */
export function maskAt(mask: Mask, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= mask.width || y >= mask.height) return false;
  return mask.data[y * mask.width + x] === 1;
}

export function cloneGrid(grid: Grid): Grid {
  return { ...grid, data: Float32Array.from(grid.data) };
}

/** Map every *valid* cell through `fn`; nodata stays nodata. */
export function mapValues(grid: Grid, fn: (value: number, x: number, y: number) => number): Grid {
  const out = createGrid(grid.width, grid.height, grid.cellSizeM, 0);
  for (let y = 0, i = 0; y < grid.height; y++) {
    for (let x = 0; x < grid.width; x++, i++) {
      const v = grid.data[i]!;
      out.data[i] = Number.isFinite(v) ? fn(v, x, y) : Number.NaN;
    }
  }
  return out;
}

/** Clear every cell outside `mask` to nodata (a hard gate — e.g. "water only"). */
export function applyMask(grid: Grid, mask: Mask): Grid {
  assertSameShape(grid, mask, 'applyMask');
  const out = createGrid(grid.width, grid.height, grid.cellSizeM, 0);
  for (let i = 0; i < grid.data.length; i++) {
    out.data[i] = mask.data[i] === 1 ? grid.data[i]! : Number.NaN;
  }
  return out;
}

/**
 * Pixelwise maximum over valid cells; nodata only where *every* input is nodata.
 *
 * This is the shape of the single most expensive calibration lesson carried
 * over from nodemap: **structure is `max(drop-off, shelf)`, never their
 * average.** The two are mutually exclusive by construction (steep ≠ flat), so
 * averaging made them cancel, capped the score below the hot end of the ramp,
 * and rendered a surveyed lake as a faint wash.
 */
export function maxOf(...grids: readonly Grid[]): Grid {
  const first = grids[0];
  if (!first) throw new Error('maxOf: needs at least one grid');
  for (const g of grids) assertSameShape(first, g, 'maxOf');
  const out = createGrid(first.width, first.height, first.cellSizeM, 0);
  for (let i = 0; i < out.data.length; i++) {
    let best = Number.NaN;
    for (const g of grids) {
      const v = g.data[i]!;
      if (Number.isFinite(v) && !(v <= best)) best = v;
    }
    out.data[i] = best;
  }
  return out;
}

/** Pixelwise minimum over valid cells; nodata only where every input is nodata. */
export function minOf(...grids: readonly Grid[]): Grid {
  const first = grids[0];
  if (!first) throw new Error('minOf: needs at least one grid');
  for (const g of grids) assertSameShape(first, g, 'minOf');
  const out = createGrid(first.width, first.height, first.cellSizeM, 0);
  for (let i = 0; i < out.data.length; i++) {
    let best = Number.NaN;
    for (const g of grids) {
      const v = g.data[i]!;
      if (Number.isFinite(v) && !(v >= best)) best = v;
    }
    out.data[i] = best;
  }
  return out;
}

/** Summary statistics over the valid cells only. */
export interface GridStats {
  /** Number of valid (non-nodata) cells. */
  count: number;
  min: number;
  max: number;
  mean: number;
}

export function gridStats(grid: Grid): GridStats {
  let count = 0;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let sum = 0;
  for (let i = 0; i < grid.data.length; i++) {
    const v = grid.data[i]!;
    if (!Number.isFinite(v)) continue;
    count++;
    sum += v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (count === 0) return { count: 0, min: Number.NaN, max: Number.NaN, mean: Number.NaN };
  return { count, min, max, mean: sum / count };
}

/**
 * Equal-width histogram of the valid cells — the basis for every quantile we
 * take. Sorting a million floats to find a median would cost more than the
 * whole rest of a cell's derive; binning is O(n) and the ramp only ever needs
 * a rank, so the bin quantisation is invisible in the output.
 */
export interface GridHistogram {
  readonly min: number;
  readonly max: number;
  readonly count: number;
  readonly bins: Uint32Array;
}

export function gridHistogram(grid: Grid, binCount = 2048): GridHistogram {
  if (binCount < 1) throw new Error('gridHistogram: binCount must be >= 1');
  const { count, min, max } = gridStats(grid);
  const bins = new Uint32Array(binCount);
  if (count === 0) return { min: Number.NaN, max: Number.NaN, count: 0, bins };
  const span = max - min;
  if (span <= 0) {
    bins[0] = count;
    return { min, max, count, bins };
  }
  const scale = binCount / span;
  for (let i = 0; i < grid.data.length; i++) {
    const v = grid.data[i]!;
    if (!Number.isFinite(v)) continue;
    let b = Math.floor((v - min) * scale);
    if (b < 0) b = 0;
    else if (b >= binCount) b = binCount - 1;
    bins[b]!++;
  }
  return { min, max, count, bins };
}

/** Value at quantile `q` (0..1) of a histogram; NaN for an empty one. */
export function quantile(histogram: GridHistogram, q: number): number {
  const { count, min, max, bins } = histogram;
  if (count === 0) return Number.NaN;
  if (max === min) return min;
  const target = Math.min(count, Math.max(1, Math.ceil(q * count)));
  const width = (max - min) / bins.length;
  let cumulative = 0;
  for (let b = 0; b < bins.length; b++) {
    cumulative += bins[b]!;
    if (cumulative >= target) return min + (b + 0.5) * width;
  }
  return max;
}

/** Convenience: quantile straight off a grid (builds a throwaway histogram). */
export function gridQuantile(grid: Grid, q: number, binCount = 2048): number {
  return quantile(gridHistogram(grid, binCount), q);
}

/**
 * Percentile rank of every valid cell, 0..1 — the D5 "rank within the surface,
 * not on an absolute scale" rule made literal.
 *
 * Mapping the ramp to the surface's own percentiles guarantees contrast by
 * construction and kills the calibration trap nodemap hit (a weighted average
 * tops out near 75–80 and sits mostly 30–55, so the hot end of a 0–100 ramp is
 * never reached). Cells sharing a histogram bin share a rank, and each bin is
 * assigned the *midpoint* of the cumulative interval it occupies, so a
 * featureless surface ranks flat around 0.5 rather than sweeping 0→1.
 *
 * The counterweight lives in `contrastGate()`: ranking always produces a top
 * decile, so something has to be allowed to say the spread is not real.
 */
export function percentileRank(grid: Grid, binCount = 2048): Grid {
  const histogram = gridHistogram(grid, binCount);
  const out = createGrid(grid.width, grid.height, grid.cellSizeM, Number.NaN);
  if (histogram.count === 0) return out;
  const { min, max, count, bins } = histogram;
  const ranks = new Float64Array(bins.length);
  let cumulative = 0;
  for (let b = 0; b < bins.length; b++) {
    const n = bins[b]!;
    ranks[b] = n === 0 ? cumulative / count : (cumulative + n / 2) / count;
    cumulative += n;
  }
  const span = max - min;
  const scale = span > 0 ? bins.length / span : 0;
  for (let i = 0; i < grid.data.length; i++) {
    const v = grid.data[i]!;
    if (!Number.isFinite(v)) continue;
    if (span <= 0) {
      out.data[i] = 0.5;
      continue;
    }
    let b = Math.floor((v - min) * scale);
    if (b < 0) b = 0;
    else if (b >= bins.length) b = bins.length - 1;
    out.data[i] = ranks[b]!;
  }
  return out;
}

/**
 * Horn 3×3 slope in **percent** (rise/run × 100).
 *
 * Percent, not degrees, and that is not a preference: nodemap classified
 * pool/riffle from degrees (flat <4°, fast ≥9°) and every river cell came back
 * "pool", because 4° is already a 7 % grade — a cascade. Real channels separate
 * at fractions of a percent. `slopeDegrees()` exists for terrain, where degrees
 * are the natural unit.
 *
 * Edges replicate; a nodata *neighbour* is substituted with the centre value
 * (so a small hole does not eat a ring of slope around it), but a nodata
 * *centre* stays nodata.
 */
export function slopePercent(grid: Grid): Grid {
  return horn(grid, (gx, gy) => Math.sqrt(gx * gx + gy * gy) * 100);
}

/** Horn 3×3 slope in degrees, for terrain (walking, avalanche, browse). */
export function slopeDegrees(grid: Grid): Grid {
  return horn(grid, (gx, gy) => (Math.atan(Math.sqrt(gx * gx + gy * gy)) * 180) / Math.PI);
}

/**
 * Downslope aspect in compass degrees (0 = north, 90 = east), NaN where the
 * cell is flat. `y` grows south in raster space, so the northward gradient is
 * the negated row gradient — done here once rather than in every caller.
 */
export function aspectDegrees(grid: Grid): Grid {
  return horn(grid, (gx, gyRows) => {
    const gyNorth = -gyRows;
    if (gx === 0 && gyNorth === 0) return Number.NaN;
    const deg = (Math.atan2(-gx, -gyNorth) * 180) / Math.PI;
    return deg < 0 ? deg + 360 : deg;
  });
}

/** Shared Horn 3×3 kernel: hands `(dz/dx east, dz/dy south)` to `fn`. */
function horn(grid: Grid, fn: (gx: number, gyRows: number) => number): Grid {
  const { width, height, cellSizeM, data } = grid;
  const out = createGrid(width, height, cellSizeM, 0);
  const denom = 8 * cellSizeM;
  for (let y = 0; y < height; y++) {
    const y0 = y > 0 ? y - 1 : 0;
    const y2 = y < height - 1 ? y + 1 : height - 1;
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const centre = data[i]!;
      if (!Number.isFinite(centre)) {
        out.data[i] = Number.NaN;
        continue;
      }
      const x0 = x > 0 ? x - 1 : 0;
      const x2 = x < width - 1 ? x + 1 : width - 1;
      const a = pick(data, y0 * width + x0, centre);
      const b = pick(data, y0 * width + x, centre);
      const c = pick(data, y0 * width + x2, centre);
      const d = pick(data, y * width + x0, centre);
      const f = pick(data, y * width + x2, centre);
      const g = pick(data, y2 * width + x0, centre);
      const h = pick(data, y2 * width + x, centre);
      const k = pick(data, y2 * width + x2, centre);
      const gx = (c + 2 * f + k - (a + 2 * d + g)) / denom;
      const gy = (g + 2 * h + k - (a + 2 * b + c)) / denom;
      out.data[i] = fn(gx, gy);
    }
  }
  return out;
}

function pick(data: Float32Array, index: number, fallback: number): number {
  const v = data[index]!;
  return Number.isFinite(v) ? v : fallback;
}

/** Exact Euclidean distance to the nearest set cell, plus which cell that was. */
export interface DistanceField {
  /** Metres to the nearest set cell; +∞ everywhere when the mask is empty. */
  readonly distanceM: Grid;
  /** Flat index of the nearest set cell, or -1 where there is none. */
  readonly nearest: Int32Array;
}

/**
 * Exact Euclidean distance transform (Felzenszwalb & Huttenlocher two-pass) —
 * the `gdal_proximity` replacement, and the primitive most of the signals are
 * built on (inlet mouths, shore bands, disturbance from roads).
 *
 * Two 1-D lower-envelope passes, O(width·height) total, and each pass carries
 * the argmin so the nearest *source cell* comes out for free — which is what
 * makes `fillNearest()` (`gdal_fillnodata`) a three-line consumer instead of a
 * second algorithm.
 */
export function distanceTransform(mask: Mask): DistanceField {
  const { width, height, cellSizeM } = mask;
  const distanceM = createGrid(width, height, cellSizeM, 0);
  const nearest = new Int32Array(width * height).fill(-1);

  let any = false;
  for (let i = 0; i < mask.data.length; i++) {
    if (mask.data[i] === 1) {
      any = true;
      break;
    }
  }
  if (!any) {
    distanceM.data.fill(Number.POSITIVE_INFINITY);
    return { distanceM, nearest };
  }

  const n = Math.max(width, height);
  const f = new Float64Array(n);
  const d = new Float64Array(n);
  const arg = new Int32Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);

  // Pass 1 — down each column.
  const colDist = new Float64Array(width * height);
  const colArg = new Int32Array(width * height);
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) f[y] = mask.data[y * width + x] === 1 ? 0 : FAR;
    lowerEnvelope(f, height, d, arg, v, z);
    for (let y = 0; y < height; y++) {
      colDist[y * width + x] = d[y]!;
      colArg[y * width + x] = arg[y]!;
    }
  }

  // Pass 2 — across each row, over the column results.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) f[x] = colDist[y * width + x]!;
    lowerEnvelope(f, width, d, arg, v, z);
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const sq = d[x]!;
      if (sq >= FAR) {
        distanceM.data[i] = Number.POSITIVE_INFINITY;
        nearest[i] = -1;
        continue;
      }
      distanceM.data[i] = Math.sqrt(sq) * cellSizeM;
      const sx = arg[x]!;
      nearest[i] = colArg[y * width + sx]! * width + sx;
    }
  }
  return { distanceM, nearest };
}

/** Squared-distance lower envelope of the parabolas rooted at each sample. */
function lowerEnvelope(
  f: Float64Array,
  n: number,
  d: Float64Array,
  arg: Int32Array,
  v: Int32Array,
  z: Float64Array,
): void {
  let k = 0;
  v[0] = 0;
  z[0] = Number.NEGATIVE_INFINITY;
  z[1] = Number.POSITIVE_INFINITY;
  for (let q = 1; q < n; q++) {
    let s = (f[q]! + q * q - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
    while (s <= z[k]!) {
      k--;
      s = (f[q]! + q * q - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Number.POSITIVE_INFINITY;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1]! < q) k++;
    const dx = q - v[k]!;
    d[q] = dx * dx + f[v[k]!]!;
    arg[q] = v[k]!;
  }
}

/** Metres to the nearest set cell (the common half of `distanceTransform`). */
export function distanceToMask(mask: Mask): Grid {
  return distanceTransform(mask).distanceM;
}

/**
 * Fill nodata from the nearest valid cell (`gdal_fillnodata`). Used where a
 * measurement is sparse but the quantity is genuinely continuous — never to
 * invent coverage for an input that simply is not surveyed there.
 */
export function fillNearest(grid: Grid): Grid {
  const valid = maskFromGrid(grid, () => true);
  const { nearest } = distanceTransform(valid);
  const out = createGrid(grid.width, grid.height, grid.cellSizeM, 0);
  for (let i = 0; i < out.data.length; i++) {
    const source = nearest[i]!;
    out.data[i] = source >= 0 ? grid.data[source]! : Number.NaN;
  }
  return out;
}

/**
 * Focal mean over a square window of `radiusCells` — separable box blur with
 * running sums, O(width·height) regardless of radius.
 *
 * Nodata is *skipped*, not counted as zero: the window mean is over the valid
 * cells it actually saw. This is what makes it safe to smooth a partially
 * covered input, and it is why signals are smoothed before they are combined —
 * one-pixel thresholds speckle, and de-speckling afterwards is the tail wagging
 * the dog.
 */
export function focalMean(grid: Grid, radiusCells: number): Grid {
  const r = Math.max(0, Math.floor(radiusCells));
  const { width, height, cellSizeM, data } = grid;
  const out = createGrid(width, height, cellSizeM, 0);
  if (r === 0) return cloneGrid(grid);

  const hSum = new Float64Array(width * height);
  const hCount = new Int32Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let sum = 0;
    let count = 0;
    for (let x = 0; x <= Math.min(r, width - 1); x++) {
      const val = data[row + x]!;
      if (Number.isFinite(val)) {
        sum += val;
        count++;
      }
    }
    for (let x = 0; x < width; x++) {
      hSum[row + x] = sum;
      hCount[row + x] = count;
      const drop = x - r;
      const add = x + r + 1;
      if (drop >= 0) {
        const val = data[row + drop]!;
        if (Number.isFinite(val)) {
          sum -= val;
          count--;
        }
      }
      if (add < width) {
        const val = data[row + add]!;
        if (Number.isFinite(val)) {
          sum += val;
          count++;
        }
      }
    }
  }

  for (let x = 0; x < width; x++) {
    let sum = 0;
    let count = 0;
    for (let y = 0; y <= Math.min(r, height - 1); y++) {
      sum += hSum[y * width + x]!;
      count += hCount[y * width + x]!;
    }
    for (let y = 0; y < height; y++) {
      out.data[y * width + x] = count > 0 ? sum / count : Number.NaN;
      const drop = y - r;
      const add = y + r + 1;
      if (drop >= 0) {
        sum -= hSum[drop * width + x]!;
        count -= hCount[drop * width + x]!;
      }
      if (add < height) {
        sum += hSum[add * width + x]!;
        count += hCount[add * width + x]!;
      }
    }
  }
  return out;
}

/** Fraction of set cells in the window, 0..1 — focal mean over a mask. */
export function focalFraction(mask: Mask, radiusCells: number): Grid {
  return focalMean(maskToGrid(mask), radiusCells);
}

/** Bresenham line into a mask (`gdal_rasterize`). Coordinates are cell indices. */
export function burnLine(mask: Mask, x0: number, y0: number, x1: number, y1: number): void {
  bresenham(x0, y0, x1, y1, (x, y) => {
    if (x >= 0 && y >= 0 && x < mask.width && y < mask.height) mask.data[y * mask.width + x] = 1;
  });
}

/** Bresenham line into a grid, writing `value` (e.g. a digitised depth contour). */
export function burnLineValue(
  grid: Grid,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  value: number,
): void {
  bresenham(x0, y0, x1, y1, (x, y) => setValue(grid, x, y, value));
}

/** Burn a whole polyline into a mask. */
export function burnPolyline(mask: Mask, points: readonly (readonly [number, number])[]): void {
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    burnLine(mask, a[0], a[1], b[0], b[1]);
  }
}

/**
 * Burn a whole polyline into a grid at a constant value.
 *
 * Contour-digitised lakes need this rather than point interpolation: treating
 * contour vertices as scattered points makes the interpolated bottom bead
 * around every vertex, and the drop-off signal then lights up as concentric
 * scalloped rings. Rasterise the lines, then fill between them.
 */
export function burnPolylineValue(
  grid: Grid,
  points: readonly (readonly [number, number])[],
  value: number,
): void {
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    burnLineValue(grid, a[0], a[1], b[0], b[1], value);
  }
}

/**
 * Fill closed rings into a mask — the **water mask**, and the one primitive the
 * derive service found missing once E2 was running.
 *
 * Burning a lake's rings draws its *outline*; almost every lake signal needs its
 * *interior*: "is this pixel water" gates the whole surface, the shore band is
 * defined by distance to the interior's boundary, and `mouthMask` asks which
 * side of the shoreline a stream cell is on. An outline cannot answer any of
 * them.
 *
 * Rings are filled together under the **even-odd** rule, so a lake's islands
 * (which NVE returns as further rings of the same polygon) punch holes without
 * the caller having to know which ring is which — winding order is not reliable
 * across the sources here, and even-odd needs no such promise.
 *
 * Scanline at pixel centres: a row crosses an edge when the edge spans that
 * centre's `y`, with the top vertex counted and the bottom one not, so shared
 * vertices between consecutive edges produce exactly one crossing rather than
 * two or none. Coordinates are fractional cell indices and may lie outside the
 * raster — a lake continuing past the cell edge must still fill the part that is
 * inside, which is why clipping happens per span rather than per vertex.
 */
export function fillRings(
  mask: Mask,
  rings: readonly (readonly (readonly [number, number])[])[],
): void {
  interface Edge {
    readonly yMin: number;
    readonly yMax: number;
    /** x at `yMin`, and dx/dy — the scanline's x is `x0 + (y - yMin) * slope`. */
    readonly x0: number;
    readonly slope: number;
  }
  const edges: Edge[] = [];
  let top = Number.POSITIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const ring of rings) {
    if (ring.length < 3) continue;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]!;
      // Close the ring even when the source did not repeat the first vertex.
      const b = ring[(i + 1) % ring.length]!;
      const [ax, ay] = a;
      const [bx, by] = b;
      if (!Number.isFinite(ax) || !Number.isFinite(ay)) continue;
      if (!Number.isFinite(bx) || !Number.isFinite(by)) continue;
      if (ay === by) continue; // horizontal edges cross no scanline centre
      const upper = ay < by ? a : b;
      const lower = ay < by ? b : a;
      edges.push({
        yMin: upper[1],
        yMax: lower[1],
        x0: upper[0],
        slope: (lower[0] - upper[0]) / (lower[1] - upper[1]),
      });
      if (upper[1] < top) top = upper[1];
      if (lower[1] > bottom) bottom = lower[1];
    }
  }
  if (edges.length === 0) return;

  const yStart = Math.max(0, Math.ceil(top - 0.5));
  const yEnd = Math.min(mask.height - 1, Math.floor(bottom - 0.5));
  const crossings: number[] = [];
  for (let y = yStart; y <= yEnd; y++) {
    const scan = y + 0.5;
    crossings.length = 0;
    for (const edge of edges) {
      // Half-open in y: the top vertex belongs to the edge, the bottom does not.
      if (scan < edge.yMin || scan >= edge.yMax) continue;
      crossings.push(edge.x0 + (scan - edge.yMin) * edge.slope);
    }
    if (crossings.length < 2) continue;
    crossings.sort((a, b) => a - b);
    const row = y * mask.width;
    for (let i = 0; i + 1 < crossings.length; i += 2) {
      const from = Math.max(0, Math.ceil(crossings[i]! - 0.5));
      const to = Math.min(mask.width - 1, Math.floor(crossings[i + 1]! - 0.5));
      for (let x = from; x <= to; x++) mask.data[row + x] = 1;
    }
  }
}

function bresenham(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  plot: (x: number, y: number) => void,
): void {
  let x = Math.round(x0);
  let y = Math.round(y0);
  const ex = Math.round(x1);
  const ey = Math.round(y1);
  const dx = Math.abs(ex - x);
  const dy = -Math.abs(ey - y);
  const sx = x < ex ? 1 : -1;
  const sy = y < ey ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    plot(x, y);
    if (x === ex && y === ey) return;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
  }
}

/** A scattered measurement in cell coordinates (e.g. an NVE depth sounding). */
export interface SamplePoint {
  readonly x: number;
  readonly y: number;
  readonly value: number;
}

/**
 * Inverse-distance interpolation of scattered samples, bucketed on the search
 * radius so cost stays proportional to the samples actually nearby rather than
 * to every sounding in the lake. Cells with no sample inside the radius come
 * back as nodata — "not measured here" — for `fillNearest()` or a coverage gate
 * to deal with deliberately.
 */
export function idw(
  width: number,
  height: number,
  cellSizeM: number,
  points: readonly SamplePoint[],
  opts: { searchRadiusCells: number; power?: number },
): Grid {
  const out = createGrid(width, height, cellSizeM, Number.NaN);
  const radius = opts.searchRadiusCells;
  if (radius <= 0) throw new Error('idw: searchRadiusCells must be positive');
  if (points.length === 0) return out;
  const power = opts.power ?? 2;
  const radiusSq = radius * radius;

  const bucketSize = Math.max(1, Math.ceil(radius));
  const bx = Math.ceil(width / bucketSize);
  const by = Math.ceil(height / bucketSize);
  const buckets = new Map<number, SamplePoint[]>();
  for (const p of points) {
    const key =
      Math.min(by - 1, Math.max(0, Math.floor(p.y / bucketSize))) * bx +
      Math.min(bx - 1, Math.max(0, Math.floor(p.x / bucketSize)));
    const list = buckets.get(key);
    if (list) list.push(p);
    else buckets.set(key, [p]);
  }

  for (let y = 0; y < height; y++) {
    const cy = Math.floor(y / bucketSize);
    for (let x = 0; x < width; x++) {
      const cx = Math.floor(x / bucketSize);
      let weighted = 0;
      let weights = 0;
      let exact = Number.NaN;
      for (let j = cy - 1; j <= cy + 1 && !Number.isFinite(exact); j++) {
        if (j < 0 || j >= by) continue;
        for (let i = cx - 1; i <= cx + 1; i++) {
          if (i < 0 || i >= bx) continue;
          const list = buckets.get(j * bx + i);
          if (!list) continue;
          for (const p of list) {
            const dx = p.x - x;
            const dy = p.y - y;
            const dsq = dx * dx + dy * dy;
            if (dsq > radiusSq) continue;
            if (dsq < 1e-12) {
              exact = p.value;
              break;
            }
            const w = 1 / Math.pow(dsq, power / 2);
            weighted += w * p.value;
            weights += w;
          }
          if (Number.isFinite(exact)) break;
        }
      }
      out.data[y * width + x] = Number.isFinite(exact)
        ? exact
        : weights > 0
          ? weighted / weights
          : Number.NaN;
    }
  }
  return out;
}

/** One weighted input to a combine — a named signal, not an anonymous band. */
export interface CombineTerm {
  /** Stable key, matching a `SignalMeta` in `species.ts`. */
  readonly key: string;
  /** Short UI label, shown in the explain card. */
  readonly label: string;
  /** Relative weight; must be positive (penalties are low *values*, not negative weights). */
  readonly weight: number;
  /** 0..1 field, nodata where this signal has nothing to say here. */
  readonly grid: Grid;
  /** Plain-language reason for this term's value at a point (the D4 payload). */
  readonly describe?: (value: number) => string;
}

/**
 * Weighted combine with **per-pixel** renormalisation (`gdal_calc` with the
 * coverage rule the models actually need).
 *
 * Only terms that have a value at a pixel contribute, and the denominator is
 * their weights alone. AR5 stops at the tree line, `artfunksjon` covers only
 * surveyed ground, a lake may have no soundings at all — and in every one of
 * those cases the pixel must read "unknown", not "bad". A grid that is nodata
 * everywhere a signal is missing therefore costs the pixel nothing.
 *
 * Weights must be positive for the same reason: a negative weight would make
 * the renormalised denominator meaningless. A penalty (a regulated lake's
 * drawdown zone) is expressed as a term whose *value* is near zero.
 */
export function combine(terms: readonly CombineTerm[]): Grid {
  const first = terms[0];
  if (!first) throw new Error('combine: needs at least one term');
  for (const t of terms) {
    assertSameShape(first.grid, t.grid, `combine[${t.key}]`);
    if (!(t.weight > 0)) throw new Error(`combine[${t.key}]: weight must be positive`);
  }
  const { width, height, cellSizeM } = first.grid;
  const out = createGrid(width, height, cellSizeM, 0);
  for (let i = 0; i < out.data.length; i++) {
    let weighted = 0;
    let weights = 0;
    for (const t of terms) {
      const v = t.grid.data[i]!;
      if (!Number.isFinite(v)) continue;
      weighted += t.weight * v;
      weights += t.weight;
    }
    out.data[i] = weights > 0 ? weighted / weights : Number.NaN;
  }
  return out;
}

/** A local maximum of a surface — a candidate spot. */
export interface LocalMax {
  readonly x: number;
  readonly y: number;
  readonly value: number;
}

/**
 * Local maxima, thinned to a minimum separation — the raw half of "best spots
 * in view".
 *
 * A cell qualifies when it is at least as high as all eight neighbours.
 * Adjacent qualifying cells are necessarily *equal* (a higher neighbour would
 * disqualify the lower one), so they form a plateau — and each connected
 * plateau collapses to its **centroid** rather than contributing a candidate
 * per cell. Without that, a saturated hot area reports its corners: a signal
 * that maxes out along 200 m of steep shore would put its spots at the two ends
 * of the cliff and nothing in the middle, which is the opposite of the answer.
 *
 * Plateau centroids are then taken strongest-first, each accepted only if it
 * clears `minSeparationCells` from every spot already accepted.
 *
 * On its own this will happily find "maxima" on a dead-flat surface, which is
 * why `bestSpots()` runs the contrast gate first.
 */
export function localMaxima(
  grid: Grid,
  opts: { minSeparationCells: number; minValue?: number; limit?: number },
): LocalMax[] {
  const { width, height, data } = grid;
  const minValue = opts.minValue ?? Number.NEGATIVE_INFINITY;
  const sepSq = opts.minSeparationCells * opts.minSeparationCells;
  const limit = opts.limit ?? Number.POSITIVE_INFINITY;

  const candidateIndices = new Set<number>();
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = data[y * width + x]!;
      if (!Number.isFinite(v) || v < minValue) continue;
      let peak = true;
      for (let dy = -1; dy <= 1 && peak; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const n = data[ny * width + nx]!;
          if (Number.isFinite(n) && n > v) {
            peak = false;
            break;
          }
        }
      }
      if (peak) candidateIndices.add(y * width + x);
    }
  }

  // Collapse each connected plateau of equal-valued candidates to its centroid.
  const candidates: LocalMax[] = [];
  const seen = new Set<number>();
  for (const start of candidateIndices) {
    if (seen.has(start)) continue;
    const queue = [start];
    seen.add(start);
    let sumX = 0;
    let sumY = 0;
    const members: number[] = [];
    while (queue.length) {
      const index = queue.pop()!;
      members.push(index);
      const px = index % width;
      const py = (index - px) / width;
      sumX += px;
      sumY += py;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = py + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = px + dx;
          if (nx < 0 || nx >= width) continue;
          const neighbour = ny * width + nx;
          if (!candidateIndices.has(neighbour) || seen.has(neighbour)) continue;
          seen.add(neighbour);
          queue.push(neighbour);
        }
      }
    }
    const cx = sumX / members.length;
    const cy = sumY / members.length;
    // A non-convex plateau (a ring, a crescent) may not contain its own
    // centroid, so fall back to the member closest to it.
    let best = members[0]!;
    let bestDist = Number.POSITIVE_INFINITY;
    for (const index of members) {
      const px = index % width;
      const py = (index - px) / width;
      const dist = (px - cx) * (px - cx) + (py - cy) * (py - cy);
      if (dist < bestDist) {
        bestDist = dist;
        best = index;
      }
    }
    const bx = best % width;
    candidates.push({ x: bx, y: (best - bx) / width, value: data[best]! });
  }
  candidates.sort((a, b) => b.value - a.value || a.y - b.y || a.x - b.x);

  const spots: LocalMax[] = [];
  for (const c of candidates) {
    if (spots.length >= limit) break;
    let clear = true;
    for (const s of spots) {
      const dx = s.x - c.x;
      const dy = s.y - c.y;
      if (dx * dx + dy * dy < sepSq) {
        clear = false;
        break;
      }
    }
    if (clear) spots.push(c);
  }
  return spots;
}
