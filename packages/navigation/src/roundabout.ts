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

/** How far out the stub for an exit we merely pass is drawn. */
const PASSED_RADIUS = 6.4;
/**
 * Most exits worth drawing. Beyond this the stubs crowd into an unreadable
 * fan, and a count that high is likelier to be bad data than a real ring.
 */
const MAX_PASSED_EXITS = 5;

export interface RoundaboutGlyph {
  /** Approach road, from the bottom edge up to the ring. */
  entry: string;
  /** Exit road, from the ring outward to the arrowhead. */
  exit: string;
  /**
   * Short stubs for the exits passed before ours, in the order they go by —
   * drawn faint, like the "road not taken" ghost on a fork icon, so the ring
   * shows what there is to count off rather than a single arrow out of a bare
   * circle. Empty when ours is the first exit or the router gave no count.
   */
  passed: string[];
  /** Where to place the shared triangular arrowhead, and its SVG rotation. */
  head: { x: number; y: number; angleDeg: number };
}

/** A radial stroke from the ring outward, at `angleDeg` from straight on. */
function spoke(angleDeg: number, outerR: number): string {
  const { cx, cy, r } = ROUNDABOUT_RING;
  const rad = (angleDeg * Math.PI) / 180;
  const sin = Math.sin(rad);
  const cos = Math.cos(rad);
  const round = (n: number) => Math.round(n * 10) / 10;
  return `M${round(cx + r * sin)} ${round(cy - r * cos)} L${round(cx + outerR * sin)} ${round(
    cy - outerR * cos,
  )}`;
}

/**
 * Paths for a roundabout maneuver. `exitAngleDeg` is the turn relative to the
 * approach (0 = straight on, positive = clockwise/right); null or undefined —
 * a router that didn't supply it — falls back to straight on. `exitNumber` is
 * the exit being taken, and adds a stub for each exit passed on the way.
 *
 * Those stubs are a *schematic*, and deliberately so. What the routing engine
 * knows — and the only thing a driver counting exits needs — is how many exits
 * go by before theirs; where each one leaves the ring is not in the route
 * response at all. So they are spread evenly across the arc actually driven,
 * from the approach round to our own exit, which is how a roundabout is drawn
 * on a road sign and how it comes out for the ordinary four-arm ring: 3rd exit
 * with a left-hand departure puts them at right and straight on. The one
 * angle taken from real geometry is ours, which is the one that has to be
 * right — the exit *number* says nothing about direction.
 *
 * `drivingSide` decides which way round the count runs, because circulation
 * mirrors with it: right-hand traffic goes anticlockwise, so exits arrive in
 * decreasing order of turn angle (right, then straight on, then left), while
 * left-hand traffic goes clockwise and they arrive in increasing order. Get
 * this wrong in the UK and the ring counts off exits that are on the far side
 * of the road from the ones the driver can see. It defaults to right-hand
 * traffic, which is both Atlas's home data and the way to be wrong in the
 * fewest places when the router gave nothing to measure.
 */
export function roundaboutGlyph(
  exitAngleDeg?: number | null,
  exitNumber?: number | null,
  drivingSide?: 'left' | 'right' | null,
): RoundaboutGlyph {
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

  const takes = exitNumber != null && exitNumber >= 2 ? Math.floor(exitNumber) : 0;
  const passed: string[] = [];
  if (takes >= 2 && takes - 1 <= MAX_PASSED_EXITS) {
    // The approach enters the ring at the bottom of the icon; the sweep runs
    // from there round to our exit, and the passed exits divide it. Which way
    // round is the driving side: circulating anticlockwise (drive on the
    // right) the arm behind us sits at +180 and the sweep falls towards our
    // exit; clockwise (drive on the left) it sits at −180 and the whole fan
    // mirrors, putting the passed exits on the driver's left where they are.
    const behind = drivingSide === 'left' ? -180 : 180;
    const step = (behind - drawn) / takes;
    for (let i = 1; i < takes; i++) passed.push(spoke(behind - i * step, PASSED_RADIUS));
  }

  return {
    entry: `M${cx} 22 V${round(cy + r)}`,
    exit: `M${startX} ${startY} L${round(cx + strokeR * sin)} ${round(cy - strokeR * cos)}`,
    passed,
    // The arrowhead artwork points east at 0°, so the compass-style angle
    // (0 = up) turns into an SVG rotation by subtracting a quarter turn.
    head: { x: tipX, y: tipY, angleDeg: round(drawn - 90) },
  };
}
