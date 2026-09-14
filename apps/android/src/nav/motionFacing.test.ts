import { describe, expect, it } from 'vitest';

import { magneticDeclinationDeg, motionFacingDeg } from './motionFacing';

describe('motionFacingDeg', () => {
  it('converts Expo rotation radians into clockwise compass bearings', () => {
    expect(motionFacingDeg(0)).toBe(0);
    expect(motionFacingDeg(-Math.PI / 2)).toBe(90);
    expect(motionFacingDeg(Math.PI / 2)).toBe(270);
  });

  it('applies magnetic declination and wraps through north', () => {
    expect(motionFacingDeg(-Math.PI * 1.99, 5)).toBeCloseTo(3.2, 5);
  });

  it('rejects unusable sensor values', () => {
    expect(motionFacingDeg(Number.NaN)).toBeNull();
    expect(motionFacingDeg(0, Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('magneticDeclinationDeg', () => {
  it('uses the shortest correction across north', () => {
    expect(magneticDeclinationDeg(358, 3)).toBe(5);
    expect(magneticDeclinationDeg(3, 358)).toBe(-5);
  });

  it('rejects an unavailable true heading', () => {
    expect(magneticDeclinationDeg(20, -1)).toBeNull();
  });
});
