import { describe, expect, it } from 'vitest';
import { normalizeVehicle, VEHICLE_LIMITS } from './model.js';

describe('normalizeVehicle', () => {
  it('keeps a well-formed vehicle intact', () => {
    expect(normalizeVehicle({ heightM: 2.8, widthM: 2.22, topSpeedKph: 80 })).toEqual({
      heightM: 2.8,
      widthM: 2.22,
      topSpeedKph: 80,
    });
  });

  it('refuses a vehicle with no height', () => {
    // Height is the field with consequences. A profile that lost it must fall
    // back to "an ordinary car", never to a guessed clearance.
    expect(normalizeVehicle({ widthM: 2.22, topSpeedKph: 80 })).toBeNull();
    expect(normalizeVehicle({ heightM: '2.8' })).toBeNull();
    expect(normalizeVehicle({ heightM: Number.NaN })).toBeNull();
    expect(normalizeVehicle(null)).toBeNull();
    expect(normalizeVehicle('2.8')).toBeNull();
  });

  it('fills the fields that have a safe default', () => {
    // Width and speed can be assumed; height cannot.
    expect(normalizeVehicle({ heightM: 2.8 })).toEqual({
      heightM: 2.8,
      widthM: 2,
      topSpeedKph: 80,
    });
  });

  it('clamps values into Atlas’s own sanity range', () => {
    // Not the engine's range — auto costing accepts 0 and 300 without
    // complaint, so a typo would otherwise route as though it were meant.
    const low = normalizeVehicle({ heightM: 0.2, widthM: 0.1, topSpeedKph: 2 });
    expect(low).toEqual({
      heightM: VEHICLE_LIMITS.heightM.min,
      widthM: VEHICLE_LIMITS.widthM.min,
      topSpeedKph: VEHICLE_LIMITS.topSpeedKph.min,
    });
    const high = normalizeVehicle({ heightM: 40, widthM: 12, topSpeedKph: 400 });
    expect(high).toEqual({
      heightM: VEHICLE_LIMITS.heightM.max,
      widthM: VEHICLE_LIMITS.widthM.max,
      topSpeedKph: VEHICLE_LIMITS.topSpeedKph.max,
    });
  });
});
