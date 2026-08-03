/**
 * Hunter-side planning over a habitat surface (ROADMAP N5/E8).
 *
 * A habitat maximum is where the animal may hold; it is often the wrong place
 * for a person to sit. This module keeps those questions separate. It samples
 * candidate stands, traces eight terrain/canopy sight lines to 150 m, and pairs
 * each candidate with habitat visible inside that distance.
 *
 * The result is deliberately directional. A scalar cannot distinguish a stand
 * that is open toward the holding cover from one whose only opening faces away
 * from it. The eight lane and pair planes are persisted with the ordinary hunt
 * signals, so the backend can later draw the rose without fetching the source
 * rasters again.
 */

import { createGrid, focalMean, type Grid, type Mask } from './raster.js';

/** Typical big-game planning distance requested by E8 and the field workflow. */
export const STAND_MAX_RANGE_M = 150;

/** A screen this high hides a roe deer and closes a useful ground-level lane. */
export const STAND_SCREEN_M = 2;

/** Eye and target heights used only for terrain visibility, not ballistics. */
const OBSERVER_HEIGHT_M = 1.7;
const TARGET_HEIGHT_M = 1;

/** Persisted vantage encoding: -25 m → 0, +25 m → 1. */
export const STAND_VANTAGE_MIN_M = -25;
export const STAND_VANTAGE_MAX_M = 25;

/**
 * Eight bearings are enough at the source raster's ~10 m resolution and make
 * the card readable ("open S–SE"), rather than presenting fake single-degree
 * precision from classified canopy data.
 */
export const STAND_DIRECTIONS = [
  { key: 'n', label: 'N', bearing: 0 },
  { key: 'ne', label: 'NE', bearing: 45 },
  { key: 'e', label: 'E', bearing: 90 },
  { key: 'se', label: 'SE', bearing: 135 },
  { key: 's', label: 'S', bearing: 180 },
  { key: 'sw', label: 'SW', bearing: 225 },
  { key: 'w', label: 'W', bearing: 270 },
  { key: 'nw', label: 'NW', bearing: 315 },
] as const;

export type StandDirectionKey = (typeof STAND_DIRECTIONS)[number]['key'];

export interface HuntStandPlan {
  /** Raw hunter-side quality: visible habitat inside one shot, with vantage. */
  readonly score: Grid;
  /** Encoded elevation relative to the surrounding 150 m. */
  readonly vantage: Grid;
  /** Visible open distance per bearing, divided by STAND_MAX_RANGE_M. */
  readonly lanes: Readonly<Record<StandDirectionKey, Grid>>;
  /** Habitat pairing strength per bearing, 0..1. */
  readonly pairs: Readonly<Record<StandDirectionKey, Grid>>;
  /** Distance to the best visible habitat per bearing, divided by max range. */
  readonly aims: Readonly<Record<StandDirectionKey, Grid>>;
}

export interface HuntStandInputs {
  /** Quarry-specific raw habitat score, not its percentile colouring. */
  readonly habitat: Grid;
  /** DTM elevation in metres. */
  readonly terrain: Grid;
  /** Canopy/screen height above terrain; zero is open, NaN is treated as unknown/closed. */
  readonly screenHeightM: Grid;
  /** Ground where a person could in principle stand (not water/developed). */
  readonly standable: Mask;
}

function sameShape(a: Grid, b: Grid | Mask): boolean {
  return a.width === b.width && a.height === b.height && a.cellSizeM === b.cellSizeM;
}

function emptySet(shape: Grid): Record<StandDirectionKey, Grid> {
  return Object.fromEntries(
    STAND_DIRECTIONS.map((direction) => [
      direction.key,
      createGrid(shape.width, shape.height, shape.cellSizeM),
    ]),
  ) as Record<StandDirectionKey, Grid>;
}

/** Decode the compact vantage plane back to metres for a stand card. */
export function decodeStandVantage(value: number): number {
  return STAND_VANTAGE_MIN_M + value * (STAND_VANTAGE_MAX_M - STAND_VANTAGE_MIN_M);
}

/**
 * Trace the hunter-side plan.
 *
 * `sampleStride` defaults to four because derive persists one 256² signal
 * sample for each 4×4 block of its 1024² cell. Computing the other fifteen
 * pixels would add no information to the artifact and makes an eight-ray LOS
 * pass sixteen times dearer. Tests may use stride one on small synthetic grids.
 */
export function huntStandPlan(
  inputs: HuntStandInputs,
  opts: { sampleStride?: number; maxRangeM?: number } = {},
): HuntStandPlan {
  const { habitat, terrain, screenHeightM, standable } = inputs;
  if (
    !sameShape(habitat, terrain) ||
    !sameShape(habitat, screenHeightM) ||
    !sameShape(habitat, standable)
  ) {
    throw new Error('huntStandPlan: input size mismatch');
  }

  const stride = Math.max(1, Math.floor(opts.sampleStride ?? 4));
  const maxRangeM = opts.maxRangeM ?? STAND_MAX_RANGE_M;
  const score = createGrid(habitat.width, habitat.height, habitat.cellSizeM);
  const vantage = createGrid(habitat.width, habitat.height, habitat.cellSizeM);
  const lanes = emptySet(habitat);
  const pairs = emptySet(habitat);
  const aims = emptySet(habitat);
  const surrounding = focalMean(terrain, Math.max(1, Math.round(maxRangeM / terrain.cellSizeM)));

  // Centre the one computed pixel in each persisted stride-sized block.
  const offset = Math.floor(stride / 2);
  for (let y = offset; y < habitat.height; y += stride) {
    for (let x = offset; x < habitat.width; x += stride) {
      const index = y * habitat.width + x;
      const elevation = terrain.data[index]!;
      if (standable.data[index] !== 1 || !Number.isFinite(elevation)) continue;

      const around = surrounding.data[index]!;
      const vantageM = Number.isFinite(around) ? elevation - around : 0;
      const encodedVantage = Math.max(
        0,
        Math.min(1, (vantageM - STAND_VANTAGE_MIN_M) / (STAND_VANTAGE_MAX_M - STAND_VANTAGE_MIN_M)),
      );
      vantage.data[index] = encodedVantage;

      let best = 0;
      for (const direction of STAND_DIRECTIONS) {
        const radians = (direction.bearing * Math.PI) / 180;
        const eye = elevation + OBSERVER_HEIGHT_M;
        let horizon = Number.NEGATIVE_INFINITY;
        let visibleOpenM = 0;
        let bestPair = 0;
        let bestAimM = 0;
        let previousX = x;
        let previousY = y;

        for (
          let distanceM = terrain.cellSizeM;
          distanceM <= maxRangeM + 0.01;
          distanceM += terrain.cellSizeM
        ) {
          const tx = Math.round(x + (Math.sin(radians) * distanceM) / terrain.cellSizeM);
          const ty = Math.round(y - (Math.cos(radians) * distanceM) / terrain.cellSizeM);
          if (tx === previousX && ty === previousY) continue;
          previousX = tx;
          previousY = ty;
          if (tx < 0 || ty < 0 || tx >= terrain.width || ty >= terrain.height) break;

          const targetIndex = ty * terrain.width + tx;
          const targetElevation = terrain.data[targetIndex]!;
          if (!Number.isFinite(targetElevation)) break;
          const actualM = Math.hypot(tx - x, ty - y) * terrain.cellSizeM;
          if (actualM > maxRangeM + terrain.cellSizeM * 0.75) break;

          const screen = screenHeightM.data[targetIndex]!;
          // Unknown canopy is not called open. This loses a lane when SR16 is
          // absent instead of inventing one through an unread forest.
          const open = Number.isFinite(screen) && screen < STAND_SCREEN_M;
          const targetAngle = Math.atan2(targetElevation + TARGET_HEIGHT_M - eye, actualM);
          const visible = targetAngle + 1e-9 >= horizon;
          if (visible && open) {
            visibleOpenM = Math.max(visibleOpenM, Math.min(maxRangeM, actualM));
            const habitatValue = habitat.data[targetIndex]!;
            if (Number.isFinite(habitatValue)) {
              // A 100–150 m pairing earns full distance value; close cover is
              // still useful for calling, but not mistaken for a shooting lane.
              const distanceValue = Math.min(1, actualM / 100);
              const pair = habitatValue * distanceValue;
              if (pair > bestPair) {
                bestPair = pair;
                bestAimM = Math.min(maxRangeM, actualM);
              }
            }
          }

          // Terrain and canopy affect subsequent samples. At an open point the
          // one-metre target height is the obstruction; in cover, canopy top is.
          const obstructionHeight = open
            ? TARGET_HEIGHT_M
            : Number.isFinite(screen)
              ? Math.max(STAND_SCREEN_M, screen)
              : 20;
          const obstruction = Math.atan2(targetElevation + obstructionHeight - eye, actualM);
          if (Number.isFinite(obstruction)) horizon = Math.max(horizon, obstruction);
        }

        lanes[direction.key].data[index] = visibleOpenM / maxRangeM;
        pairs[direction.key].data[index] = bestPair;
        aims[direction.key].data[index] = bestAimM / maxRangeM;
        if (bestPair > best) best = bestPair;
      }

      // Vantage refines a viable pairing; it can never manufacture one. Low
      // points retain 65 % because a level field edge can still be a good stand.
      score.data[index] = best > 0 ? best * (0.65 + 0.35 * encodedVantage) : Number.NaN;
    }
  }

  return { score, vantage, lanes, pairs, aims };
}
