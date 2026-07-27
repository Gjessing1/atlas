import { haversineM, type LatLng, type LngLatBbox } from '@atlas/core';
import {
  localMaxima,
  SPOT_LIMIT,
  SPOT_MIN_RANK,
  SPOT_MIN_SEPARATION_M,
  bandForRank,
  BAND_LABELS,
  type PotentialSpot,
  type PotentialSpotAccess,
} from '@atlas/potential';
import { CELL_PIXELS, cellId, type Cell } from './cells.js';
import { readPlane, type CellManifest } from './derive.js';
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
  readonly rank: number;
  readonly cell: Cell;
  readonly sx: number;
  readonly sy: number;
}

/** Does a point fall inside the requested viewport? */
function inBbox(at: LatLng, bbox: LngLatBbox): boolean {
  const [west, south, east, north] = bbox;
  return at.lng >= west && at.lng <= east && at.lat >= south && at.lat <= north;
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
  const rank = readPlane(blob, 0, sampleSizeM);
  return (
    localMaxima(rank, {
      minSeparationCells: Math.max(1, SPOT_MIN_SEPARATION_M / sampleSizeM),
      minValue: SPOT_MIN_RANK,
      limit,
    })
      .map((max) => ({
        position: sampleCentre(manifest, max.x, max.y),
        rank: max.value,
        cell,
        sx: max.x,
        sy: max.y,
      }))
      // Cells stretch ~10 km beyond a phone-sized viewport, so this is the
      // difference between "best spots in view" and "best spots somewhere near".
      .filter((candidate) => inBbox(candidate.position, bbox))
  );
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
    score: Math.round(candidate.rank * 100),
    band,
    bandLabel: BAND_LABELS[model.vocabulary][band],
    // The strongest factor's own sentence. `explainPoint` sorts by weighted
    // contribution, so this is the reason the point is hot, not the first term
    // the model happened to declare. Capitalised here because the model writes
    // these to be *embedded* ("Prime. The bank is strongly steep…") and a list
    // row is a sentence of its own.
    reason: capitalise(explanation.factors[0]?.detail ?? explanation.summary),
    factors: explanation.factors,
    access: null,
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

/** What "nothing to show" means here — a finding, never a blank list on its own. */
export function spotsNote(counts: {
  spots: number;
  pending: number;
  flat: number;
  derived: number;
  hunt: boolean;
}): string | null {
  const what = counts.hunt ? 'ground' : 'water';
  if (counts.spots > 0) {
    return counts.pending > 0 ? `Still reading ${counts.pending} more area(s).` : null;
  }
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
