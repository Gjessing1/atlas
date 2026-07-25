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

  it('draws one stub per exit passed, and none for the first exit', () => {
    expect(roundaboutGlyph(90, 1).passed).toHaveLength(0);
    expect(roundaboutGlyph(0, undefined).passed).toHaveLength(0);
    expect(roundaboutGlyph(0, 2).passed).toHaveLength(1);
    expect(roundaboutGlyph(-90, 3).passed).toHaveLength(2);
    // A count no ring could really have is left undrawn rather than fanned out.
    expect(roundaboutGlyph(0, 12).passed).toHaveLength(0);
  });

  it('spreads the passed exits across the arc actually driven', () => {
    // The textbook four-arm ring: 3rd exit turning left puts the two passed
    // exits at right (90°) and straight on (0°).
    const [first, second] = roundaboutGlyph(-90, 3).passed;
    const { cx, cy, r } = ROUNDABOUT_RING;
    // Each stub starts on the ring at its own angle: right, then straight up.
    expect(first).toContain(`M${(cx + r).toFixed(1)} ${cy.toFixed(1)}`);
    expect(second).toContain(`M${cx.toFixed(0)} ${(cy - r).toFixed(1)}`);
  });
});
