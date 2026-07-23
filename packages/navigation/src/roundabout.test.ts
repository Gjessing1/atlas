import { describe, expect, it } from 'vitest';
import { roundaboutGlyph, ROUNDABOUT_RING } from './roundabout.js';

/** Distance of the arrowhead from the ring centre — the exit ray's length. */
function headRadius(angle: number | null | undefined): number {
  const { x, y } = roundaboutGlyph(angle).head;
  return Math.hypot(x - ROUNDABOUT_RING.cx, y - ROUNDABOUT_RING.cy);
}

describe('roundaboutGlyph', () => {
  it('points the exit straight up when the angle is unknown', () => {
    const glyph = roundaboutGlyph(undefined);
    expect(glyph.head.x).toBe(ROUNDABOUT_RING.cx);
    expect(glyph.head.y).toBeLessThan(ROUNDABOUT_RING.cy);
    expect(glyph.head.angleDeg).toBe(-90);
  });

  it('swings the exit to the drawn side of the ring', () => {
    const right = roundaboutGlyph(90);
    expect(right.head.x).toBeGreaterThan(ROUNDABOUT_RING.cx);
    expect(right.head.y).toBeCloseTo(ROUNDABOUT_RING.cy, 1);

    const left = roundaboutGlyph(-90);
    expect(left.head.x).toBeLessThan(ROUNDABOUT_RING.cx);
    expect(left.head.angleDeg).toBe(-180);
  });

  it('keeps every exit at the same radius, so the icon stays balanced', () => {
    for (const angle of [-135, -45, 0, 45, 135]) {
      expect(headRadius(angle)).toBeCloseTo(headRadius(0), 1);
    }
  });

  it('leans a near-U-turn exit aside instead of under the approach stub', () => {
    const back = roundaboutGlyph(179);
    expect(Math.abs(back.head.x - ROUNDABOUT_RING.cx)).toBeGreaterThan(1);
    // Still drawn on the side it turns towards.
    expect(back.head.x).toBeGreaterThan(ROUNDABOUT_RING.cx);
  });
});
