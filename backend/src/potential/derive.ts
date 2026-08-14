import {
  createGrid,
  renderRamp,
  STAND_DIRECTIONS,
  STAND_MAX_RANGE_M,
  summariseSurface,
  type Grid,
  type PotentialCellManifest,
} from '@atlas/potential';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PNG } from 'pngjs';
import { CELL_MAX_TILE_ZOOM, CELL_PIXELS, CELL_ZOOM, cellRaster, type Cell } from './cells.js';
import { gatherInputs, type PotentialContext } from './inputs.js';
import { resolveTarget, type DeriveModel } from './models.js';

/**
 * One cell, derived: fetch the inputs, run the model, rank the surface, emit the
 * z11–z13 tiles and write the manifest.
 *
 * Everything model-specific is behind `DeriveModel`; everything here is the same
 * for a lake, a river or a hillside. The order matters and is not arbitrary —
 * the contrast gate (D5) runs on the **raw** score before ranking, because
 * ranking always manufactures a top decile and the gate is its counterweight.
 */

/**
 * Pipeline revision, independent of each model's own `rev`. Bump it when the
 * *shared* arithmetic changes (ranking, ramp, tile geometry) so every cell of
 * every layer re-derives, rather than serving new tiles built by old rules.
 */
export const ENGINE_REV = 2;

/**
 * Edge, in pixels, of the per-cell signal planes kept for the explain card.
 *
 * A quarter of the cell's own resolution — ~38 m per sample. The card answers
 * "why is this water good?", and a mean over the 38 m around the tap is both
 * cheaper to store and a *steadier* answer than one 9.6 m pixel, which can sit
 * on the edge of a drop-off band and report the wrong side of it. Storing the
 * full-resolution planes would multiply a cell's footprint by sixteen to make
 * the answer twitchier.
 */
export const SIGNAL_PIXELS = 256;

/** Reserved plane name for the ranked surface itself. */
const RANK_PLANE = 'rank';

/** Sentinel for "no value here" in a quantised plane; 0..254 carry 0..1. */
const SIGNAL_NODATA = 255;

/**
 * A derived cell's manifest. **The shape is the wire contract** — the same type
 * the clients read from `/api/potential/…/cell/x/y.json` and carry in a prepare
 * response — so it lives in `@atlas/potential` and is only named here.
 */
export type CellManifest = PotentialCellManifest;

/** Where a derived layer's artefacts live under the data dir. */
export function cellDir(dataDir: string, model: DeriveModel, target: string): string {
  return path.join(dataDir, 'potential', model.layer, target, `v${model.rev}.${ENGINE_REV}`);
}

export function tilePath(
  dataDir: string,
  model: DeriveModel,
  target: string,
  z: number,
  x: number,
  y: number,
): string {
  return path.join(cellDir(dataDir, model, target), String(z), String(x), `${y}.png`);
}

export function manifestPath(
  dataDir: string,
  model: DeriveModel,
  target: string,
  cell: Cell,
): string {
  return path.join(cellDir(dataDir, model, target), 'cell', String(cell.x), `${cell.y}.json`);
}

/** Where a cell's quantised signal planes live — beside its manifest. */
export function signalsPath(
  dataDir: string,
  model: DeriveModel,
  target: string,
  cell: Cell,
): string {
  return path.join(cellDir(dataDir, model, target), 'cell', String(cell.x), `${cell.y}.signals.gz`);
}

/**
 * Quantise one grid to a `SIGNAL_PIXELS`² byte plane by **block mean over the
 * valid samples**, so a block that is half nodata reports the half it knows
 * rather than being dragged toward zero — the same "missing means unknown" rule
 * the combine uses, applied to storage.
 */
export function quantisePlane(grid: Grid): Uint8Array {
  const out = new Uint8Array(SIGNAL_PIXELS * SIGNAL_PIXELS).fill(SIGNAL_NODATA);
  const step = Math.max(1, Math.round(grid.width / SIGNAL_PIXELS));
  for (let sy = 0; sy < SIGNAL_PIXELS; sy++) {
    for (let sx = 0; sx < SIGNAL_PIXELS; sx++) {
      let sum = 0;
      let n = 0;
      for (let dy = 0; dy < step; dy++) {
        const y = sy * step + dy;
        if (y >= grid.height) break;
        for (let dx = 0; dx < step; dx++) {
          const x = sx * step + dx;
          if (x >= grid.width) break;
          const v = grid.data[y * grid.width + x]!;
          if (Number.isFinite(v)) {
            sum += v;
            n++;
          }
        }
      }
      if (n === 0) continue;
      const mean = Math.max(0, Math.min(1, sum / n));
      out[sy * SIGNAL_PIXELS + sx] = Math.round(mean * (SIGNAL_NODATA - 1));
    }
  }
  return out;
}

/** Read one sample out of a plane; NaN for nodata or an out-of-range index. */
export function readSignal(planes: Buffer, planeIndex: number, sx: number, sy: number): number {
  if (sx < 0 || sy < 0 || sx >= SIGNAL_PIXELS || sy >= SIGNAL_PIXELS) return Number.NaN;
  const offset = planeIndex * SIGNAL_PIXELS * SIGNAL_PIXELS + sy * SIGNAL_PIXELS + sx;
  const raw = planes[offset];
  if (raw === undefined || raw === SIGNAL_NODATA) return Number.NaN;
  return raw / (SIGNAL_NODATA - 1);
}

/**
 * Read a whole plane back as a grid — what "best spots in view" ranks over.
 *
 * The planes were stored to answer *why is this point good?* one sample at a
 * time; the shortlist asks *which points are good?* of all 65 536 at once, and
 * re-running the model to find out would be both slow and a second
 * implementation of the arithmetic that drew the pixels. `cellSizeM` is the
 * ground size of a **signal** sample (four derive pixels), so a separation
 * measured in metres means the same thing here as everywhere else.
 */
export function readPlane(planes: Buffer, planeIndex: number, cellSizeM: number): Grid {
  const grid = createGrid(SIGNAL_PIXELS, SIGNAL_PIXELS, cellSizeM);
  const base = planeIndex * SIGNAL_PIXELS * SIGNAL_PIXELS;
  for (let i = 0; i < SIGNAL_PIXELS * SIGNAL_PIXELS; i++) {
    const raw = planes[base + i];
    grid.data[i] =
      raw === undefined || raw === SIGNAL_NODATA ? Number.NaN : raw / (SIGNAL_NODATA - 1);
  }
  return grid;
}

/** Read a cell's manifest, or null when it has not been derived at this revision. */
export async function readManifest(
  dataDir: string,
  model: DeriveModel,
  target: string,
  cell: Cell,
): Promise<CellManifest | null> {
  try {
    return JSON.parse(
      await readFile(manifestPath(dataDir, model, target, cell), 'utf8'),
    ) as CellManifest;
  } catch {
    return null;
  }
}

async function writeAtomic(file: string, data: Buffer | string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, file);
}

/**
 * Crop the padded derive raster back to the cell's own extent.
 *
 * The margin existed so focal operations had neighbours; keeping it would tile
 * the country with a visible grid of edge artefacts.
 */
export function cropToCell(grid: Grid, pad: number): Grid {
  const out = createGrid(CELL_PIXELS, CELL_PIXELS, grid.cellSizeM);
  for (let y = 0; y < CELL_PIXELS; y++) {
    const from = (y + pad) * grid.width + pad;
    out.data.set(grid.data.subarray(from, from + CELL_PIXELS), y * CELL_PIXELS);
  }
  return out;
}

/**
 * One 256² tile of a cell's ranked surface.
 *
 * Ranks are averaged over the block a tile pixel covers and *then* coloured,
 * never the other way round: the ramp is stepped so that the legend's words mean
 * exactly what the pixels mean, and averaging colours would invent shades that
 * are on no band. Blocks with no valid rank stay NaN and render transparent.
 */
export function tileFromRank(rank: Grid, offsetX: number, offsetY: number, scale: number): Buffer {
  const tile = createGrid(256, 256, rank.cellSizeM * scale);
  const step = Math.max(1, Math.round(scale));
  for (let ty = 0; ty < 256; ty++) {
    for (let tx = 0; tx < 256; tx++) {
      let sum = 0;
      let n = 0;
      for (let dy = 0; dy < step; dy++) {
        const sy = offsetY + ty * step + dy;
        if (sy >= rank.height) break;
        for (let dx = 0; dx < step; dx++) {
          const sx = offsetX + tx * step + dx;
          if (sx >= rank.width) break;
          const v = rank.data[sy * rank.width + sx]!;
          if (Number.isFinite(v)) {
            sum += v;
            n++;
          }
        }
      }
      tile.data[ty * 256 + tx] = n > 0 ? sum / n : Number.NaN;
    }
  }
  const png = new PNG({ width: 256, height: 256 });
  png.data = Buffer.from(renderRamp(tile));
  return PNG.sync.write(png);
}

export interface DeriveResult {
  readonly manifest: CellManifest;
  /** How many tiles were written (21 for a full z11–z13 pyramid). */
  readonly tiles: number;
}

export interface DeriveOptions {
  /**
   * This is a **repair** of a cell that already exists, and the value is the
   * attempt number (1 for the first). It only reaches the manifest, where it is
   * the backoff's clock: a cell that keeps coming back incomplete must be
   * retried more slowly each time, and the manifest is the only thing that
   * survives a restart to remember how often it has been tried.
   */
  readonly repairAttempt?: number;
}

/**
 * Derive one cell end to end. Throws only on a *pipeline* failure; an upstream
 * that did not answer is recorded in the manifest and left to the model, because
 * a missing input must read as "unknown", never as "bad ground".
 */
export async function deriveCell(
  dataDir: string,
  model: DeriveModel,
  requestedTarget: string,
  cell: Cell,
  ctx: PotentialContext,
  options: DeriveOptions = {},
): Promise<DeriveResult> {
  const target = resolveTarget(model, requestedTarget);
  const raster = cellRaster(cell);
  const inputs = await gatherInputs(
    raster,
    model.targetInputs ? { ...model.inputs, ...model.targetInputs(target) } : model.inputs,
    ctx,
  );
  const result = model.run(inputs, target);
  if (result.score.width !== raster.size || result.score.height !== raster.size) {
    throw new Error(
      `model ${model.layer} returned ${result.score.width}×${result.score.height}, expected ${raster.size}²`,
    );
  }

  const score = cropToCell(result.score, raster.pad);
  // The gate judges the raw score; ranking is what the ramp draws.
  const summary = summariseSurface(score, { absolute: result.absolute });
  const rank = summary.rank;

  const etag = createHash('sha256')
    .update(Buffer.from(rank.data.buffer, rank.data.byteOffset, rank.data.byteLength))
    .digest('hex')
    .slice(0, 16);

  let written = 0;
  for (let z = CELL_ZOOM; z <= CELL_MAX_TILE_ZOOM; z++) {
    const factor = 2 ** (z - CELL_ZOOM);
    const covered = CELL_PIXELS / factor;
    for (let ty = 0; ty < factor; ty++) {
      for (let tx = 0; tx < factor; tx++) {
        const png = tileFromRank(rank, tx * covered, ty * covered, covered / 256);
        await writeAtomic(
          tilePath(dataDir, model, target, z, cell.x * factor + tx, cell.y * factor + ty),
          png,
        );
        written++;
      }
    }
  }

  // The signals that produced the pixels, kept so the surface can later say
  // *why* (D4). Written before the manifest for the same reason the tiles are:
  // a manifest on disk promises that everything it describes is already there.
  const terms = result.terms ?? [];
  const standPlanes = result.standPlan
    ? [
        { name: 'stand-score', grid: result.standPlan.score },
        { name: 'stand-vantage', grid: result.standPlan.vantage },
        ...STAND_DIRECTIONS.flatMap((direction) => [
          { name: `stand-lane-${direction.key}`, grid: result.standPlan!.lanes[direction.key] },
          { name: `stand-pair-${direction.key}`, grid: result.standPlan!.pairs[direction.key] },
          { name: `stand-aim-${direction.key}`, grid: result.standPlan!.aims[direction.key] },
        ]),
      ]
    : [];
  const signals: CellManifest['signals'] =
    terms.length === 0
      ? null
      : {
          pixels: SIGNAL_PIXELS,
          planes: [RANK_PLANE, ...terms.map((t) => t.key), ...standPlanes.map((p) => p.name)],
          terms: terms.map((t) => ({
            key: t.key,
            label: t.label,
            weight: t.weight,
            ...(t.exclusive ? { exclusive: true } : {}),
          })),
          ...(result.standPlan
            ? {
                standPlan: {
                  maxRangeM: STAND_MAX_RANGE_M,
                  score: 'stand-score',
                  vantage: 'stand-vantage',
                  directions: STAND_DIRECTIONS.map((direction) => ({
                    ...direction,
                    lane: `stand-lane-${direction.key}`,
                    pair: `stand-pair-${direction.key}`,
                    aim: `stand-aim-${direction.key}`,
                  })),
                },
              }
            : {}),
        };
  if (signals) {
    const planes = [
      rank,
      ...terms.map((t) => cropToCell(t.grid, raster.pad)),
      ...standPlanes.map((plane) => cropToCell(plane.grid, raster.pad)),
    ].map(quantisePlane);
    const blob = Buffer.alloc(planes.length * SIGNAL_PIXELS * SIGNAL_PIXELS);
    planes.forEach((plane, i) => blob.set(plane, i * SIGNAL_PIXELS * SIGNAL_PIXELS));
    await writeAtomic(signalsPath(dataDir, model, target, cell), gzipSync(blob));
  }

  const valid = summary.contrast.validCells / (CELL_PIXELS * CELL_PIXELS);
  // A repair that came back whole clears the counter by omitting it: the field
  // describes a gap that is still there, not a scar.
  const unreadInputs = inputs.records.some((r) => !r.ok);
  const repairs = unreadInputs ? (options.repairAttempt ?? 0) : 0;
  const manifest: CellManifest = {
    cell: `${cell.z}/${cell.x}/${cell.y}`,
    layer: model.layer,
    target,
    rev: model.rev,
    engineRev: ENGINE_REV,
    derivedAt: Date.now(),
    cellSizeM: Math.round(raster.cellSizeM * 100) / 100,
    bounds: raster.cellBounds,
    inputs: inputs.records,
    contrast: {
      standout: summary.contrast.standout,
      validCells: summary.contrast.validCells,
      spread: Math.round(summary.contrast.spread * 1000) / 1000,
      reason: summary.contrast.reason,
    },
    tier: summary.tierLabel,
    notes: result.notes,
    coverage: Math.round(valid * 1000) / 1000,
    etag,
    ...(repairs > 0 ? { repairs } : {}),
    vocabulary: model.vocabulary,
    signals,
  };
  // Written last, so a manifest on disk always means the tiles beside it are
  // complete: the routes treat its presence as "this cell is ready".
  await writeAtomic(manifestPath(dataDir, model, target, cell), JSON.stringify(manifest, null, 2));
  return { manifest, tiles: written };
}
