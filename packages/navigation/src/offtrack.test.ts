import { describe, expect, it } from 'vitest';

import { remainingAscentM } from './elevation.js';
import { backToTrack, cardinalFromDeg } from './offtrack.js';

/** A straight northward track at lng 10, lat 60.00 → 60.01 (~1.1 km). */
const track = Array.from({ length: 11 }, (_, i) => ({ lat: 60 + i * 0.001, lng: 10 }));

describe('backToTrack', () => {
  it('points from the lost walker straight at the nearest track point', () => {
    // ~111 m east of the track's midpoint: the way back is due west.
    const result = backToTrack(track, { lat: 60.005, lng: 10.002 });
    expect(result).not.toBeNull();
    expect(result!.distanceM).toBeGreaterThan(90);
    expect(result!.distanceM).toBeLessThan(130);
    expect(result!.cardinal).toBe('W');
    expect(result!.point.lat).toBeCloseTo(60.005, 4);
  });

  it('returns null on the line and for degenerate routes', () => {
    expect(backToTrack(track, { lat: 60.005, lng: 10 })).toBeNull();
    expect(backToTrack([track[0]!], { lat: 60.005, lng: 10.002 })).toBeNull();
  });
});

describe('cardinalFromDeg', () => {
  it('maps bearings to the eight winds with wraparound', () => {
    expect(cardinalFromDeg(0)).toBe('N');
    expect(cardinalFromDeg(44)).toBe('NE');
    expect(cardinalFromDeg(225)).toBe('SW');
    expect(cardinalFromDeg(350)).toBe('N');
    expect(cardinalFromDeg(-45)).toBe('NW');
  });
});

describe('remainingAscentM', () => {
  const climb = track.map((p, i) => ({
    ...p,
    ele: [100, 100, 110, 120, 115, 115, 130, 150, 150, 145, 160][i]!,
  }));

  it('sums the climbs still ahead, ignoring what is already banked', () => {
    // Whole route: 10+10+15+20+15 = 70 m of ascent (2 m hysteresis).
    expect(remainingAscentM(climb, 0)).toBe(70);
    // Past the first two climbs (~450 m in): only the later ones remain.
    expect(remainingAscentM(climb, 450)).toBe(50);
    // At the end nothing remains.
    expect(remainingAscentM(climb, 10_000)).toBe(0);
  });

  it('is null without elevation data (offline packs have no DEM)', () => {
    expect(remainingAscentM(track, 0)).toBeNull();
    expect(remainingAscentM([], 0)).toBeNull();
  });
});
