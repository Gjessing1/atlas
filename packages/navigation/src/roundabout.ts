/**
 * The roundabout icon's geometry, shared by the web and Android turn icons so
 * the two draw the same ring. The exit arrow points where the route actually
 * leaves the ring (`RouteInstruction.exitAngleDeg`), because the exit *number*
 * says nothing about direction: "take the 2nd exit" is straight on at one
 * roundabout and a hard right at the next, and an icon that always drew
 * straight on was telling drivers the wrong thing.
 */

/** Ring centre and radius in the shared 24×24 icon space. */
export const ROUNDABOUT_RING = { cx: 12, cy: 13.6, r: 4.2 } as const;

/**
 * How far from the centre the arrowhead sits. Kept small enough that the head
 * (which extends ~4.2 further) stays inside the 24×24 box at every angle, and
 * matched to the straight-on arrow the icon has always drawn.
 */
const EXIT_RADIUS = 7.6;
/** The exit stroke stops just short of the head so the two don't double up. */
const EXIT_STROKE_GAP = 0.5;
/**
 * A near-180° exit would draw straight back down the approach stub, so the
 * artwork leans it aside rather than hiding it under the entry line.
 */
const MAX_DRAWN_ANGLE = 155;

export interface RoundaboutGlyph {
  /** Approach road, from the bottom edge up to the ring. */
  entry: string;
  /** Exit road, from the ring outward to the arrowhead. */
  exit: string;
  /** Where to place the shared triangular arrowhead, and its SVG rotation. */
  head: { x: number; y: number; angleDeg: number };
}

/**
 * Paths for a roundabout maneuver. `exitAngleDeg` is the turn relative to the
 * approach (0 = straight on, positive = clockwise/right); null or undefined —
 * a router that didn't supply it — falls back to straight on.
 */
export function roundaboutGlyph(exitAngleDeg?: number | null): RoundaboutGlyph {
  const { cx, cy, r } = ROUNDABOUT_RING;
  const raw = exitAngleDeg ?? 0;
  const drawn = Math.max(-MAX_DRAWN_ANGLE, Math.min(MAX_DRAWN_ANGLE, raw));
  const rad = (drawn * Math.PI) / 180;
  const sin = Math.sin(rad);
  const cos = Math.cos(rad);
  const round = (n: number) => Math.round(n * 10) / 10;
  const startX = round(cx + r * sin);
  const startY = round(cy - r * cos);
  const tipX = round(cx + EXIT_RADIUS * sin);
  const tipY = round(cy - EXIT_RADIUS * cos);
  const strokeR = EXIT_RADIUS - EXIT_STROKE_GAP;
  return {
    entry: `M${cx} 22 V${round(cy + r)}`,
    exit: `M${startX} ${startY} L${round(cx + strokeR * sin)} ${round(cy - strokeR * cos)}`,
    // The arrowhead artwork points east at 0°, so the compass-style angle
    // (0 = up) turns into an SVG rotation by subtracting a quarter turn.
    head: { x: tipX, y: tipY, angleDeg: round(drawn - 90) },
  };
}
