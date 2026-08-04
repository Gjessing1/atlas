import { describe, expect, it } from 'vitest';
import { slopeFromRing } from './terrain.js';

/** The eight bearings the stand rose is traced on — and the ring we sample. */
const BEARINGS = [0, 45, 90, 135, 180, 225, 270, 315];

/**
 * A ring on a perfect plane falling `gradient` metres per metre toward
 * `downhillDeg` — the answer the fit must recover.
 */
function planeRing(downhillDeg: number, gradient: number, radiusM = 60) {
  return BEARINGS.map((bearingDeg) => {
    const radians = (bearingDeg * Math.PI) / 180;
    const east = Math.sin(radians) * radiusM;
    const north = Math.cos(radians) * radiusM;
    const downRadians = (downhillDeg * Math.PI) / 180;
    // Height falls as you move toward the downhill bearing.
    const along = east * Math.sin(downRadians) + north * Math.cos(downRadians);
    return { bearingDeg, elevationM: 300 - gradient * along };
  });
}

describe('slopeFromRing', () => {
  it('recovers the steepness of a known plane', () => {
    const fit = slopeFromRing(planeRing(180, Math.tan((12 * Math.PI) / 180)), 60)!;
    expect(fit.slopeDeg).toBeCloseTo(12, 1);
  });

  it('points the aspect the way the ground falls, not the way it rises', () => {
    // A slope falling to the south: cold air drains south at first light.
    expect(slopeFromRing(planeRing(180, 0.25), 60)!.aspectDeg).toBe(180);
    expect(slopeFromRing(planeRing(45, 0.25), 60)!.aspectDeg).toBe(45);
  });

  // The reason for a plane fit rather than a steepest-neighbour rule: one noisy
  // sample on a national elevation model must not manufacture a hillside.
  it('reports level ground as level, with no downhill direction', () => {
    const flat = BEARINGS.map((bearingDeg) => ({ bearingDeg, elevationM: 212 }));
    const fit = slopeFromRing(flat, 60)!;
    expect(fit.slopeDeg).toBe(0);
    expect(fit.aspectDeg).toBeNull();
  });

  it('still fits when part of the ring is off the elevation model', () => {
    const ring = planeRing(90, 0.2).map((sample, index) =>
      index < 3 ? { ...sample, elevationM: null } : sample,
    );
    expect(slopeFromRing(ring, 60)!.aspectDeg).toBe(90);
  });

  it('refuses a fit through too few samples rather than inventing one', () => {
    const ring = planeRing(90, 0.2).map((sample, index) =>
      index < 5 ? { ...sample, elevationM: null } : sample,
    );
    expect(slopeFromRing(ring, 60)).toBeNull();
    expect(slopeFromRing(planeRing(90, 0.2), 0)).toBeNull();
  });
});
