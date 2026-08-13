import { describe, expect, it } from 'vitest';

import { FacingBlender } from './facing.js';

describe('FacingBlender', () => {
  it('reports the compass while standing still and normalizes the angle', () => {
    const b = new FacingBlender();
    b.updateCompass(-90, 10, 1000);
    // Standing still (below compassOnlySpeedMps): pure compass, whatever the course.
    expect(b.current(0, 200, 1000)).toEqual({ deg: 270, accuracyDeg: 10 });
  });

  it('crossfades from compass toward course as speed rises', () => {
    const b = new FacingBlender();
    b.updateCompass(0, 10, 1000); // facing north
    // Standing still: pure compass.
    expect(b.current(0, 90, 1000)?.deg).toBeCloseTo(0, 5);
    // Brisk walk (>= courseOnlySpeedMps): the compass no longer contributes, so
    // the blender bows out (null) and the caller draws the course itself.
    expect(b.current(2, 90, 1000)).toBeNull();
    // Mid-walk (1 m/s, band 0.4..1.6): a blend that sits between the two.
    const mid = b.current(1, 90, 1000)!.deg;
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(90);
  });

  it('keeps the compass when there is no route course to blend with', () => {
    const b = new FacingBlender();
    b.updateCompass(45, 10, 1000);
    // Even moving fast, a null course leaves the compass in charge.
    expect(b.current(5, null, 1000)).toEqual({ deg: 45, accuracyDeg: 10 });
  });

  it('drops readings the sensor flags as junk, and stale ones', () => {
    const b = new FacingBlender();
    b.updateCompass(45, 90, 1000); // uncalibrated: worse than the 60° cutoff
    expect(b.current(0, null, 1000)).toBeNull();
    b.updateCompass(45, 10, 2000);
    expect(b.current(0, null, 2000)).not.toBeNull();
    expect(b.current(0, null, 2000 + 6000)).toBeNull(); // compass went quiet
  });

  it('low-pass filters compass jitter but still tracks a real turn', () => {
    const b = new FacingBlender();
    b.updateCompass(0, 10, 1000);
    // A 4° jitter is heavily damped — the shown heading barely moves.
    b.updateCompass(4, 10, 1100);
    expect(b.current(0, null, 1100)!.deg).toBeLessThan(2);
    // A 90° turn is tracked within a couple of samples rather than crawling.
    b.updateCompass(90, 10, 1200);
    b.updateCompass(90, 10, 1300);
    b.updateCompass(90, 10, 1400);
    expect(b.current(0, null, 1400)!.deg).toBeGreaterThan(80);
  });

  it('rejects a lone near-opposite spike but accepts a confirmed fast turn', () => {
    const b = new FacingBlender();
    b.updateCompass(10, 15, 1000);
    b.updateCompass(188, 15, 1100);
    expect(b.current(0, null, 1100)!.deg).toBe(10);

    // A second nearby reading proves that this is a real turn rather than the
    // common one-sample magnetometer flip.
    b.updateCompass(190, 15, 1200);
    expect(b.current(0, null, 1200)!.deg).toBeGreaterThan(150);
  });

  it('uses accuracy hysteresis so a marginal sample cannot flicker the arrow', () => {
    const b = new FacingBlender();
    b.updateCompass(20, 70, 1000);
    expect(b.current(0, null, 1000)).toBeNull();
    b.updateCompass(22, 55, 1100);
    expect(b.current(0, null, 1100)).toBeNull();
    b.updateCompass(24, 40, 1200);
    expect(b.current(0, null, 1200)).not.toBeNull();
  });

  it('treats unknown accuracy (web) as usable', () => {
    const b = new FacingBlender();
    b.updateCompass(120, null, 1000);
    expect(b.current(null, null, 1000)).toEqual({ deg: 120, accuracyDeg: null });
  });
});
