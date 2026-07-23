import { describe, expect, it } from 'vitest';

import { FacingBlender } from './facing.js';

describe('FacingBlender', () => {
  it('reports the compass while standing still and normalizes the angle', () => {
    const b = new FacingBlender();
    b.updateCompass(-90, 10, 1000);
    expect(b.current(0, 1000)).toEqual({ deg: 270, accuracyDeg: 10 });
  });

  it('hands over to the course above the release speed and back below the re-arm speed', () => {
    const b = new FacingBlender();
    b.updateCompass(45, 10, 1000);
    expect(b.current(1.2, 1000)).not.toBeNull();
    // Fast: course regime, no facing.
    expect(b.current(2.5, 1000)).toBeNull();
    // The hysteresis band: 1.8 m/s is below the release but above the re-arm,
    // so the source must not flap back yet.
    expect(b.current(1.8, 1000)).toBeNull();
    // Genuinely walking again: compass returns.
    expect(b.current(1.2, 1000)).not.toBeNull();
  });

  it('drops readings the sensor flags as junk, and stale ones', () => {
    const b = new FacingBlender();
    b.updateCompass(45, 90, 1000); // uncalibrated: worse than the 60° cutoff
    expect(b.current(0, 1000)).toBeNull();
    b.updateCompass(45, 10, 2000);
    expect(b.current(0, 2000)).not.toBeNull();
    expect(b.current(0, 2000 + 6000)).toBeNull(); // compass went quiet
  });

  it('treats unknown accuracy (web) as usable', () => {
    const b = new FacingBlender();
    b.updateCompass(120, null, 1000);
    expect(b.current(null, 1000)).toEqual({ deg: 120, accuracyDeg: null });
  });
});
