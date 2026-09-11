import {
  altitudePlausible,
  createGrid,
  createMask,
  describeLakeSignal,
  distanceToMask,
  fillNearest,
  fillRings,
  FISH_SPECIES,
  fishSpecies,
  lakeProductivity,
  lakeRegulation,
  lakeSurface,
  magnitudeFromStrahler,
  seasonAt,
  weightsCaption,
  type FishSpecies,
  type Grid,
  type LakeInputs,
  type Mask,
} from '@atlas/potential';
import { burnPaths, projectToRaster, type CellRaster } from './cells.js';
import {
  inputFailed,
  STREAM_REAL_CHANNEL,
  type CellInputs,
  type DepthContour,
  type LakeFeature,
  type SpeciesObservation,
  type StreamFeature,
} from './inputs.js';
import type { DeriveModel, ModelResult } from './models.js';

/**
 * The adapter between NVE's vectors and `@atlas/potential`'s lake model.
 *
 * Everything geographic happens here — projecting lon/lat onto the cell raster,
 * filling lake polygons, deciding which end of a stream is the outlet,
 * interpolating a bathymetry out of digitised contours. The engine sees only
 * grids and masks, which is what keeps the opinions unit-testable and, one day,
 * runnable on a phone.
 *
 * The model *choice* is a single attribute, not a heuristic: lake register
 * layer 5's `dybdekart='J'`. nodemap probed for "≥8 soundings or ≥8 contour
 * vertices" with two paged queries; NVE answers it in a field, for all 267 194
 * lakes, and only 607 of them say yes.
 */

/** How far outside a lake a stream vertex still counts as reaching it. */
const MOUTH_TOLERANCE_M = 60;

/** How far along a channel, away from the water, the descent test samples. */
const DESCENT_SAMPLE_M = 120;

/** A descent smaller than this is DTM noise rather than a flowing outlet. */
const MIN_DESCENT_M = 0.5;

/**
 * Contour levels interpolated per lake. A survey with more levels than this is
 * thinned evenly rather than refused — the cost is one distance transform per
 * level, and past a dozen the extra detail is below the raster's own resolution.
 */
const MAX_DEPTH_LEVELS = 12;

/** Lakes the surface can be tuned for: the species with lake weights at all. */
const LAKE_TARGETS = FISH_SPECIES.filter((s) => Object.keys(s.lakeWeights).length > 0);

/** Paint each lake's own polygon, and record which lake owns each pixel. */
interface PaintedLakes {
  readonly water: Mask;
  /** Index into `lakes`, plus one; 0 means "not water". */
  readonly owner: Int32Array;
  /** Pixels burned per lake — the honest weight for a lake clipped by the cell. */
  readonly pixels: number[];
}

function paintLakes(raster: CellRaster, lakes: readonly LakeFeature[]): PaintedLakes {
  const water = createMask(raster.size, raster.size, raster.cellSizeM);
  const owner = new Int32Array(raster.size * raster.size);
  const pixels = lakes.map(() => 0);
  const scratch = createMask(raster.size, raster.size, raster.cellSizeM);
  for (let index = 0; index < lakes.length; index++) {
    scratch.data.fill(0);
    fillRings(
      scratch,
      lakes[index]!.rings.map((ring) => ring.map((c) => project(raster, c))),
    );
    for (let i = 0; i < scratch.data.length; i++) {
      if (scratch.data[i] !== 1) continue;
      water.data[i] = 1;
      owner[i] = index + 1;
      pixels[index]!++;
    }
  }
  return { water, owner, pixels };
}

function project(raster: CellRaster, [lng, lat]: readonly [number, number]): [number, number] {
  const [x, y] = projectToRaster(raster, lng, lat);
  return [x, y];
}

/** A stream reaching a lake's shoreline, and which way its water is going. */
interface Mouth {
  readonly lake: number;
  readonly stream: StreamFeature;
  /** Metres the channel falls over `DESCENT_SAMPLE_M` away from the lake. */
  readonly descent: number;
}

/**
 * Which channels touch which lakes, and which one of them is the outlet.
 *
 * Water flows downhill, so the outlet is decided by elevation rather than by
 * guessing from the network's topology: sample the DTM a fixed distance along
 * each channel *away* from the water and compare it with the lake's own surface
 * height. The channel that falls the most is the outlet; every other mouth is an
 * inflow. A lake has one outlet, so this needs no threshold beyond rejecting
 * DTM noise — and it degrades sensibly, because with no DTM the highest Strahler
 * order carries the same meaning (every inflow merges into the outflow).
 */
function classifyMouths(
  raster: CellRaster,
  streams: readonly StreamFeature[],
  painted: PaintedLakes,
  lakes: readonly LakeFeature[],
  terrain: Grid | null,
): { inflows: StreamFeature[]; outflows: StreamFeature[] } {
  const sampleCells = DESCENT_SAMPLE_M / raster.cellSizeM;
  const toWater = distanceToMask(painted.water);

  const mouths: Mouth[] = [];
  for (const stream of streams) {
    if (stream.ltema !== STREAM_REAL_CHANNEL) continue;
    for (const path of stream.paths) {
      const points = path.map((c) => project(raster, c));
      // Which lake, if any, this path reaches — the first owner it touches.
      let lake = 0;
      let touchIndex = -1;
      for (let i = 0; i < points.length; i++) {
        const [px, py] = points[i]!;
        const x = Math.round(px);
        const y = Math.round(py);
        if (x < 0 || y < 0 || x >= raster.size || y >= raster.size) continue;
        const index = y * raster.size + x;
        if (painted.owner[index]! > 0) {
          lake = painted.owner[index]!;
          touchIndex = i;
          break;
        }
        if (toWater.data[index]! <= MOUTH_TOLERANCE_M && touchIndex < 0) touchIndex = i;
      }
      if (lake === 0 || touchIndex < 0) continue;

      // Walk away from the water along the path and read the drop.
      const descent = terrain
        ? descentAlong(points, touchIndex, sampleCells, terrain, raster, lakes[lake - 1]!, painted)
        : Number.NaN;
      mouths.push({ lake, stream, descent });
    }
  }

  // Per lake, the steepest descender is the outlet. Everything else flows in.
  const outletOf = new Map<number, StreamFeature>();
  const best = new Map<number, number>();
  for (const mouth of mouths) {
    const score = Number.isFinite(mouth.descent)
      ? mouth.descent
      : // No DTM: fall back to Strahler, offset below any real descent so the
        // two rankings can never be compared against each other.
        -1000 + magnitudeFromStrahler(mouth.stream.strahler ?? 0);
    const current = best.get(mouth.lake);
    if (current === undefined || score > current) {
      best.set(mouth.lake, score);
      outletOf.set(mouth.lake, mouth.stream);
    }
  }
  for (const [lake, score] of best) {
    // A channel that does not actually fall is not an outlet; some lakes in a
    // cell only have inflows, because their outlet is outside it.
    if (score < MIN_DESCENT_M && score > -1000) outletOf.delete(lake);
  }

  const outflows = [...new Set(outletOf.values())];
  const outflowSet = new Set(outflows);
  const inflows = [...new Set(mouths.map((m) => m.stream))].filter((s) => !outflowSet.has(s));
  return { inflows, outflows };
}

/**
 * Elevation drop from the lake surface to a point along the channel outside it.
 *
 * The sample must be **outside the water**, which is not a detail: the DTM over
 * a lake is not reliably the water surface, so a sample taken along the part of
 * the channel that Elvenett draws *through* the lake can report a metre of fall
 * that is really just bathymetry or noise — and every inflow would then look
 * like an outlet.
 */
function descentAlong(
  points: readonly (readonly [number, number])[],
  touchIndex: number,
  sampleCells: number,
  terrain: Grid,
  raster: CellRaster,
  lake: LakeFeature,
  painted: PaintedLakes,
): number {
  const indexAt = (px: number, py: number): number => {
    const x = Math.round(px);
    const y = Math.round(py);
    if (x < 0 || y < 0 || x >= raster.size || y >= raster.size) return -1;
    return y * raster.size + x;
  };
  const surfaceIndex = indexAt(...points[touchIndex]!);
  const surface = lake.elevationM ?? (surfaceIndex >= 0 ? terrain.data[surfaceIndex]! : Number.NaN);
  if (!Number.isFinite(surface)) return Number.NaN;

  // Both directions along the path lead away from the touch point; take
  // whichever falls furthest at the sample distance.
  let bestDrop = Number.NaN;
  for (const step of [-1, 1]) {
    let travelled = 0;
    for (let i = touchIndex; i + step >= 0 && i + step < points.length; i += step) {
      const [ax, ay] = points[i]!;
      const [bx, by] = points[i + step]!;
      travelled += Math.hypot(bx - ax, by - ay);
      if (travelled < sampleCells) continue;
      const index = indexAt(bx, by);
      if (index < 0) break;
      if (painted.water.data[index] === 1) continue; // still on the lake: keep walking
      const elevation = terrain.data[index]!;
      if (!Number.isFinite(elevation)) break;
      const drop = surface - elevation;
      if (!Number.isFinite(bestDrop) || drop > bestDrop) bestDrop = drop;
      break;
    }
  }
  return bestDrop;
}

/**
 * Depth below the surface, interpolated from digitised contours — the
 * bathymetric model's input, built one lake at a time.
 *
 * **Per lake, and inverse-distance between whole contour *lines*, not their
 * vertices.** Both halves are lessons paid for elsewhere: interpolating from
 * vertices makes the bottom bead around each one, so the drop-off signal lights
 * up as concentric scalloped rings; and interpolating across lakes together
 * would drag a shallow pond toward a deep neighbour's contours simply because
 * they are near each other on the raster.
 *
 * The shoreline is the 0 m level, which is what makes a single mapped contour
 * enough to produce a gradient at all — and a gradient is the whole point,
 * because a drop-off is where the levels crowd together.
 */
function interpolateDepth(
  raster: CellRaster,
  painted: PaintedLakes,
  lakes: readonly LakeFeature[],
  contours: readonly DepthContour[],
): { depth: Grid | null; surveyed: number } {
  const surveyedIndices = lakes
    .map((lake, index) => ({ lake, index }))
    .filter(({ lake }) => lake.surveyed && painted.pixels[lakes.indexOf(lake)]! > 0);
  if (surveyedIndices.length === 0) return { depth: null, surveyed: 0 };

  const depth = createGrid(raster.size, raster.size, raster.cellSizeM);
  let surveyed = 0;

  for (const { lake, index } of surveyedIndices) {
    // Contours carry `vatnlnr`, so they join to their own lake exactly; a lake
    // whose contours did not come back simply has no bathymetry here.
    const own = contours.filter((c) => c.vatnlnr !== null && c.vatnlnr === lake.vatnlnr);
    if (own.length === 0) continue;

    const levels = new Map<number, Mask>();
    /** The shoreline is depth 0 — the level every survey has for free. */
    const shore = createMask(raster.size, raster.size, raster.cellSizeM);
    for (const ring of lake.rings) {
      burnPaths(raster, [ring], shore);
    }
    levels.set(0, shore);

    const distinct = [...new Set(own.map((c) => c.depthM))].sort((a, b) => a - b);
    const step = Math.max(1, Math.ceil(distinct.length / MAX_DEPTH_LEVELS));
    const kept = new Set(distinct.filter((_, i) => i % step === 0 || i === distinct.length - 1));
    for (const contour of own) {
      if (!kept.has(contour.depthM)) continue;
      let mask = levels.get(contour.depthM);
      if (!mask) {
        mask = createMask(raster.size, raster.size, raster.cellSizeM);
        levels.set(contour.depthM, mask);
      }
      burnPaths(raster, contour.paths, mask);
    }
    if (levels.size < 2) continue;

    // One exact distance transform per level: inverse-square weighting between
    // them is smooth, has no vertex artefacts, and steepens exactly where the
    // contours crowd — which is the drop-off the model is looking for.
    const fields = [...levels].map(([value, mask]) => ({ value, distance: distanceToMask(mask) }));
    for (let i = 0; i < depth.data.length; i++) {
      if (painted.owner[i] !== index + 1) continue;
      let weighted = 0;
      let weights = 0;
      let exact = Number.NaN;
      for (const field of fields) {
        const d = field.distance.data[i]!;
        if (d <= 0) {
          exact = field.value;
          break;
        }
        if (!Number.isFinite(d)) continue;
        const w = 1 / (d * d);
        weighted += w * field.value;
        weights += w;
      }
      depth.data[i] = Number.isFinite(exact)
        ? exact
        : weights > 0
          ? weighted / weights
          : Number.NaN;
    }
    surveyed++;
  }

  return surveyed > 0 ? { depth, surveyed } : { depth: null, surveyed: 0 };
}

/** Paint one 0..1 value per lake over that lake's own pixels. */
function perLakeGrid(
  raster: CellRaster,
  painted: PaintedLakes,
  valueOf: (lake: LakeFeature) => number,
  lakes: readonly LakeFeature[],
): Grid {
  const values = lakes.map(valueOf);
  const grid = createGrid(raster.size, raster.size, raster.cellSizeM);
  for (let i = 0; i < grid.data.length; i++) {
    const owner = painted.owner[i]!;
    if (owner > 0) grid.data[i] = values[owner - 1]!;
  }
  return grid;
}

/**
 * Lake fishing potential — the Fish & Hunt profile's headline surface.
 *
 * The target is a species, because a surface with no declared target is
 * meaningless: gjedde want the weedy cove that ørret ignore, and røye hold 20 m
 * below both. The engine does not branch on any of them — a target selects a row
 * of weights and a depth band, which is what makes this reviewable by someone
 * who fishes rather than someone who reads TypeScript.
 */
export const lakeModel: DeriveModel = {
  layer: 'lake-fishing',
  label: 'Lake fishing potential',
  targets: LAKE_TARGETS.map((s) => ({
    value: s.id,
    label: s.nameNo,
    caption: weightsCaption(s.nameEn, s.lakeWeights, 'shoreline structure'),
  })),
  rev: 2,
  catalog: true,
  inputs: { terrain: true, lakes: true, streams: true, depthContours: true, landCover: true },
  targetInputs(target) {
    const species = fishSpecies(target);
    return species?.presenceTaxonId ? { observationsTaxonId: species.presenceTaxonId } : {};
  },
  vocabulary: 'fishing',
  describeSignal(key, value, target, derivedAt) {
    const species = fishSpecies(target) ?? LAKE_TARGETS[0]!;
    return describeLakeSignal(key as Parameters<typeof describeLakeSignal>[0], value, {
      species,
      season: seasonAt(new Date(derivedAt)),
    });
  },
  run(inputs: CellInputs, target: string): ModelResult {
    const { raster } = inputs;
    const species = fishSpecies(target) ?? LAKE_TARGETS[0]!;
    const empty = createGrid(raster.size, raster.size, raster.cellSizeM);

    const lakes = inputs.lakes.filter((l) => l.rings.length > 0);
    if (lakes.length === 0) {
      return { score: empty, notes: ['No mapped lakes in this area.'] };
    }

    const painted = paintLakes(raster, lakes);
    const observed = observedLakes(raster, painted, inputs.observations);
    const { inflows, outflows } = classifyMouths(
      raster,
      inputs.streams,
      painted,
      lakes,
      inputs.terrain,
    );

    const inflowMask = createMask(raster.size, raster.size, raster.cellSizeM);
    for (const stream of inflows) burnPaths(raster, stream.paths, inflowMask);
    const outflowMask = createMask(raster.size, raster.size, raster.cellSizeM);
    for (const stream of outflows) burnPaths(raster, stream.paths, outflowMask);

    // Strahler order of the nearest inflow, spread across the raster so a
    // mouth's size reaches the water in front of it.
    const magnitudeSeed = createGrid(raster.size, raster.size, raster.cellSizeM);
    for (const stream of inflows) {
      if (stream.strahler === null) continue;
      const seed = createMask(raster.size, raster.size, raster.cellSizeM);
      burnPaths(raster, stream.paths, seed);
      const value = magnitudeFromStrahler(stream.strahler);
      for (let i = 0; i < seed.data.length; i++) {
        if (seed.data[i] === 1) magnitudeSeed.data[i] = value;
      }
    }
    const hasMagnitude = magnitudeSeed.data.some((v) => Number.isFinite(v));

    const { depth, surveyed } = interpolateDepth(raster, painted, lakes, inputs.depthContours);

    const modelInputs: LakeInputs = {
      water: painted.water,
      terrain: inputs.terrain,
      depthM: depth,
      inflows: inflowMask,
      outflows: outflowMask,
      inflowMagnitude: hasMagnitude ? fillNearest(magnitudeSeed) : null,
      landCover: inputs.landCover,
      productivity: perLakeGrid(raster, painted, lakeProductivity, lakes),
      regulated: perLakeGrid(raster, painted, (l) => lakeRegulation(l.kind), lakes),
    };

    const surface = lakeSurface(modelInputs, {
      species,
      season: seasonAt(new Date()),
    });

    return {
      score: surface.score,
      absolute: absoluteTier(lakes, painted),
      notes: [
        ...surface.notes,
        ...describeCell(inputs, lakes, species, surveyed, surface.depthBandLabel, observed),
      ],
      terms: surface.terms,
    };
  },
};

/**
 * The cell's absolute water quality, weighted by how much of each lake is
 * actually in it — a lake clipped to one corner should not decide the tier for
 * the water beside it.
 */
function absoluteTier(lakes: readonly LakeFeature[], painted: PaintedLakes): number | undefined {
  let weighted = 0;
  let weights = 0;
  for (let i = 0; i < lakes.length; i++) {
    const pixels = painted.pixels[i]!;
    if (pixels === 0) continue;
    weighted += pixels * lakeProductivity(lakes[i]!);
    weights += pixels;
  }
  return weights > 0 ? weighted / weights : undefined;
}

interface ObservedLakes {
  readonly indexes: ReadonlySet<number>;
  readonly observations: readonly SpeciesObservation[];
}

/** Assign precise point records to the lake polygons already painted for scoring. */
function observedLakes(
  raster: CellRaster,
  painted: PaintedLakes,
  observations: readonly SpeciesObservation[],
): ObservedLakes {
  const indexes = new Set<number>();
  const inside: SpeciesObservation[] = [];
  for (const observation of observations) {
    const [px, py] = project(raster, observation.position);
    const x = Math.round(px);
    const y = Math.round(py);
    if (x < 0 || y < 0 || x >= raster.size || y >= raster.size) continue;
    const owner = painted.owner[y * raster.size + x]!;
    if (owner === 0) continue;
    indexes.add(owner - 1);
    inside.push(observation);
  }
  return { indexes, observations: inside };
}

/** Plain-language notes for the manifest — coverage, model choice, caveats. */
function describeCell(
  inputs: CellInputs,
  lakes: readonly LakeFeature[],
  species: FishSpecies,
  surveyed: number,
  depthBandLabel: string | null,
  observed: ObservedLakes,
): string[] {
  const notes: string[] = [];
  notes.push(
    surveyed > 0
      ? `${surveyed} of ${lakes.length} lakes have an NVE depth survey; the rest are read from their shores.`
      : `None of the ${lakes.length} lakes here has an NVE depth survey, so the shore model is reading the banks. That is the normal case — only 607 of Norway's 267 194 lakes are surveyed.`,
  );
  if (depthBandLabel) notes.push(depthBandLabel);

  // Altitude is only the fallback for target plausibility, and it is stated
  // rather than silently applied: presence-only data means a lake with no
  // recorded observation proves nothing either way.
  const implausible = lakes.filter(
    (l, index) =>
      l.elevationM !== null &&
      !altitudePlausible(species, l.elevationM, observed.indexes.has(index) ? true : undefined),
  );
  if (
    implausible.length > 0 &&
    implausible.length === lakes.filter((l) => l.elevationM !== null).length
  ) {
    notes.push(
      `${species.nameNo} is unlikely this high — these lakes sit above ${species.plausibleMaxAltitudeM} m. Try ørret or røye.`,
    );
  }

  if (observed.observations.length > 0) {
    const years = observed.observations
      .map((observation) => observation.observedYear)
      .filter((year): year is number => year !== null);
    const newest = years.length > 0 ? Math.max(...years) : null;
    notes.push(
      `Artskart has ${observed.observations.length} precise ${species.nameNo.toLowerCase()} record${observed.observations.length === 1 ? '' : 's'} inside ${observed.indexes.size} lake${observed.indexes.size === 1 ? '' : 's'} here${newest ? ` (newest ${newest})` : ''}. This confirms presence; an unrecorded lake would not prove absence.`,
    );
  } else if (species.presenceTaxonId && inputFailed(inputs, 'observations')) {
    notes.push('Artskart did not answer, so target plausibility uses the altitude fallback only.');
  }

  const reservoirs = lakes.filter((l) => l.reservoirPurpose?.includes('Vannforsyning'));
  if (reservoirs.length > 0) {
    notes.push(
      'One or more lakes here are drinking-water reservoirs, where fishing and boating are often banned. Check locally.',
    );
  }
  return notes;
}
