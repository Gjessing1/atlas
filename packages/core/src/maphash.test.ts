import { describe, expect, it } from 'vitest';
import { decodeMapHash, decodeMapLink, encodeMapHash } from './index.js';

describe('map hash', () => {
  it('round-trips camera and pin', () => {
    const state = {
      center: { lat: 59.91384, lng: 10.75234 },
      zoom: 12.3,
      pin: { lat: 58.99, lng: 6.19 },
    };
    expect(encodeMapHash(state)).toBe('#map=12.3/59.91384/10.75234&pin=58.99/6.19');
    expect(decodeMapHash(encodeMapHash(state))).toEqual(state);
  });

  it('round-trips without a pin', () => {
    const state = { center: { lat: -33.9, lng: 151.2 }, zoom: 5 };
    expect(decodeMapHash(encodeMapHash(state))).toEqual(state);
  });

  it('limits coordinate precision', () => {
    expect(encodeMapHash({ center: { lat: 1.123456789, lng: 2.987654321 }, zoom: 7.777777 })).toBe(
      '#map=7.78/1.12346/2.98765',
    );
  });

  it('rejects hashes without a map view', () => {
    expect(decodeMapHash('')).toBeNull();
    expect(decodeMapHash('#pin=1/2')).toBeNull();
    expect(decodeMapHash('#map=abc/1/2')).toBeNull();
  });

  it('round-trips a route plan', () => {
    const state = {
      center: { lat: 59.91384, lng: 10.75234 },
      zoom: 12.3,
      route: {
        profile: 'bike',
        points: [
          { lat: 59.91, lng: 10.75 },
          { lat: 60.79, lng: 10.69 },
          { lat: -1.5, lng: -33.25 },
        ],
      },
    };
    expect(encodeMapHash(state)).toBe(
      '#map=12.3/59.91384/10.75234&route=bike/59.91,10.75/60.79,10.69/-1.5,-33.25',
    );
    expect(decodeMapHash(encodeMapHash(state))).toEqual(state);
  });

  it('keeps direct legs in a shared plan', () => {
    const state = {
      center: { lat: 59.91, lng: 10.75 },
      zoom: 12,
      route: {
        profile: 'hike',
        points: [
          { lat: 59.9, lng: 10.7 },
          { lat: 59.91, lng: 10.71 },
          { lat: 59.92, lng: 10.72 },
        ],
        directLegs: [1],
      },
    };
    expect(encodeMapHash(state)).toContain('&direct=1');
    expect(decodeMapHash(encodeMapHash(state))).toEqual(state);
  });

  it('round-trips a round-trip plan', () => {
    const state = {
      center: { lat: 59.91, lng: 10.75 },
      zoom: 10,
      route: { profile: 'foot', points: [{ lat: 59.91, lng: 10.75 }], roundTripKm: 12.5 },
    };
    expect(encodeMapHash(state)).toBe('#map=10/59.91/10.75&route=foot/59.91,10.75&loop=12.5');
    expect(decodeMapHash(encodeMapHash(state))).toEqual(state);
  });

  it('round-trips an explicit loop direction', () => {
    const state = {
      center: { lat: 59.91, lng: 10.75 },
      zoom: 10,
      route: {
        profile: 'bike',
        points: [{ lat: 59.91, lng: 10.75 }],
        roundTripKm: 30,
        roundTripDirection: 'counterclockwise' as const,
      },
    };
    expect(encodeMapHash(state)).toContain('&loop=30&loopdir=ccw');
    expect(decodeMapHash(encodeMapHash(state))).toEqual(state);
  });

  it('keeps the stops of a loop that has some', () => {
    const plan = decodeMapHash(
      '#map=10/59.91/10.75&route=car/59.91,10.75/60.1,10.9&loop=12',
    )?.route;
    expect(plan?.points).toHaveLength(2);
    expect(plan?.roundTripKm).toBe(12);
  });

  it('ignores a loop length that is not a distance', () => {
    const plan = decodeMapHash('#map=10/59.91/10.75&route=car/59.91,10.75&loop=0')?.route;
    expect(plan?.roundTripKm).toBeUndefined();
  });

  it('ignores a malformed or empty route segment', () => {
    expect(decodeMapHash('#map=10/59.91/10.75&route=car')?.route).toBeUndefined();
    expect(decodeMapHash('#map=10/59.91/10.75&route=car/abc,def')?.route).toBeUndefined();
    expect(decodeMapHash('#map=10/59.91/10.75')?.route).toBeUndefined();
  });

  it('omits a plan with no stops or an unusable profile', () => {
    const view = { center: { lat: 1, lng: 2 }, zoom: 5 };
    expect(encodeMapHash({ ...view, route: { profile: 'car', points: [] } })).toBe('#map=5/1/2');
    expect(
      encodeMapHash({ ...view, route: { profile: 'car&pin=9/9', points: [{ lat: 3, lng: 4 }] } }),
    ).toBe('#map=5/1/2');
  });
});

describe('decodeMapLink', () => {
  const state = { center: { lat: 59.91, lng: 10.75 }, zoom: 13, pin: { lat: 59.9, lng: 10.7 } };
  const hash = encodeMapHash(state);

  it('parses web share links and scheme deep links alike', () => {
    expect(decodeMapLink(`https://atlas.example/${hash}`)).toEqual(state);
    expect(decodeMapLink(`atlas://${hash.slice(1)}`)).toEqual(state);
    expect(decodeMapLink(`atlas:${hash}`)).toEqual(state);
  });

  it('rejects URLs without a map fragment', () => {
    expect(decodeMapLink('https://atlas.example/')).toBeNull();
    expect(decodeMapLink('atlas://remap=1/2/3')).toBeNull();
  });
});
