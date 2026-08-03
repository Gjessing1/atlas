import { destinationPoint, haversineM, type LatLng, type LngLatBbox } from '@atlas/core';
import {
  createGrid,
  decodeStandVantage,
  localMaxima,
  percentileRank,
  SPOT_LIMIT,
  SPOT_MIN_RANK,
  SPOT_MIN_SEPARATION_M,
  bandForRank,
  BAND_LABELS,
  type PotentialSpot,
  type PotentialSpotAccess,
  type PotentialStandPlan,
} from '@atlas/potential';
import { CELL_PIXELS, cellId, type Cell } from './cells.js';
import { readPlane, readSignal, type CellManifest } from './derive.js';
import { explainSample, sampleCentre } from './explain.js';
import type { DeriveModel } from './models.js';

/**
 * "Best spots in view" — the shortlist the derived surface turns into a plan
 * (ROADMAP § N5 → E6).
 *
 * The heatmap already says where to look; what it cannot do is answer *"so
 * where do I go tonight?"*. That answer needs three things the surface has no
 * opinion about on its own, and each is here:
 *
 * - **Which peaks are real alternatives** — maxima of the persisted rank plane,
 *   thinned in metres across cell boundaries, capped at the ramp's own hot band
 *   so the list and the pixels agree about "prime".
 * - **Why each one** — the same explanation the tap card gives, from the same
 *   planes, so a spot's row and its card can never disagree.
 * - **Whether it is reachable today** — the walk in from the nearest road, which
 *   is what actually separates a prime shoreline from a prime shoreline five
 *   kilometres up a bog.
 *
 * What it deliberately does *not* do is derive anything. A cell that has not
 * been prepared is counted as pending and left alone: asking for spots must
 * never queue work, or panning with the list open would hammer the upstreams.
 */

/**
 * Walking pace over rough ground, m/s (≈4.3 km/h).
 *
 * Used only as a **floor** under the router's answer — see `walkAccess`. It is
 * below Valhalla's default pedestrian speed on purpose: the stretch it covers is
 * the one with no path on it.
 */
const ROUGH_WALK_MS = 1.2;

/** The router gets a short leash: a shortlist must not wait on it. */
const ROUTER_TIMEOUT_MS = 8000;

/** A candidate before the merge — a maximum of one cell's rank plane. */
interface Candidate {
  readonly position: LatLng;
  /** Rank inside the requested view — the shortlist's actual question. */
  readonly rank: number;
  /** Rank inside the full ~78 km² derive cell — what the heatmap colours mean. */
  readonly cellRank: number;
  readonly cell: Cell;
  readonly sx: number;
  readonly sy: number;
  readonly stand: PotentialStandPlan | null;
}

/** Does a point fall inside the requested viewport? */
function inBbox(at: LatLng, bbox: LngLatBbox): boolean {
  const [west, south, east, north] = bbox;
  return at.lng >= west && at.lng <= east && at.lat >= south && at.lat <= north;
}

/**
 * Restrict a plane before finding or ranking maxima.
 *
 * This order is the Sleikebekk fix: spending the eight-candidate limit on the
 * whole 78 km² cell and filtering afterwards returned zero points in a 7.7 km²
 * permit area. A rank plane is monotonic with the raw score, so ranking its
 * clipped values again gives the honest order inside the requested area.
 */
function rankInsideView(
  grid: ReturnType<typeof readPlane>,
  manifest: CellManifest,
  bbox: LngLatBbox,
) {
  const clipped = createGrid(grid.width, grid.height, grid.cellSizeM);
  for (let y = 0; y < grid.height; y++) {
    for (let x = 0; x < grid.width; x++) {
      if (inBbox(sampleCentre(manifest, x, y), bbox)) {
        clipped.data[y * grid.width + x] = grid.data[y * grid.width + x]!;
      }
    }
  }
  return percentileRank(clipped);
}

/**
 * The maxima of one derived cell, already filtered to the viewport.
 *
 * The cell's own contrast verdict is binding and is *not* recomputed here: the
 * gate (D5) judges the raw score, and a percentile plane has been flattened by
 * construction — every cell has a top 5 %, including a featureless pond. Asking
 * the rank plane whether it has structure would therefore always say yes, which
 * is precisely the failure the gate exists to prevent.
 */
export function cellCandidates(
  manifest: CellManifest,
  blob: Buffer,
  cell: Cell,
  bbox: LngLatBbox,
  limit: number,
): Candidate[] {
  if (!manifest.contrast.standout || !manifest.signals) return [];
  const pixels = manifest.signals.pixels;
  // A signal sample covers several derive pixels; separation in metres is what
  // makes it comparable with the cross-cell merge below.
  const sampleSizeM = (manifest.cellSizeM * CELL_PIXELS) / pixels;
  const cellRank = readPlane(blob, 0, sampleSizeM);
  const rank = rankInsideView(cellRank, manifest, bbox);
  return localMaxima(rank, {
    minSeparationCells: Math.max(1, SPOT_MIN_SEPARATION_M / sampleSizeM),
    minValue: SPOT_MIN_RANK,
    limit,
  }).map((max) => ({
    position: sampleCentre(manifest, max.x, max.y),
    rank: max.value,
    cellRank: cellRank.data[max.y * cellRank.width + max.x]!,
    cell,
    sx: max.x,
    sy: max.y,
    stand: null,
  }));
}

function planeIndex(manifest: CellManifest, name: string): number {
  return manifest.signals?.planes.indexOf(name) ?? -1;
}

function laneSummary(lanes: PotentialStandPlan['lanes']): string {
  const open = lanes.filter((lane) => lane.rangeM >= 80);
  if (open.length === 0) return 'No long lane';
  const best = Math.max(...open.map((lane) => lane.rangeM));
  return `Open ${open.map((lane) => lane.label).join('–')} to ${best} m`;
}

/** Hunter-side maxima from the LOS planes persisted by hunt model v3. */
export function standCandidates(
  manifest: CellManifest,
  blob: Buffer,
  cell: Cell,
  bbox: LngLatBbox,
  limit: number,
): Candidate[] {
  const plan = manifest.signals?.standPlan;
  if (!manifest.contrast.standout || !plan || !manifest.signals) return [];
  const sampleSizeM = (manifest.cellSizeM * CELL_PIXELS) / manifest.signals.pixels;
  const scoreIndex = planeIndex(manifest, plan.score);
  const vantageIndex = planeIndex(manifest, plan.vantage);
  if (scoreIndex < 0 || vantageIndex < 0) return [];
  const raw = readPlane(blob, scoreIndex, sampleSizeM);
  const cellRank = percentileRank(raw);
  const viewRank = rankInsideView(raw, manifest, bbox);

  return localMaxima(viewRank, {
    minSeparationCells: Math.max(1, SPOT_MIN_SEPARATION_M / sampleSizeM),
    minValue: SPOT_MIN_RANK,
    limit,
  }).flatMap((max): Candidate[] => {
    const position = sampleCentre(manifest, max.x, max.y);
    const lanes = plan.directions.map((direction) => {
      const index = planeIndex(manifest, direction.lane);
      const value = index >= 0 ? readSignal(blob, index, max.x, max.y) : 0;
      return {
        key: direction.key,
        label: direction.label,
        bearing: direction.bearing,
        rangeM: Math.round((value * plan.maxRangeM) / 5) * 5,
      };
    });
    const paired = plan.directions
      .map((direction) => {
        const pairIndex = planeIndex(manifest, direction.pair);
        const aimIndex = planeIndex(manifest, direction.aim);
        return {
          direction,
          pair: pairIndex >= 0 ? readSignal(blob, pairIndex, max.x, max.y) : 0,
          distanceM:
            aimIndex >= 0
              ? Math.round((readSignal(blob, aimIndex, max.x, max.y) * plan.maxRangeM) / 5) * 5
              : 0,
        };
      })
      .sort((a, b) => b.pair - a.pair)[0];
    if (!paired || !(paired.pair > 0) || !(paired.distanceM > 0)) return [];
    const encodedVantage = readSignal(blob, vantageIndex, max.x, max.y);
    const vantageM = Math.round(decodeStandVantage(encodedVantage));
    const aimPosition = destinationPoint(position, paired.direction.bearing, paired.distanceM);
    const stand: PotentialStandPlan = {
      maxRangeM: plan.maxRangeM,
      vantageM,
      lanes,
      aim: {
        label: paired.direction.label,
        bearing: paired.direction.bearing,
        distanceM: paired.distanceM,
        position: aimPosition,
      },
      warning:
        'Terrain and canopy visibility only — verify a safe backstop and shooting direction on site.',
    };
    return [
      {
        position,
        rank: max.value,
        cellRank: cellRank.data[max.y * cellRank.width + max.x]!,
        cell,
        sx: max.x,
        sy: max.y,
        stand,
      },
    ];
  });
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Turn a surviving candidate into the wire shape, with its reasoning attached. */
export function describeCandidate(
  candidate: Candidate,
  manifest: CellManifest,
  blob: Buffer,
  model: DeriveModel,
  target: string,
): PotentialSpot {
  const explanation = explainSample(model, target, manifest, blob, candidate.sx, candidate.sy);
  const band = bandForRank(candidate.rank).key;
  return {
    id: `${cellId(candidate.cell)}/${candidate.sx}/${candidate.sy}`,
    position: candidate.position,
    cell: cellId(candidate.cell),
    rank: candidate.rank,
    cellRank: candidate.cellRank,
    score: Math.round(candidate.rank * 100),
    band,
    bandLabel: candidate.stand ? 'Calling stand' : BAND_LABELS[model.vocabulary][band],
    // The strongest factor's own sentence. `explainPoint` sorts by weighted
    // contribution, so this is the reason the point is hot, not the first term
    // the model happened to declare. Capitalised here because the model writes
    // these to be *embedded* ("Prime. The bank is strongly steep…") and a list
    // row is a sentence of its own.
    reason: candidate.stand
      ? `${laneSummary(candidate.stand.lanes)}; habitat ${candidate.stand.aim.distanceM} m ${candidate.stand.aim.label}.`
      : capitalise(explanation.factors[0]?.detail ?? explanation.summary),
    factors: explanation.factors,
    access: null,
    stand: candidate.stand,
  };
}

interface LocateEdge {
  correlated_lat?: number;
  correlated_lon?: number;
}
interface LocateResult {
  edges?: LocateEdge[];
}
interface MatrixEntry {
  distance?: number | null;
  time?: number | null;
}

export interface WalkAccessOptions {
  readonly valhallaUrl: string;
  readonly fetchImpl: typeof fetch;
  readonly log?: { warn(obj: unknown, msg: string): void };
}

/**
 * How far each spot is from the nearest road, on foot.
 *
 * Two Valhalla calls for the whole list, not two per spot: `/locate` correlates
 * every spot to the nearest **drivable** edge (where the car stops), then one
 * pedestrian matrix walks each of those road points to its own spot.
 *
 * The straight-line floor is the honest part. A lake shore usually has no
 * mapped path, so Valhalla snaps the *destination* to whatever edge is nearest —
 * sometimes the same road the walk started on, which routes in zero minutes and
 * would tell a user that a spot 900 m across a bog is roadside. So a route
 * shorter than the great-circle distance between its own endpoints is proof the
 * router never reached the spot: the answer falls back to the straight line at a
 * rough-ground pace and is flagged `approximate`, which both clients render.
 */
export async function walkAccess(
  spots: readonly LatLng[],
  opts: WalkAccessOptions,
): Promise<(PotentialSpotAccess | null)[] | null> {
  if (spots.length === 0) return [];
  const post = async (path: string, body: unknown): Promise<unknown> => {
    const res = await opts.fetchImpl(new URL(path, opts.valhallaUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(ROUTER_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  };

  try {
    const located = (await post('/locate', {
      locations: spots.map((s) => ({ lat: s.lat, lon: s.lng })),
      costing: 'auto',
      verbose: false,
    })) as LocateResult[];

    /** Spot index → the road point it is reached from, where one was found. */
    const roads = new Map<number, LatLng>();
    located.forEach((result, i) => {
      const edge = result?.edges?.find(
        (e) => typeof e.correlated_lat === 'number' && typeof e.correlated_lon === 'number',
      );
      if (edge) roads.set(i, { lat: edge.correlated_lat!, lng: edge.correlated_lon! });
    });
    if (roads.size === 0) return spots.map(() => null);

    const indices = [...roads.keys()];
    const matrix = (await post('/sources_to_targets', {
      sources: indices.map((i) => ({ lat: roads.get(i)!.lat, lon: roads.get(i)!.lng })),
      targets: indices.map((i) => ({ lat: spots[i]!.lat, lon: spots[i]!.lng })),
      costing: 'pedestrian',
      units: 'kilometers',
    })) as { sources_to_targets?: MatrixEntry[][] };

    return spots.map((spot, i) => {
      const road = roads.get(i);
      if (!road) return null;
      const row = indices.indexOf(i);
      const entry = matrix.sources_to_targets?.[row]?.[row];
      const straightM = haversineM(road, spot);
      const routeM = typeof entry?.distance === 'number' ? entry.distance * 1000 : null;
      const routeS = typeof entry?.time === 'number' ? entry.time : null;
      // A route cannot be shorter than the line between its endpoints, so a
      // shorter one means the snap moved them.
      const reached = routeM !== null && routeS !== null && routeM + 1 >= straightM;
      return {
        distanceM: Math.round(reached ? routeM! : straightM),
        durationS: Math.round(reached ? routeS! : straightM / ROUGH_WALK_MS),
        approximate: !reached,
        from: road,
      };
    });
  } catch (err) {
    // The shortlist is still worth having without walk times, so this degrades
    // to an absence rather than failing the request.
    opts.log?.warn({ err }, 'walk-in times unavailable for potential spots');
    return null;
  }
}

/**
 * What "nothing to show" means here — a finding, never a blank list on its own.
 *
 * Every branch names *which* nothing it is: outside the country the engine
 * reads, not built yet, built and deliberately flat, or built with nothing in
 * this particular viewport. "No spots" with no reason is the message that makes
 * a working surface look broken.
 */
export function spotsNote(counts: {
  spots: number;
  cells: number;
  pending: number;
  flat: number;
  derived: number;
  hunt: boolean;
}): string | null {
  const what = counts.hunt ? 'ground' : 'water';
  const areas = counts.pending === 1 ? 'area' : 'areas';
  if (counts.spots > 0) {
    return counts.pending > 0 ? `Still reading ${counts.pending} more ${areas}.` : null;
  }
  // Norway-only, stated as an absence rather than an error (ROADMAP §2.1).
  if (counts.cells === 0) return 'Derived surfaces cover Norway only.';
  if (counts.derived === 0) {
    return counts.pending > 0
      ? `Still reading the ${what} in view.`
      : `Nothing derived for this view yet.`;
  }
  if (counts.flat === counts.derived) {
    return `No standout ${what} in view — this area reads much the same throughout.`;
  }
  return `Nothing stands out in view. Try panning to more ${what}.`;
}

export { SPOT_LIMIT };
