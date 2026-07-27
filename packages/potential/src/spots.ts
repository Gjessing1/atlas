/**
 * "Best spots in view" — the step that turns a heatmap into a plan
 * (ROADMAP § N5 → E6, designed in docs/FISH-HUNT-ENGINE.md § UX).
 *
 * `bestSpots()` in surface.ts finds the maxima of **one grid**. This file owns
 * everything that is true of a *shortlist shown to a person*, and each rule here
 * exists because the obvious version of the feature is dishonest:
 *
 * - **A spot must be prime**, at the ramp's own threshold rather than a second
 *   number invented here. If the map draws a point red and the list refuses to
 *   name it — or worse, names an orange one — the two are disagreeing about the
 *   same arithmetic in front of the user.
 * - **A shortlist is thinned in metres, not in pixels.** Cells are derived
 *   independently, so a lake straddling two of them yields two sets of maxima
 *   that know nothing about each other; without a geographic merge the same bay
 *   is offered twice while the next lake never makes the list.
 * - **A spot is only a spot if you could stand somewhere else instead.** Two
 *   points 80 m apart on the same shoreline are one decision, not two, so the
 *   separation is deliberately larger than the in-cell one: the list answers
 *   "where should I go", and eight answers to that question must be eight
 *   different places.
 */

import { haversineM, type LatLng } from '@atlas/core';
import type { PotentialSpot } from './api.js';
import { BAND_LABELS, SURFACE_BANDS, type SurfaceVocabulary } from './surface.js';

/**
 * The rank a point must reach to be offered as a spot: the ramp's hot band, read
 * from the ramp itself so the shortlist and the pixels can never disagree about
 * what "prime" means.
 */
export const SPOT_MIN_RANK = SURFACE_BANDS[SURFACE_BANDS.length - 1]!.minRank;

/** Below this apart, two candidates are the same piece of water (see above). */
export const SPOT_MIN_SEPARATION_M = 300;

/** Most spots a shortlist may carry — eight is already more than a day's fishing. */
export const SPOT_LIMIT = 8;

/**
 * Greedily keep the strongest candidates that are genuinely apart.
 *
 * Deliberately not clustering: a cluster's centroid is a place nobody chose,
 * and on a shoreline it lands in the water between two bays. The strongest
 * candidate of a neighbourhood is a real pixel of a real surface, and dropping
 * its neighbours is what makes the eight a set of alternatives.
 */
export function thinSpots<T extends { position: LatLng; rank: number }>(
  candidates: readonly T[],
  opts: { limit?: number; minSeparationM?: number } = {},
): T[] {
  const limit = opts.limit ?? SPOT_LIMIT;
  const minSeparationM = opts.minSeparationM ?? SPOT_MIN_SEPARATION_M;
  const kept: T[] = [];
  for (const candidate of [...candidates].sort((a, b) => b.rank - a.rank)) {
    if (kept.length >= limit) break;
    if (kept.some((k) => haversineM(k.position, candidate.position) < minSeparationM)) continue;
    kept.push(candidate);
  }
  return kept;
}

/** A spot's marker colour — the ramp's band at full strength, since a pin is not a wash. */
export function spotColor(spot: Pick<PotentialSpot, 'band'>): string {
  const band = SURFACE_BANDS.find((b) => b.key === spot.band) ?? SURFACE_BANDS[0]!;
  const [r, g, b] = band.color;
  return `rgb(${r}, ${g}, ${b})`;
}

/**
 * The numbered markers, as GeoJSON both clients hand straight to MapLibre.
 *
 * Shared rather than written twice because the numbers are the feature: the map
 * and the list are one artefact, and a client that numbered them in its own
 * order would silently break the only link between them.
 */
export function spotsFeatureCollection(spots: readonly PotentialSpot[]) {
  return {
    type: 'FeatureCollection' as const,
    features: spots.map((spot, index) => ({
      type: 'Feature' as const,
      id: index + 1,
      properties: {
        id: spot.id,
        /** 1-based rank in the shortlist — what the marker reads. */
        number: index + 1,
        label: String(index + 1),
        band: spot.band,
        bandLabel: spot.bandLabel,
        color: spotColor(spot),
        reason: spot.reason,
      },
      geometry: {
        type: 'Point' as const,
        coordinates: [spot.position.lng, spot.position.lat],
      },
    })),
  };
}

/** What "save as place" writes — structurally a `NewPlace`, without the dependency. */
export interface SpotPlaceDraft {
  readonly name: string;
  readonly lat: number;
  readonly lng: number;
  readonly notes: string;
  readonly tags: string[];
}

/**
 * A spot as a saved place: named for what it is, with the reasoning in the notes.
 *
 * The notes matter more than they look. A saved place syncs and comes along
 * offline, so months later — on the water, with no network and no surface
 * derived — this is the *only* surviving record of why the pin is there. A pin
 * called "59.85, 10.42" would have thrown that away.
 */
export function spotPlaceDraft(
  spot: PotentialSpot,
  index: number,
  opts: { targetLabel?: string; vocabulary?: SurfaceVocabulary } = {},
): SpotPlaceDraft {
  const vocabulary = opts.vocabulary ?? 'fishing';
  const what = opts.targetLabel ?? (vocabulary === 'hunt' ? 'hunting' : 'fishing');
  const lines = [spot.reason];
  if (spot.access) {
    lines.push(
      `${spot.access.approximate ? '≈' : ''}${Math.round(spot.access.durationS / 60)} min walk ` +
        `from the nearest road.`,
    );
  }
  lines.push(`Atlas ${vocabulary === 'hunt' ? 'hunt' : 'fishing'} potential, ${spot.bandLabel}.`);
  return {
    name: `${what} spot ${index + 1}`,
    lat: spot.position.lat,
    lng: spot.position.lng,
    notes: lines.join(' '),
    tags: [vocabulary === 'hunt' ? 'hunt' : 'fishing', 'spot'],
  };
}

/** Legend words for a spot's band, in the surface's own vocabulary. */
export function spotBandLabel(
  band: PotentialSpot['band'],
  vocabulary: SurfaceVocabulary = 'fishing',
): string {
  return BAND_LABELS[vocabulary][band];
}
