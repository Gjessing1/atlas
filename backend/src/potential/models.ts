import {
  burnPolyline,
  createMask,
  gridStats,
  mapValues,
  maxOf,
  proximityField,
  slopePercent,
  type Grid,
  type Mask,
} from '@atlas/potential';
import type { CellRaster } from './cells.js';
import { projectToRaster } from './cells.js';
import {
  STREAM_FICTITIOUS,
  STREAM_REAL_CHANNEL,
  type CellInputs,
  type InputRequest,
} from './inputs.js';

/**
 * The seam between the derive service and the engine.
 *
 * A model declares which inputs it needs and turns them into one raw score
 * surface. Everything after that — percentile ranking, the contrast gate, the
 * ramp, the PNG, the manifest — is the same for every model and lives in
 * `derive.ts`. So E3's lake model, E4's river model and E5's hunt model are each
 * a `DeriveModel` and nothing else; none of them touches HTTP, disk or tiles.
 */
export interface DeriveModel {
  /** URL and cache-path segment, e.g. `lake-fishing`. `[a-z0-9-]` only. */
  readonly layer: string;
  readonly label: string;
  /**
   * What the surface can be tuned for. A surface with no declared target is
   * meaningless (D4), so this is never empty; the first entry is the default.
   */
  readonly targets: readonly { readonly value: string; readonly label: string }[];
  /**
   * Model revision. Part of the cache path, so bumping it makes every cell
   * re-derive rather than serving arithmetic that no longer exists.
   */
  readonly rev: number;
  readonly inputs: InputRequest;
  /** Vocabulary for the legend words — a fisher casts, a hunter looks. */
  readonly vocabulary: 'fishing' | 'hunt';
  run(inputs: CellInputs, target: string): ModelResult;
}

export interface ModelResult {
  /**
   * Raw 0..1 score on the **padded** raster. `NaN` means "nothing to score
   * here" and is preserved all the way to a transparent pixel — an unsurveyed
   * lake or unmapped ground must show the basemap, not a cool-coloured verdict.
   */
  readonly score: Grid;
  /**
   * How good this water or ground is *at all*, 0..1, from the model's own
   * priors — D5's second number. Omitted when the model has no honest prior;
   * inferring one from the surface's own mean would be circular.
   */
  readonly absolute?: number;
  /** Plain-language notes for the manifest and the coverage message. */
  readonly notes: readonly string[];
}

/** Burn every path of a vector input onto a mask, in raster pixels. */
export function burnPaths(
  raster: CellRaster,
  paths: readonly (readonly (readonly [number, number])[])[],
  mask: Mask,
): number {
  let burned = 0;
  for (const path of paths) {
    if (path.length < 2) continue;
    burnPolyline(
      mask,
      path.map(([lng, lat]) => {
        const [x, y] = projectToRaster(raster, lng, lat);
        return [Math.round(x), Math.round(y)] as const;
      }),
    );
    burned++;
  }
  return burned;
}

/** Scale a grid to 0..1 by its own range, preserving NaN. Diagnostics only. */
function normalise(grid: Grid): Grid {
  const stats = gridStats(grid);
  const span = stats.max - stats.min;
  if (!(span > 0)) return mapValues(grid, (v) => (Number.isFinite(v) ? 0 : v));
  return mapValues(grid, (v) => (Number.isFinite(v) ? (v - stats.min) / span : v));
}

/**
 * The `inputs` layer — **a diagnostic surface, not a potential surface.**
 *
 * It exists because the derive pipeline needs to be verifiable end to end
 * against the real services *before* any model's opinion is shipped, and
 * "verifiable" here means at the real surface, not only in the quality gate. Its
 * two targets answer the two questions that can go wrong in the plumbing:
 *
 * - **`terrain`** — did the Kartverket DTM arrive on the right grid? It renders
 *   normalised slope, so ridges and valley walls must line up with the basemap's
 *   contours. A blank or shifted result is a fetch or projection bug.
 * - **`water`** — did the NVE vectors rasterise onto the same grid? It renders
 *   proximity to lake shorelines and real channels, so the hot lines must sit on
 *   the basemap's water. This is where a wrong `maxAllowableOffset` unit or a
 *   mis-set envelope projection shows up immediately.
 *
 * It is deliberately **not** in the layer catalog: no user is offered a heatmap
 * of an opinion nobody has formed yet. E3–E5 add the real models beside it, and
 * this one keeps earning its place as the answer to "is the pipeline healthy, or
 * is the model wrong?" — the spatial complement to the N7 probes.
 */
export const diagnosticModel: DeriveModel = {
  layer: 'inputs',
  label: 'Engine inputs (diagnostic)',
  targets: [
    { value: 'terrain', label: 'Elevation & slope' },
    { value: 'water', label: 'Lakes & channels' },
  ],
  rev: 1,
  inputs: { terrain: true, lakes: true, streams: true },
  vocabulary: 'fishing',
  run(inputs, target) {
    const { raster } = inputs;
    if (target === 'water') {
      const shore = createMask(raster.size, raster.size, raster.cellSizeM);
      let rings = 0;
      for (const lake of inputs.lakes) rings += burnPaths(raster, lake.rings, shore);
      const channels = createMask(raster.size, raster.size, raster.cellSizeM);
      let segments = 0;
      for (const stream of inputs.streams) {
        // Fictitious connectors are imaginary water — scoring them would put the
        // surface on channels that do not exist.
        if (stream.ltema === STREAM_FICTITIOUS) continue;
        if (stream.ltema !== STREAM_REAL_CHANNEL) continue;
        segments += burnPaths(raster, stream.paths, channels);
      }
      const notes = [`${rings} lake rings burned`, `${segments} real channels burned`];
      if (rings === 0 && segments === 0) {
        notes.push('No mapped water in this cell.');
        return { score: mapValues(shoreScore(shore), () => Number.NaN), notes };
      }
      return {
        score: maxOf(
          proximityField(shore, { halfDistanceM: 120, maxDistanceM: 600 }),
          proximityField(channels, { halfDistanceM: 80, maxDistanceM: 400 }),
        ),
        notes,
      };
    }
    // `terrain`
    if (!inputs.terrain) {
      const empty = createMask(raster.size, raster.size, raster.cellSizeM);
      return {
        score: mapValues(shoreScore(empty), () => Number.NaN),
        notes: ['No elevation data for this cell.'],
      };
    }
    const stats = gridStats(inputs.terrain);
    return {
      score: normalise(slopePercent(inputs.terrain)),
      notes: [
        `elevation ${Math.round(stats.min)}–${Math.round(stats.max)} m`,
        `mean slope ${gridStats(slopePercent(inputs.terrain)).mean.toFixed(1)} %`,
      ],
    };
  },
};

/** A zero grid shaped like a mask — the "nothing here" carrier. */
function shoreScore(mask: Mask): Grid {
  return {
    width: mask.width,
    height: mask.height,
    cellSizeM: mask.cellSizeM,
    data: new Float32Array(mask.width * mask.height),
  };
}

/**
 * Every model this build can derive. E3–E5 register their models here; the
 * routes 404 for anything absent, so a half-built model cannot be reached by
 * guessing a URL.
 */
export const DERIVE_MODELS: readonly DeriveModel[] = [diagnosticModel];

export function deriveModel(layer: string): DeriveModel | undefined {
  return DERIVE_MODELS.find((m) => m.layer === layer);
}

/** Resolve a requested target to one the model declares (never trust the query). */
export function resolveTarget(model: DeriveModel, requested: string | undefined): string {
  return model.targets.some((t) => t.value === requested) ? requested! : model.targets[0]!.value;
}
