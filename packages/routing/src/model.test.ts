import { describe, expect, it } from 'vitest';
import {
  defaultRoutePreferences,
  normalizeVehicle,
  ROUTE_OPTIONS,
  routeOptionsFor,
  ROUTE_ACTIONS,
  routeActionsFor,
  ROUTING_PROFILES,
  VEHICLE_LIMITS,
  vehicleChipLabel,
} from './model.js';

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

describe('routeOptionsFor', () => {
  it('offers only the controls that mean something for the profile', () => {
    expect(routeOptionsFor('car').map((o) => o.key)).toEqual([
      'avoidFerries',
      'avoidHighways',
      'avoidTolls',
    ]);
    expect(routeOptionsFor('foot').map((o) => o.key)).toEqual(['avoidHills']);
    expect(routeOptionsFor('bike').map((o) => o.key)).toEqual([
      'avoidHighways',
      'avoidHills',
      'preferTrails',
      'avoidUnpaved',
    ]);
  });

  it('keeps every profile worth a chip row', () => {
    // A profile with nothing to offer would render an empty options row, which
    // reads as a broken control rather than as "no choices here".
    for (const profile of ROUTING_PROFILES) {
      expect(routeOptionsFor(profile.id).length).toBeGreaterThan(0);
    }
  });

  it('gives every option a chip label short enough to sit in the row', () => {
    for (const option of ROUTE_OPTIONS) {
      expect(option.chipLabel.length).toBeLessThanOrEqual(14);
      expect(option.label.length).toBeGreaterThan(option.chipLabel.length);
    }
  });

  it('only ever names a boolean preference', () => {
    const defaults = defaultRoutePreferences('car');
    for (const option of ROUTE_OPTIONS) {
      expect(typeof defaults[option.key]).toBe('boolean');
    }
  });
});

describe('routeActionsFor', () => {
  it('gives each mode a toolbar of its own', () => {
    // Driving edits a plan for fuel and rest; walking plans a track to keep and
    // carry. Neither wants to read past the other's actions to reach Clear.
    expect(routeActionsFor('car').primary.map((a) => a.key)).toEqual([
      'alongRoute',
      'reverse',
      'clear',
      'share',
    ]);
    expect(routeActionsFor('bike').primary.map((a) => a.key)).toEqual([
      'exportGpx',
      'reverse',
      'clear',
      'share',
    ]);
    expect(routeActionsFor('hike').primary.map((a) => a.key)).toEqual([
      'saveTrack',
      'exportGpx',
      'clear',
      'share',
    ]);
  });

  it('folds every remaining action rather than dropping it', () => {
    // The split is placement, never capability: a mode that hid an action
    // would be a planner that can do less depending on how you travel.
    for (const profile of ROUTING_PROFILES) {
      const { primary, more } = routeActionsFor(profile.id);
      expect([...primary, ...more].map((a) => a.key).sort()).toEqual(
        ROUTE_ACTIONS.map((a) => a.key).sort(),
      );
      expect(primary.some((a) => more.includes(a))).toBe(false);
    }
  });

  it('keeps the mode-independent actions in every visible row', () => {
    // Clear and Share mean the same thing whatever is being planned, so a mode
    // that folded them would be trading a constant for nothing.
    for (const profile of ROUTING_PROFILES) {
      const keys = routeActionsFor(profile.id).primary.map((a) => a.key);
      expect(keys).toContain('clear');
      expect(keys).toContain('share');
    }
  });

  it('keeps the visible row short enough to stay one row of chrome', () => {
    // Four was the point of the split: six same-weight buttons wrapped to two
    // rows above the answer on every phone this panel opens on.
    for (const profile of ROUTING_PROFILES) {
      expect(routeActionsFor(profile.id).primary.length).toBeLessThanOrEqual(4);
    }
  });
});

describe('vehicleChipLabel', () => {
  it('describes the vehicle being routed for', () => {
    expect(vehicleChipLabel('car', { heightM: 2.8, widthM: 2.2, topSpeedKph: 80 })).toBe(
      '2.8 m · 80 km/h',
    );
    expect(vehicleChipLabel('car', { heightM: 3, widthM: 2.2, topSpeedKph: 90 })).toBe(
      '3 m · 90 km/h',
    );
  });

  it('is absent where it would be noise', () => {
    // No vehicle is an ordinary car, which the engine assumes anyway; and the
    // dimensions do not bind a bike or a pair of boots.
    expect(vehicleChipLabel('car', null)).toBeNull();
    expect(vehicleChipLabel('bike', { heightM: 2.8, widthM: 2.2, topSpeedKph: 80 })).toBeNull();
  });

  it('describes what would actually be routed, not what was typed', () => {
    // Clamped by normalizeVehicle, so the chip cannot promise a height the
    // engine was never asked about.
    expect(vehicleChipLabel('car', { heightM: 40, widthM: 2.2, topSpeedKph: 400 })).toBe(
      '5 m · 130 km/h',
    );
  });
});
