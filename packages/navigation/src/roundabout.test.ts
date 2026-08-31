import { describe, expect, it } from 'vitest';
import { roundaboutGlyph, ROUNDABOUT_RING } from './roundabout.js';

/** Distance of the arrowhead from the ring centre — the exit ray's length. */
function headRadius(angle: number | null | undefined): number {
  const { x, y } = roundaboutGlyph(angle).head;
  return Math.hypot(x - ROUNDABOUT_RING.cx, y - ROUNDABOUT_RING.cy);
}

/** Reflect a stub path about the icon's vertical centre line. */
function mirrorX(path: string): string {
  return path.replace(/-?\d+(?:\.\d+)?/g, (n, offset: number) =>
    // Only the x coordinates move: they are the numbers a command letter
    // introduces, and every command here is followed by an x then a y.
    /[ML]$/.test(path.slice(0, offset))
      ? String(Math.round((2 * ROUNDABOUT_RING.cx - Number(n)) * 10) / 10)
      : n,
  );
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

  it('counts the passed exits the other way round on the left', () => {
    // The same textbook four-arm ring in Britain. Circulation is clockwise,
    // so the 3rd exit is a right turn and the two exits counted off on the
    // way are the ones on the driver's left: left (-90°), then straight on.
    const [first, second] = roundaboutGlyph(90, 3, 'left').passed;
    const { cx, cy, r } = ROUNDABOUT_RING;
    expect(first).toContain(`M${(cx - r).toFixed(1)} ${cy.toFixed(1)}`);
    expect(second).toContain(`M${cx.toFixed(0)} ${(cy - r).toFixed(1)}`);
  });

  it('puts the one passed exit of a straight-on 2nd exit on the driven side', () => {
    const { cx, cy, r } = ROUNDABOUT_RING;
    // Right-hand traffic passes it on the right...
    expect(roundaboutGlyph(0, 2, 'right').passed[0]).toContain(
      `M${(cx + r).toFixed(1)} ${cy.toFixed(1)}`,
    );
    // ...left-hand traffic on the left. Nothing else about the icon moves.
    expect(roundaboutGlyph(0, 2, 'left').passed[0]).toContain(
      `M${(cx - r).toFixed(1)} ${cy.toFixed(1)}`,
    );
  });

  it('mirrors the whole fan, not just its ends', () => {
    // Every stub of a left-hand ring is the mirror of its right-hand twin,
    // so a wrong side cannot hide in the middle of a crowded fan.
    const mirrored = roundaboutGlyph(-120, 4, 'left').passed;
    const straight = roundaboutGlyph(120, 4, 'right').passed;
    expect(mirrored).toHaveLength(3);
    expect(mirrored.map(mirrorX)).toEqual(straight);
  });

  it('falls back to right-hand traffic when the side was not measured', () => {
    // A router that gave nothing to measure must not silently flip the count.
    expect(roundaboutGlyph(-90, 3, undefined).passed).toEqual(roundaboutGlyph(-90, 3).passed);
    expect(roundaboutGlyph(-90, 3, null).passed).toEqual(roundaboutGlyph(-90, 3, 'right').passed);
  });
});
