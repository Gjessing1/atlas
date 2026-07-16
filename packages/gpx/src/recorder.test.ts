import { describe, expect, it } from 'vitest';
import { computeTrackStats, TrackRecorder } from './index.js';
import type { RecordFix } from './index.js';

/** ~0.0009 deg latitude ≈ 100 m, handy for building spaced-out fixes. */
const LAT0 = 59.9;
const LNG0 = 10.7;

/** A fix `metersNorth` north of the origin at time `t` (seconds from 0). */
function fixAt(metersNorth: number, tSec: number, ele?: number): RecordFix {
  const fix: RecordFix = {
    lat: LAT0 + metersNorth / 111_320,
    lng: LNG0,
    time: tSec * 1000,
  };
  if (ele !== undefined) fix.ele = ele;
  return fix;
}

describe('TrackRecorder', () => {
  it('is idle until started and rejects fixes when not recording', () => {
    const r = new TrackRecorder();
    expect(r.getStatus()).toBe('idle');
    expect(r.addFix(fixAt(0, 0))).toBe(false);
    expect(r.snapshot().points).toBe(0);
  });

  it('accumulates distance and elapsed time across accepted fixes', () => {
    const r = new TrackRecorder();
    r.start();
    expect(r.addFix(fixAt(0, 0))).toBe(true);
    expect(r.addFix(fixAt(100, 10))).toBe(true);
    expect(r.addFix(fixAt(200, 20))).toBe(true);
    const s = r.stats();
    expect(s.points).toBe(3);
    expect(s.distanceM).toBeCloseTo(200, 0);
    expect(s.elapsedMs).toBe(20_000);
    expect(s.avgSpeedMps).toBeCloseTo(10, 1);
  });

  it('drops fixes with poor accuracy or below the minimum spacing', () => {
    const r = new TrackRecorder({ maxAccuracyM: 20, minDistanceM: 5 });
    r.start();
    expect(r.addFix({ ...fixAt(0, 0), accuracyM: 8 })).toBe(true);
    // Too inaccurate:
    expect(r.addFix({ ...fixAt(100, 5), accuracyM: 50 })).toBe(false);
    // Within 5 m of the last kept point (jitter):
    expect(r.addFix(fixAt(2, 6))).toBe(false);
    expect(r.snapshot().points).toBe(1);
  });

  it('excludes stationary time from moving time', () => {
    const r = new TrackRecorder({ movingSpeedThresholdMps: 0.5 });
    r.start();
    r.addFix(fixAt(0, 0));
    r.addFix(fixAt(100, 10)); // 10 m/s — moving, +10 s
    // Long stationary gap: 100 m over 1000 s = 0.1 m/s < threshold.
    r.addFix(fixAt(200, 1010));
    const s = r.stats();
    expect(s.elapsedMs).toBe(1_010_000);
    expect(s.movingMs).toBe(10_000);
    expect(s.movingSpeedMps).toBeCloseTo(200 / 10, 1);
  });

  it('opens a new segment on resume so pauses are not bridged', () => {
    const r = new TrackRecorder();
    r.start();
    r.addFix(fixAt(0, 0));
    r.addFix(fixAt(100, 10));
    r.pause();
    // Fixes during a pause are ignored.
    expect(r.addFix(fixAt(150, 15))).toBe(false);
    r.resume();
    r.addFix(fixAt(1000, 100));
    r.addFix(fixAt(1100, 110));
    const data = r.toTrackData();
    expect(data.segments).toHaveLength(2);
    expect(data.segments[0]).toHaveLength(2);
    expect(data.segments[1]).toHaveLength(2);
    // The 800 m pause gap must NOT be counted as travelled distance.
    expect(r.stats().distanceM).toBeCloseTo(200, 0);
  });

  it('matches computeTrackStats on the TrackStats subset', () => {
    const r = new TrackRecorder({ minDistanceM: 0, maxAccuracyM: 1000 });
    r.start();
    const fixes = [
      fixAt(0, 0, 100),
      fixAt(100, 10, 101), // +1 m ele: below hysteresis, no ascent
      fixAt(200, 20, 108), // now +8 from anchor 100 → +8 ascent
      fixAt(300, 30, 104), // -4 from anchor 108 → +4 descent
    ];
    for (const f of fixes) r.addFix(f);
    r.pause();
    r.resume();
    r.addFix(fixAt(1000, 100, 120));
    r.addFix(fixAt(1100, 110, 90));
    r.stop();

    const live = r.stats();
    const computed = computeTrackStats(r.toTrackData());
    expect(live.points).toBe(computed.points);
    expect(live.distanceM).toBeCloseTo(computed.distanceM, 5);
    expect(live.ascentM).toBeCloseTo(computed.ascentM, 5);
    expect(live.descentM).toBeCloseTo(computed.descentM, 5);
    expect(live.minEleM).toBe(computed.minEleM);
    expect(live.maxEleM).toBe(computed.maxEleM);
    expect(live.startTime).toBe(computed.startTime);
    expect(live.endTime).toBe(computed.endTime);
    expect(live.durationMs).toBe(computed.durationMs);
  });

  it('produces GPX-ready TrackData with the given name', () => {
    const r = new TrackRecorder();
    r.start();
    r.addFix(fixAt(0, 0, 12));
    r.addFix(fixAt(100, 10, 15));
    r.stop();
    const data = r.toTrackData({ name: 'Evening walk' });
    expect(data.name).toBe('Evening walk');
    expect(data.segments[0]![0]).toMatchObject({ lat: LAT0, lng: LNG0, ele: 12 });
    expect(data.segments[0]![0]!.time).toBe(0);
  });
});
