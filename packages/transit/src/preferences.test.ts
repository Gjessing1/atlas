import { describe, expect, it } from 'vitest';

import { DEFAULT_TRANSIT_PREFERENCES, parseTransitPreferences } from './preferences.js';

describe('parseTransitPreferences', () => {
  it('fills older partial settings from safe defaults', () => {
    expect(parseTransitPreferences({ walkSpeedMps: 1.6 })).toEqual({
      ...DEFAULT_TRANSIT_PREFERENCES,
      walkSpeedMps: 1.6,
    });
  });

  it('keeps valid bicycle and rental-network choices', () => {
    expect(
      parseTransitPreferences({
        accessMode: 'bike_rental',
        bikeOptimisation: 'flat',
        bikeRentalNetworks: [' oslobysykkel ', '', 42],
      }),
    ).toMatchObject({
      accessMode: 'bike_rental',
      bikeOptimisation: 'flat',
      bikeRentalNetworks: ['oslobysykkel'],
    });
  });

  it('rejects non-records and replaces out-of-range values', () => {
    expect(parseTransitPreferences([])).toBeUndefined();
    expect(parseTransitPreferences('fast')).toBeUndefined();
    expect(parseTransitPreferences({ walkSpeedMps: 20, maximumTransfers: -1 })).toMatchObject({
      walkSpeedMps: DEFAULT_TRANSIT_PREFERENCES.walkSpeedMps,
      maximumTransfers: DEFAULT_TRANSIT_PREFERENCES.maximumTransfers,
    });
  });
});
