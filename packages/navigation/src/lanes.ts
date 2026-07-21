import type { LaneDirection, RouteLane } from '@atlas/routing';

/** One stroke-drawn arrow in the shared 24×32 lane-glyph coordinate space. */
export interface LaneGlyph {
  direction: LaneDirection;
  path: string;
  /** True for the particular branch that carries the upcoming maneuver. */
  recommended: boolean;
}

/**
 * Platform-neutral vector paths for a lane's painted directions. Web and
 * React Native both render these strings as SVG paths, keeping the semantics
 * and artwork identical without sharing a UI framework.
 */
const PATHS: Readonly<Record<LaneDirection, string>> = {
  none: 'M6 16H18',
  straight: 'M12 29V5M7 10L12 5L17 10',
  'sharp-left': 'M15 29V20C15 14 12 11 7 11H4M4 11L9 6M4 11L9 16',
  left: 'M14 29V19C14 13 10 10 5 10M5 10L10 5M5 10L10 15',
  'slight-left': 'M14 29V20C14 15 11 12 6 8M6 8L12 7M6 8L8 14',
  'slight-right': 'M10 29V20C10 15 13 12 18 8M18 8L12 7M18 8L16 14',
  right: 'M10 29V19C10 13 14 10 19 10M19 10L14 5M19 10L14 15',
  'sharp-right': 'M9 29V20C9 14 12 11 17 11H20M20 11L15 6M20 11L15 16',
  'u-turn': 'M15 29V13C15 6 6 6 6 13V18M2 14L6 18L10 14',
  'merge-left': 'M16 29V18C16 14 13 12 8 10M8 10L13 8M8 10L10 15',
  'merge-right': 'M8 29V18C8 14 11 12 16 10M16 10L11 8M16 10L14 15',
};

export function laneGlyphs(lane: RouteLane): LaneGlyph[] {
  return lane.directions.map((direction) => ({
    direction,
    path: PATHS[direction],
    recommended: lane.state !== 'invalid' && direction === lane.recommendedDirection,
  }));
}

/** Screen-reader phrase for one physical lane. */
export function laneLabel(lane: RouteLane): string {
  const directions = lane.directions
    .map((direction) => (direction === 'none' ? 'unmarked' : direction.replace('-', ' ')))
    .join(' or ');
  return `${directions}, ${lane.state === 'invalid' ? 'do not use' : 'use this lane'}`;
}
