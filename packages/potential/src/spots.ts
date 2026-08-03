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

import {
  destinationPoint,
  haversineM,
  standApproachNote,
  type LatLng,
  type PlaceStand,
} from '@atlas/core';
import type { PotentialSpot } from './api.js';
import { BAND_LABELS, SURFACE_BANDS, type SurfaceVocabulary } from './surface.js';

/**
 * The walk-in verdict in field language, shared by both clients and saved pins.
 * Distances stay rounded because the source signal pixels are about 38 m wide;
 * single-metre precision would imply knowledge the surface does not have.
 */
export function spotApproachLabel(spot: Pick<PotentialSpot, 'access'>): string | null {
  const approach = spot.access?.approach;
  if (!approach) return null;
  return standApproachNote(approach);
}

/**
 * The rank a point must reach to be offered as a spot: the ramp's hot band, read
 * from the ramp itself so the shortlist and the pixels can never disagree about
 * what "prime" means.
 */
export const SPOT_MIN_RANK = SURFACE_BANDS[SURFACE_BANDS.length - 1]!.minRank;

/** Below this apart, two candidates are the same piece of water (see above). */
export const SPOT_MIN_SEPARATION_M = 300;

/** Hunting stands a shot-width apart can differ in wind, approach and cover. */
export const HUNT_STAND_MIN_SEPARATION_M = 150;

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
    features: [
      ...spots.map((spot, index) => ({
        type: 'Feature' as const,
        id: index + 1,
        properties: {
          id: spot.id,
          kind: 'spot',
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
      ...spots.flatMap((spot, index) => {
        if (!spot.stand) return [];
        const lineProperties = (kind: 'lane' | 'aim', id: string, color: string) => ({
          id,
          kind,
          number: index + 1,
          label: '',
          band: spot.band,
          bandLabel: spot.bandLabel,
          color,
          reason: spot.reason,
        });
        const laneFeatures = spot.stand.lanes
          .filter((lane) => lane.rangeM >= 20)
          .map((lane) => {
            const end = destinationPoint(spot.position, lane.bearing, lane.rangeM);
            return {
              type: 'Feature' as const,
              properties: lineProperties('lane', `${spot.id}/lane/${lane.key}`, '#f8fafc'),
              geometry: {
                type: 'LineString' as const,
                coordinates: [
                  [spot.position.lng, spot.position.lat],
                  [end.lng, end.lat],
                ],
              },
            };
          });
        return [
          ...laneFeatures,
          {
            type: 'Feature' as const,
            properties: lineProperties('aim', `${spot.id}/aim`, '#f59e0b'),
            geometry: {
              type: 'LineString' as const,
              coordinates: [
                [spot.position.lng, spot.position.lat],
                [spot.stand.aim.position.lng, spot.stand.aim.position.lat],
              ],
            },
          },
        ];
      }),
    ],
  };
}

/** What "save as place" writes — structurally a `NewPlace`, without the dependency. */
export interface SpotPlaceDraft {
  readonly name: string;
  readonly lat: number;
  readonly lng: number;
  readonly notes: string;
  readonly tags: string[];
  /** The stand plan, structured, for hunting spots; null for fishing water. */
  readonly stand: PlaceStand | null;
}

/**
 * The stand plan as the record keeps it (ROADMAP § E12).
 *
 * Only what cannot be recovered later goes in. The rose comes from a terrain and
 * canopy trace over rasters no client holds, and the approach verdict was true
 * of one route on one day — both are history the moment they are saved, which is
 * why `savedAt` is part of the payload rather than left to the row's timestamps:
 * a place can be renamed and refiled long after its plan stopped being current.
 */
export function spotStandRecord(
  spot: PotentialSpot,
  opts: { targetLabel?: string; now?: number } = {},
): PlaceStand | null {
  if (!spot.stand) return null;
  const approach = spot.access?.approach ?? null;
  return {
    kind: 'stand',
    source: 'atlas-potential',
    target: opts.targetLabel ?? 'hunting',
    aim: {
      label: spot.stand.aim.label,
      bearing: spot.stand.aim.bearing,
      distanceM: spot.stand.aim.distanceM,
      position: spot.stand.aim.position,
    },
    vantageM: spot.stand.vantageM,
    maxRangeM: spot.stand.maxRangeM,
    lanes: spot.stand.lanes.map((lane) => ({
      key: lane.key,
      label: lane.label,
      bearing: lane.bearing,
      rangeM: lane.rangeM,
    })),
    approach: approach
      ? {
          risk: approach.risk,
          basis: approach.basis,
          holdingCoverM: approach.holdingCoverM,
          // The walk is the access reading, not the approach's: the verdict
          // judges the route's cover, the minutes are how long it takes.
          walkMinutes: spot.access ? Math.round(spot.access.durationS / 60) : null,
          approximate: spot.access?.approximate ?? false,
        }
      : null,
    bandLabel: spot.bandLabel,
    warning: spot.stand.warning,
    savedAt: opts.now ?? Date.now(),
  };
}

/**
 * A spot as a saved place: named for what it is, with the reasoning in the notes.
 *
 * The notes matter more than they look. A saved place syncs and comes along
 * offline, so months later — on the water, with no network and no surface
 * derived — this is the *only* surviving record of why the pin is there. A pin
 * called "59.85, 10.42" would have thrown that away.
 *
 * A hunting stand additionally carries the structured `stand` payload the card
 * and the map read. The prose is kept as well rather than replaced: it is what
 * a GPX `<desc>` and a printout carry, and the "everything exportable" rule
 * means the reasoning must not become readable only inside Atlas. It is joined
 * on newlines because the field is free text and the four claims — direction,
 * rose, walk-in, safety — are four statements, not one sentence.
 */
export function spotPlaceDraft(
  spot: PotentialSpot,
  index: number,
  opts: { targetLabel?: string; vocabulary?: SurfaceVocabulary; now?: number } = {},
): SpotPlaceDraft {
  const vocabulary = opts.vocabulary ?? 'fishing';
  const what = opts.targetLabel ?? (vocabulary === 'hunt' ? 'hunting' : 'fishing');
  const lines = [spot.reason];
  if (spot.access) {
    lines.push(
      `${spot.access.approximate ? '≈' : ''}${Math.round(spot.access.durationS / 60)} min walk ` +
        `from the nearest road.`,
    );
    const approach = spotApproachLabel(spot);
    if (approach) lines.push(approach);
  }
  lines.push(`Atlas ${vocabulary === 'hunt' ? 'hunt' : 'fishing'} potential, ${spot.bandLabel}.`);
  if (spot.stand) {
    const visibility = spot.stand.lanes.map((lane) => `${lane.label} ${lane.rangeM} m`).join(' · ');
    lines.unshift(
      `Calling stand: ${spot.stand.aim.distanceM} m ${spot.stand.aim.label} toward habitat; ` +
        `vantage ${spot.stand.vantageM >= 0 ? '+' : ''}${spot.stand.vantageM} m.`,
      ...(visibility ? [`Visibility rose (terrain/canopy): ${visibility}.`] : []),
    );
    lines.push(spot.stand.warning);
  }
  return {
    name: `${what} ${spot.stand ? 'stand' : 'spot'} ${index + 1}`,
    lat: spot.position.lat,
    lng: spot.position.lng,
    notes: lines.join('\n'),
    tags: [vocabulary === 'hunt' ? 'hunt' : 'fishing', 'spot', ...(spot.stand ? ['stand'] : [])],
    stand: spotStandRecord(spot, {
      ...(opts.targetLabel === undefined ? {} : { targetLabel: opts.targetLabel }),
      ...(opts.now === undefined ? {} : { now: opts.now }),
    }),
  };
}

/** Legend words for a spot's band, in the surface's own vocabulary. */
export function spotBandLabel(
  band: PotentialSpot['band'],
  vocabulary: SurfaceVocabulary = 'fishing',
): string {
  return BAND_LABELS[vocabulary][band];
}
