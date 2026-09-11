import {
  createGrid,
  createMask,
  curvatureDegProfile,
  describeRiverSignal,
  dischargeM3s,
  fillRings,
  FISH_SPECIES,
  fishSpecies,
  gradientBreakProfile,
  gradientPercentProfile,
  magnitudeFromDischarge,
  magnitudeFromStrahler,
  monotonicDownstream,
  resampleLine,
  riverQuality,
  riverSurface,
  sampleAlong,
  setValue,
  smoothProfile,
  weightsCaption,
  classifyChannel,
  type CellPoint,
  type FishSpecies,
  type Grid,
  type Mask,
  type RiverInputs,
  type RiverSignalKey,
} from '@atlas/potential';
import { burnPaths, projectToRaster, type CellRaster } from './cells.js';
import {
  inputFailed,
  isAbsoluteBarrier,
  STREAM_REAL_CHANNEL,
  type CatchmentFeature,
  type CellInputs,
  type MigrationBarrier,
  type StreamFeature,
} from './inputs.js';
import type { DeriveModel, ModelResult } from './models.js';

/**
 * The adapter between NVE's and Miljødirektoratet's vectors and
 * `@atlas/potential`'s river model.
 *
 * Everything geographic happens here — projecting lon/lat onto the cell raster,
 * deciding which end of a channel is upstream, finding the junctions of the
 * network, painting catchment discharge, burning the anadromous stretches. The
 * engine sees only grids and masks.
 *
 * **The channel signals are built once and shared by both kinds of fish.** An
 * anadromous target changes exactly two things: the surface is gated to water
 * the fish can reach, and the barrier pool below the first impassable falls is
 * weighted. Everything else — gradient, seams, confluences, bends, size, cover
 * — describes what the water is doing and is the same reading either way.
 */

/**
 * How far apart the along-channel profile is sampled, in metres.
 *
 * Three raster pixels. Finer would resolve nothing the 9.6 m DTM has to say;
 * coarser and a 200 m reach window would rest on three samples.
 */
const CHANNEL_SAMPLE_M = 30;

/** Samples averaged before the profile is forced downhill — see `smoothProfile`. */
const PROFILE_SMOOTH_SAMPLES = 3;

/** Reach length the water-surface gradient is measured over. */
const GRADIENT_WINDOW_M = 200;

/** Reach length compared ahead and behind to find a current seam. */
const BREAK_WINDOW_M = 300;

/** Reach length a bend is measured across. */
const BEND_WINDOW_M = 250;

/**
 * Strahler order the *smallest* channel at a junction must reach before it
 * counts as a confluence.
 *
 * The smallest is the discriminator, and nothing else is: NVE splits a river at
 * every junction, so a node always carries the two halves of the main stem plus
 * whatever joined. A ditch entering the Glomma therefore looks like `[8, 1, 8]`
 * and a real tributary like `[8, 4, 8]` — identical unless the *minimum* is what
 * is asked about. In a headwater cell there are hundreds of the former, and
 * scoring them would spend the signal's whole contrast on ditch mouths.
 *
 * A **null** order does not lower the minimum: the house rule is that a missing
 * attribute must never demote, and Strahler is documented as complete on real
 * channels anyway.
 */
const CONFLUENCE_MIN_STRAHLER = 2;

/** Rivers the surface can be tuned for: the species with river weights at all. */
const RIVER_TARGETS = FISH_SPECIES.filter((s) => Object.keys(s.riverWeights).length > 0);

function project(raster: CellRaster, [lng, lat]: readonly [number, number]): CellPoint {
  const [x, y] = projectToRaster(raster, lng, lat);
  return { x, y };
}

/**
 * Orient a sampled channel so index 0 is **upstream**.
 *
 * `monotonicDownstream` takes a running minimum, so a path handed to it
 * backwards produces a staircase of nonsense rather than an obvious error. NVE
 * does not promise a direction on `Elvenett1`, so the ground decides: compare
 * the ends of the elevation profile and reverse when the far end is the higher
 * one. The comparison uses a fifth of the profile at each end rather than the
 * two endpoint samples, which on a lowland reach are within the DTM's own noise
 * of each other.
 */
export function orientDownstream(elevation: readonly number[]): number[] {
  const end = (from: number, to: number): number => {
    let sum = 0;
    let n = 0;
    for (let i = from; i < to; i++) {
      const v = elevation[i]!;
      if (Number.isFinite(v)) {
        sum += v;
        n++;
      }
    }
    return n > 0 ? sum / n : Number.NaN;
  };
  const fifth = Math.max(1, Math.round(elevation.length / 5));
  const head = end(0, fifth);
  const tail = end(elevation.length - fifth, elevation.length);
  // Equal or unknown: leave it alone. A profile with no elevation carries no
  // gradient either, so the orientation cannot matter.
  const order = elevation.map((_, i) => i);
  return Number.isFinite(head) && Number.isFinite(tail) && tail > head ? order.reverse() : order;
}

/** Catchment mean discharge in m³/s per pixel, painted from the polygons. */
function paintDischarge(raster: CellRaster, catchments: readonly CatchmentFeature[]): Grid | null {
  if (catchments.length === 0) return null;
  const grid = createGrid(raster.size, raster.size, raster.cellSizeM);
  const scratch = createMask(raster.size, raster.size, raster.cellSizeM);
  let painted = 0;
  for (const catchment of catchments) {
    if (catchment.qnormalMm3aar === null || catchment.rings.length === 0) continue;
    const flow = dischargeM3s(catchment.qnormalMm3aar);
    scratch.data.fill(0);
    fillRings(
      scratch,
      catchment.rings.map((ring) =>
        ring.map((c) => {
          const p = project(raster, c);
          return [p.x, p.y] as const;
        }),
      ),
    );
    for (let i = 0; i < scratch.data.length; i++) {
      if (scratch.data[i] !== 1) continue;
      grid.data[i] = flow;
      painted++;
    }
  }
  return painted > 0 ? grid : null;
}

/**
 * Junctions where a real tributary meets a real river.
 *
 * Read off the network's own nodes rather than looked for in the raster: NVE
 * splits every channel at its confluences, so a junction is simply a coordinate
 * three or more real-channel ends share. Lake through-flow centrelines are
 * already excluded by the caller, which matters — a stream entering a lake would
 * otherwise read as a confluence, and that lie belongs to the lake model's inlet
 * signal where it is told properly.
 */
export function confluenceNodes(
  streams: readonly StreamFeature[],
): { readonly point: readonly [number, number]; readonly branches: number }[] {
  const nodes = new Map<string, { point: readonly [number, number]; orders: (number | null)[] }>();
  const note = (point: readonly [number, number], order: number | null): void => {
    const key = `${point[0].toFixed(6)},${point[1].toFixed(6)}`;
    const entry = nodes.get(key);
    if (entry) entry.orders.push(order);
    else nodes.set(key, { point, orders: [order] });
  };
  for (const stream of streams) {
    for (const path of stream.paths) {
      if (path.length < 2) continue;
      note(path[0]!, stream.strahler);
      note(path[path.length - 1]!, stream.strahler);
    }
  }
  const out: { point: readonly [number, number]; branches: number }[] = [];
  for (const { point, orders } of nodes.values()) {
    if (orders.length < 3) continue;
    const known = orders.filter((o): o is number => o !== null);
    if (known.length > 0 && Math.min(...known) < CONFLUENCE_MIN_STRAHLER) continue;
    out.push({ point, branches: orders.length });
  }
  return out;
}

/** Everything the model needs about the channels, built one path at a time. */
interface ChannelFields {
  readonly channel: Mask;
  readonly gradientPercent: Grid | null;
  readonly gradientBreakPercent: Grid | null;
  readonly bendDeg: Grid | null;
  readonly magnitude: Grid | null;
  /**
   * Water-surface elevation on the channel, smoothed and forced downhill — the
   * same profile the gradients are measured from, kept rather than discarded.
   *
   * The raw DTM cannot answer "is this water below that water": around Vestfoss
   * it swings 1.6 m to 12.6 m inside three pixels, because a falls is where the
   * ground is steepest and a 9.6 m cell straddles bank, gorge and river. The
   * monotonic profile has that noise removed by construction — along a reach it
   * only ever descends — so the *sign* of a difference along it is trustworthy
   * even where the metres are not.
   */
  readonly channelElevation: Grid | null;
  /** Metres of channel actually sampled — the honest denominator for the notes. */
  readonly sampledM: number;
}

function buildChannels(
  raster: CellRaster,
  streams: readonly StreamFeature[],
  terrain: Grid | null,
  discharge: Grid | null,
): ChannelFields {
  const size = raster.size;
  const channel = createMask(size, size, raster.cellSizeM);
  const gradientPercent = createGrid(size, size, raster.cellSizeM);
  const gradientBreakPercent = createGrid(size, size, raster.cellSizeM);
  const bendDeg = createGrid(size, size, raster.cellSizeM);
  const magnitude = createGrid(size, size, raster.cellSizeM);
  const channelElevation = createGrid(size, size, raster.cellSizeM);
  const spacingCells = CHANNEL_SAMPLE_M / raster.cellSizeM;
  let sampledM = 0;
  let anyGradient = false;
  let anyMagnitude = false;

  for (const stream of streams) {
    burnPaths(raster, stream.paths, channel);
    const strahler = stream.strahler === null ? null : magnitudeFromStrahler(stream.strahler);

    for (const path of stream.paths) {
      if (path.length < 2) continue;
      const projected = path.map((c) => project(raster, c));
      let samples = resampleLine(projected, spacingCells);
      if (samples.length < 2) continue;

      let elevation = terrain ? sampleAlong(terrain, samples) : null;
      if (elevation) {
        const order = orientDownstream(elevation);
        const from = elevation;
        samples = order.map((i) => samples[i]!);
        elevation = order.map((i) => from[i]!);
      }
      sampledM += (samples.length - 1) * CHANNEL_SAMPLE_M;

      const bend = curvatureDegProfile(samples, CHANNEL_SAMPLE_M, BEND_WINDOW_M);
      let gradient: number[] | null = null;
      let brk: number[] | null = null;
      let profile: number[] | null = null;
      if (elevation) {
        // Smooth, then force downhill, then measure: water does not flow uphill,
        // but a DTM says it does every few samples.
        profile = monotonicDownstream(smoothProfile(elevation, PROFILE_SMOOTH_SAMPLES));
        gradient = gradientPercentProfile(profile, CHANNEL_SAMPLE_M, GRADIENT_WINDOW_M);
        brk = gradientBreakProfile(gradient, CHANNEL_SAMPLE_M, BREAK_WINDOW_M);
      }

      samples.forEach((sample, i) => {
        const x = Math.round(sample.x);
        const y = Math.round(sample.y);
        if (x < 0 || y < 0 || x >= size || y >= size) return;
        if (gradient) {
          setValue(gradientPercent, x, y, gradient[i]!);
          setValue(gradientBreakPercent, x, y, brk![i]!);
          setValue(channelElevation, x, y, profile![i]!);
          anyGradient ||= Number.isFinite(gradient[i]!);
        }
        setValue(bendDeg, x, y, bend[i]!);
        // Size is bounded by both the reach's place in the network and the water
        // its catchment actually carries: a 6th-order channel in a 0.15 m³/s
        // coastal catchment is not a river, whatever its order says.
        const catchmentFlow = discharge ? discharge.data[y * size + x]! : Number.NaN;
        const fromCatchment = Number.isFinite(catchmentFlow)
          ? magnitudeFromDischarge(catchmentFlow)
          : Number.NaN;
        const size01 =
          strahler === null
            ? fromCatchment
            : Number.isFinite(fromCatchment)
              ? Math.min(strahler, fromCatchment)
              : strahler;
        if (Number.isFinite(size01)) {
          setValue(magnitude, x, y, size01);
          anyMagnitude = true;
        }
      });
    }
  }

  return {
    channel,
    gradientPercent: anyGradient ? gradientPercent : null,
    gradientBreakPercent: anyGradient ? gradientBreakPercent : null,
    bendDeg,
    magnitude: anyMagnitude ? magnitude : null,
    channelElevation: anyGradient ? channelElevation : null,
    sampledM,
  };
}

/**
 * River fishing potential — innlandsfisk and anadromous from one set of channel
 * signals.
 *
 * The target is a species because a surface with no declared target is
 * meaningless: gjedde want the slow lowland pool that laks pass straight
 * through, and laks want water gjedde will never see. The engine branches on
 * neither — a target selects a row of weights and a flag.
 */
export const riverModel: DeriveModel = {
  layer: 'river-fishing',
  label: 'River fishing potential',
  targets: RIVER_TARGETS.map((s) => ({
    value: s.id,
    label: s.nameNo,
    caption: weightsCaption(s.nameEn, s.riverWeights, 'channel structure'),
  })),
  rev: 1,
  catalog: true,
  // Anadromous water and barriers are fetched for every target, not only the
  // sea-run ones: the input cache is keyed by cell, so deriving ørret warms them
  // for laks, and every target's manifest then carries the same provenance.
  inputs: {
    terrain: true,
    lakes: true,
    streams: true,
    landCover: true,
    catchments: true,
    anadromous: true,
    barriers: true,
  },
  vocabulary: 'fishing',
  describeSignal(key, value) {
    return describeRiverSignal(key as RiverSignalKey, value);
  },
  run(inputs: CellInputs, target: string): ModelResult {
    const { raster } = inputs;
    const species = fishSpecies(target) ?? RIVER_TARGETS[0]!;
    const empty = createGrid(raster.size, raster.size, raster.cellSizeM);

    // An input that did not answer comes back as `[]`, exactly like an area that
    // genuinely holds nothing — so every "there is none here" sentence below is
    // only honest once the record says the question was actually asked. Where
    // the missing input decides what the surface is allowed to claim, the cell
    // is failed instead: the job queue marks it `failed`, `/prepare` reports it
    // apart from the working cells, and the client re-asks. A blank surface that
    // says "Excellent" is the one outcome worse than no surface.
    requireInput(inputs, 'streams', 'the river network');
    if (species.anadromous) {
      // The gate *is* the anadromous model. Without it every brook in the cell
      // would be offered as salmon water; with an empty stand-in for it, none
      // would be — and the manifest would blame the river rather than the fetch.
      requireInput(inputs, 'anadromous', `the water ${species.nameNo} can reach`);
      // Barrier-pool is this target's joint-heaviest signal and the only
      // one-sided knowledge the surface holds. Silently dropping it scores the
      // dead water above Hellefoss the same as the pool below it.
      requireInput(inputs, 'barriers', `the migration barriers for ${species.nameNo}`);
    }

    const streams = inputs.streams.filter(
      (s) => s.ltema === STREAM_REAL_CHANNEL && s.paths.length > 0,
    );
    if (streams.length === 0) {
      return { score: empty, notes: ['No mapped river or stream in this area.'] };
    }

    const discharge = paintDischarge(raster, inputs.catchments);
    const fields = buildChannels(raster, streams, inputs.terrain, discharge);

    // Lakes are painted only to be *excluded*: their shores, inflows and
    // bottoms are the lake model's subject, and two surfaces scoring the same
    // pixel by different arithmetic is the one thing the split must not do.
    const lakes = createMask(raster.size, raster.size, raster.cellSizeM);
    for (const lake of inputs.lakes) {
      fillRings(
        lakes,
        lake.rings.map((ring) =>
          ring.map((c) => {
            const p = project(raster, c);
            return [p.x, p.y] as const;
          }),
        ),
      );
    }

    const confluences = createMask(raster.size, raster.size, raster.cellSizeM);
    for (const node of confluenceNodes(streams)) {
      const p = project(raster, node.point);
      setMask(confluences, Math.round(p.x), Math.round(p.y));
    }

    let anadromousReach: Mask | null = null;
    if (species.anadromous) {
      anadromousReach = createMask(raster.size, raster.size, raster.cellSizeM);
      for (const stretch of inputs.anadromous) burnPaths(raster, stretch.paths, anadromousReach);
    }

    // Barriers are snapped onto the channel before they are burned. A falls is
    // digitised as a point *near* the water, and the DTM around one is the
    // steepest ground in the cell — at Vestfoss it swings 1.6 m to 12.6 m within
    // three pixels. The model decides which side of a barrier is "below" it by
    // reading elevation at the barrier's own pixel, so an unsnapped point takes
    // that reading off a bank or a gorge wall and the one-sided signal fires on
    // whichever side the digitiser happened to click. Snapped, the reading is
    // the water surface at the falls, which is what "below" means.
    const barriers = createMask(raster.size, raster.size, raster.cellSizeM);
    const mine = inputs.barriers.filter((b) => b.species === species.id);
    for (const barrier of mine) {
      const p = project(raster, barrier.position);
      const onWater = snapToMask(fields.channel, Math.round(p.x), Math.round(p.y), BARRIER_SNAP_PX);
      if (onWater) setMask(barriers, onWater.x, onWater.y);
      // A barrier with no channel within reach is not this cell's to draw: it
      // belongs to water Elvenett does not carry here, and burning it anyway
      // would anchor holding water to dry ground.
    }

    const modelInputs: RiverInputs = {
      channel: fields.channel,
      gradientPercent: fields.gradientPercent,
      gradientBreakPercent: fields.gradientBreakPercent,
      bendDeg: fields.bendDeg,
      magnitude: fields.magnitude,
      confluences,
      lakes,
      landCover: inputs.landCover,
      anadromousReach,
      barriers,
      channelElevation: fields.channelElevation,
    };
    const surface = riverSurface(modelInputs, { species });

    return {
      score: surface.score,
      absolute: absoluteTier(fields, discharge, species),
      notes: [
        ...surface.notes,
        ...describeCell(inputs, fields, species, mine, confluenceCount(confluences)),
      ],
      terms: surface.terms,
    };
  },
};

/**
 * Fail the cell when an input the target's claims rest on never arrived.
 *
 * Thrown rather than returned so it travels the path the queue already has for
 * a derive that could not be done (`jobs.ts` → status `failed`), instead of
 * inventing a second, quieter way for a cell to be wrong.
 */
function requireInput(
  inputs: CellInputs,
  id: 'streams' | 'anadromous' | 'barriers',
  subject: string,
): void {
  if (!inputFailed(inputs, id)) return;
  const reason = inputs.records.find((r) => r.id === id)?.detail ?? 'no answer';
  throw new Error(`cannot read ${subject}: ${id} input failed (${reason})`);
}

/**
 * How far a barrier may be dragged onto the channel, in pixels (~9.6 m each).
 *
 * Wide enough to cover the disagreement between a point digitised by eye and
 * NVE's generalised centreline, narrow enough that a barrier on an unmapped
 * brook is dropped rather than pinned to whatever river runs past.
 */
const BARRIER_SNAP_PX = 12;

/** The nearest set pixel to (x, y) within `radius`, searched outward. */
function snapToMask(
  mask: Mask,
  x: number,
  y: number,
  radius: number,
): { x: number; y: number } | null {
  let best: { x: number; y: number } | null = null;
  let bestD = Infinity;
  for (let dy = -radius; dy <= radius; dy++) {
    const py = y + dy;
    if (py < 0 || py >= mask.height) continue;
    for (let dx = -radius; dx <= radius; dx++) {
      const pxx = x + dx;
      if (pxx < 0 || pxx >= mask.width) continue;
      if (mask.data[py * mask.width + pxx] !== 1) continue;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = { x: pxx, y: py };
      }
    }
  }
  return bestD <= radius * radius ? best : null;
}

function setMask(mask: Mask, x: number, y: number): void {
  if (x < 0 || y < 0 || x >= mask.width || y >= mask.height) return;
  mask.data[y * mask.width + x] = 1;
}

function confluenceCount(mask: Mask): number {
  let n = 0;
  for (const v of mask.data) if (v === 1) n++;
  return n;
}

/**
 * The cell's absolute water quality — D5's second number, averaged over the
 * channel pixels themselves so a cell holding one big river and twenty ditches
 * is judged by the water it actually has, not by the largest catchment that
 * clips its corner.
 */
function absoluteTier(
  fields: ChannelFields,
  discharge: Grid | null,
  species: FishSpecies,
): number | undefined {
  if (!discharge) return undefined;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < fields.channel.data.length; i++) {
    if (fields.channel.data[i] !== 1) continue;
    const flow = discharge.data[i]!;
    if (!Number.isFinite(flow)) continue;
    sum += riverQuality({ dischargeM3s: flow, anadromous: species.anadromous });
    n++;
  }
  return n > 0 ? sum / n : undefined;
}

/** Plain-language notes for the manifest — what was read, and what to check. */
function describeCell(
  inputs: CellInputs,
  fields: ChannelFields,
  species: FishSpecies,
  barriers: readonly MigrationBarrier[],
  confluences: number,
): string[] {
  const notes: string[] = [];

  const km = (fields.sampledM / 1000).toFixed(1);
  if (fields.gradientPercent) {
    let pool = 0;
    let riffle = 0;
    let cascade = 0;
    for (let i = 0; i < fields.gradientPercent.data.length; i++) {
      const v = fields.gradientPercent.data[i]!;
      if (!Number.isFinite(v)) continue;
      const kind = classifyChannel(v);
      if (kind === 'pool') pool++;
      else if (kind === 'riffle') riffle++;
      else cascade++;
    }
    const total = pool + riffle + cascade;
    const pct = (n: number) => Math.round((n / Math.max(1, total)) * 100);
    notes.push(
      `${km} km of channel read: ${pct(pool)} % pool, ${pct(riffle)} % riffle, ` +
        `${pct(cascade)} % too steep to hold fish and left unscored.`,
    );
  } else {
    notes.push(`${km} km of channel read.`);
  }

  if (confluences > 0) {
    notes.push(`${confluences} confluence${confluences === 1 ? '' : 's'} of real tributaries.`);
  }

  const biggest = [...inputs.catchments]
    .filter((c) => c.qnormalMm3aar !== null)
    .sort((a, b) => (b.areaKm2 ?? 0) - (a.areaKm2 ?? 0))[0];
  if (biggest) {
    notes.push(
      `Largest catchment here: ${biggest.name ?? biggest.vassdragsnr ?? 'unnamed'} — ` +
        `${Math.round(dischargeM3s(biggest.qnormalMm3aar!))} m³/s mean flow (NVE).`,
    );
  }

  // The rivers themselves, and the one link that matters more than any score we
  // can compute: whether a river is open this season is decided by emergency
  // forskrift and exists nowhere machine-readable, so the answer is a per-river
  // deep link into Lakseregisteret, not a verdict of ours.
  const rivers = new Map<string, { url: string | null; national: boolean }>();
  for (const stretch of inputs.anadromous) {
    const name = stretch.river ?? stretch.vassdragsNr;
    if (!name) continue;
    const entry = rivers.get(name);
    if (!entry) rivers.set(name, { url: stretch.lakseregUrl, national: stretch.national });
    else if (stretch.national)
      rivers.set(name, { url: entry.url ?? stretch.lakseregUrl, national: true });
  }
  for (const [name, { url, national }] of rivers) {
    notes.push(
      `${name}: anadromous water${national ? ', a nasjonalt laksevassdrag' : ''}. ` +
        `Seasons and closures change mid-season — check ${url ?? 'Lakseregisteret'} before fishing.`,
    );
  }

  if (species.anadromous && barriers.length > 0) {
    const named = barriers.filter((b) => b.info).slice(0, 2);
    // Miljødirektoratet grades the obstacle, and the grade changes what may
    // honestly be said about the water above it. `Vandringsstopp` is the end of
    // the run; `TemporærtHinder` is a falls with a ladder or a passable flow —
    // Hellefoss on the Drammenselva is one, and salmon are caught for kilometres
    // above it. Both still gather fish *below* them, which is why the signal
    // itself does not branch: it is only the sentence that overclaimed.
    const absolute = barriers.filter(isAbsoluteBarrier).length;
    const holding =
      absolute === barriers.length
        ? 'Fish hold below them, never above.'
        : absolute === 0
          ? 'Fish gather below them, and some pass.'
          : 'Fish gather below them; some are absolute, some passable.';
    notes.push(
      `${barriers.length} migration barrier${barriers.length === 1 ? '' : 's'} for ${species.nameNo}` +
        (named.length > 0 ? ` (${named.map((b) => b.info).join('; ')})` : '') +
        `. ${holding}`,
    );
  }

  return notes;
}
