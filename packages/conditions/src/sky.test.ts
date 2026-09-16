import { describe, expect, it } from 'vitest';

import { fmtClock } from '@atlas/core';

import {
  auroraCloudFactor,
  auroraDarknessFactor,
  auroraLightFactor,
  lightningAgeBand,
  lightningAgeExpression,
  lightningBandExpression,
  lightningFlashFilter,
  lightningHasFlash,
  lightningIdentify,
  lightningLegendBands,
  lightningPulse,
  lightningWindow,
  paintAuroraTile,
  parseOvation,
  parseUalf,
} from './sky.js';

const NOW = Date.parse('2026-09-16T12:30:00Z');

describe('Frost UALF lightning', () => {
  it('turns valid version-0 rows into age-banded strike features, newest last', () => {
    const data = parseUalf(
      [
        '0 2026 09 16 11 50 00 0 61 11 24 0 3 3 0 0 0 0 0 0 0 1 1 0 1',
        '0 2026 09 16 12 25 00 123000000 60.1234 10.5678 -18 0 3 3 175.59 1.62 0.21 0.02 0 0 0 1 1 0 1',
        '0 2026 09 16 12 29 30 0 60 10 7 0 3 3 0 0 0 0 0 0 0 1 1 0 1',
        'bad row',
      ].join('\n'),
      NOW,
    );
    expect(data.features).toHaveLength(3);
    expect(data.features[1]).toMatchObject({
      geometry: { coordinates: [10.5678, 60.1234] },
      properties: {
        observedMs: Date.parse('2026-09-16T12:25:00.123Z'),
        ageMinutes: 5,
        age: 'fresh',
        markerColor: '#d61fd0',
        peakCurrentKa: -18,
        polarity: 'negative',
      },
    });
    expect(data.features[0]!.properties).toMatchObject({ age: 'recent', polarity: 'positive' });
    expect(data.features[2]!.properties.age).toBe('flash');
  });

  it('validates the selectable windows and keeps older strikes only when requested', () => {
    const old = '0 2026 09 15 13 00 00 0 61 11 24 0 3 3 0 0 0 0 0 0 0 1 1 0 1';
    expect(parseUalf(old, NOW, 10_000, lightningWindow('1h').minutes).features).toHaveLength(0);
    expect(
      parseUalf(old, NOW, 10_000, lightningWindow('24h').minutes).features[0]!.properties,
    ).toMatchObject({ age: 'oldest', markerColor: '#9e9e9e' });
    expect(lightningWindow('bogus').id).toBe('1h');
    expect(lightningLegendBands('1h').map((band) => band.age)).toEqual([
      'flash',
      'fresh',
      'recent',
    ]);
    expect(lightningLegendBands('12h').map((band) => band.age)).toHaveLength(5);
  });

  it('keeps the newest strikes when a storm exceeds the response guard', () => {
    const rows = [5, 1, 3].map((minutesAgo) => {
      const t = new Date(NOW - minutesAgo * 60_000);
      return `0 ${t.getUTCFullYear()} ${t.getUTCMonth() + 1} ${t.getUTCDate()} ${t.getUTCHours()} ${t.getUTCMinutes()} 0 0 60 10 5 0 3 3 0 0 0 0 0 0 0 1 1 0 1`;
    });
    const kept = parseUalf(rows.join('\n'), NOW, 2).features.map((f) => f.properties.ageMinutes);
    expect(kept).toEqual([3, 1]);
  });

  it('bands strikes by age: a pulse, then magenta, violet, grey and a faint grey', () => {
    const minute = 60_000;
    expect(
      [0.5, 5, 30, 3 * 60, 20 * 60, 30 * 60].map((m) => lightningAgeBand(m * minute).age),
    ).toEqual(['flash', 'fresh', 'recent', 'older', 'oldest', 'oldest']);
    const faint = lightningAgeBand(20 * 60 * minute);
    expect(faint.radius).toBeLessThan(lightningAgeBand(3 * 60 * minute).radius);
    expect(faint.opacity).toBeLessThan(0.5);
    // Measured from the reader's clock; an older server's answer-time age stands in without it.
    expect(lightningAgeExpression(NOW)).toEqual([
      '-',
      NOW,
      [
        'to-number',
        [
          'coalesce',
          ['get', 'observedMs'],
          ['-', NOW, ['*', ['to-number', ['coalesce', ['get', 'ageMinutes'], 1440]], minute]],
        ],
      ],
    ]);
    // The expression is a MapLibre step over the same bands.
    expect(lightningBandExpression(NOW, (band) => band.color)).toEqual([
      'step',
      lightningAgeExpression(NOW),
      '#ff7a00',
      minute,
      '#d61fd0',
      15 * minute,
      '#4a1a8c',
      60 * minute,
      '#8c8c8c',
      6 * 60 * minute,
      '#9e9e9e',
    ]);
    expect(lightningFlashFilter(NOW)).toEqual(['<', lightningAgeExpression(NOW), minute]);
  });

  it('animates only while a strike is under a minute old, with a ring that expands and fades', () => {
    const strike = (ageMs: number) => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [10, 60] as [number, number] },
      properties: {
        observedAt: new Date(NOW - ageMs).toISOString(),
        observedMs: NOW - ageMs,
        ageMinutes: 0,
        age: 'flash' as const,
        markerColor: '#ff7a00',
        peakCurrentKa: 5,
        polarity: 'positive' as const,
      },
    });
    const collection = (ageMs: number) => ({
      type: 'FeatureCollection' as const,
      features: [strike(ageMs)],
    });
    expect(lightningHasFlash(collection(20_000), NOW)).toBe(true);
    expect(lightningHasFlash(collection(61_000), NOW)).toBe(false);
    expect(lightningHasFlash(null, NOW)).toBe(false);
    const start = lightningPulse(0);
    const late = lightningPulse(0.9);
    expect(late.ringRadius).toBeGreaterThan(start.ringRadius);
    expect(late.ringOpacity).toBeLessThan(start.ringOpacity);
    expect(lightningPulse(1.25)).toEqual(lightningPulse(0.25));
  });

  it('describes a tapped strike on the reader clock, aged from now', () => {
    const observed = Date.parse('2026-09-16T10:18:00.000Z');
    expect(
      lightningIdentify(
        {
          observedAt: new Date(observed).toISOString(),
          ageMinutes: 5,
          peakCurrentKa: -18,
          polarity: 'negative',
        },
        NOW,
      ),
    ).toEqual({
      title: 'Lightning strike',
      properties: {
        Observed: `Today ${fmtClock(observed)}`,
        // The stale server-side ageMinutes is ignored.
        Age: '2 h 12 min',
        'Peak current': '18 kA',
        Polarity: 'negative',
      },
    });
    expect(lightningIdentify({ observedAt: 'bad' })).toBeNull();
  });
});

describe('NOAA OVATION aurora grid', () => {
  const payload = (probability: (lng: number, lat: number) => number) => ({
    'Observation Time': '2026-09-16T12:00:00Z',
    'Forecast Time': '2026-09-16T12:45:00Z',
    'Data Format': '[Longitude, Latitude, Aurora]',
    coordinates: Array.from({ length: 360 * 181 }, (_, index) => {
      const lng = Math.floor(index / 181);
      const lat = (index % 181) - 90;
      return [lng, lat, probability(lng, lat)];
    }),
  });

  it('validates the complete one-degree grid and paints probability transparently', () => {
    const grid = parseOvation(payload((_lng, lat) => (lat > 55 ? 80 : 0)));
    expect(grid?.forecastTime).toBe('2026-09-16T12:45:00Z');
    const rgba = paintAuroraTile(grid!, 0, 0, 0);
    // The northern model band remains visible, but September daylight reduces
    // its viewing chance; the equator has no model signal at all.
    expect(rgba[(32 * 256 + 128) * 4 + 3]).toBeGreaterThan(10);
    expect(rgba[(128 * 256 + 128) * 4 + 3]).toBe(0);
  });

  it('rejects incomplete upstream data instead of drawing a misleading blank globe', () => {
    expect(
      parseOvation({
        'Observation Time': '2026-09-16T12:00:00Z',
        'Forecast Time': '2026-09-16T12:45:00Z',
        coordinates: [[0, 60, 20]],
      }),
    ).toBeNull();
  });

  it('reduces viewing chance for daylight, low cloud and artificial light', () => {
    expect(auroraDarknessFactor(new Date('2026-06-21T12:00:00Z'), 60, 10)).toBe(0.05);
    expect(auroraDarknessFactor(new Date('2026-12-21T23:00:00Z'), 60, 10)).toBe(1);
    expect(auroraCloudFactor({ low: 100, medium: 0, high: 0, total: 100 })).toBeLessThan(
      auroraCloudFactor({ low: 0, medium: 0, high: 100, total: 100 }),
    );
    expect(auroraLightFactor(255, 255, 255)).toBeLessThan(auroraLightFactor(0, 0, 0));

    const grid = parseOvation(payload((_lng, lat) => (lat > 55 ? 80 : 0)))!;
    const raster = (rgba: [number, number, number, number]) => {
      const data = new Uint8Array(256 * 256 * 4);
      for (let i = 0; i < data.length; i += 4) data.set(rgba, i);
      return { width: 256, height: 256, data };
    };
    const normal = paintAuroraTile(grid, 0, 0, 0);
    // One raster, as the backend's decoded-tile cache hands out: the painter
    // asks the mosaic for its tile once per pixel.
    const overcast = raster([200, 200, 200, 255]);
    const poor = paintAuroraTile(grid, 0, 0, 0, {
      clouds: { z: 0, tile: () => overcast },
      lightPollution: raster([255, 255, 255, 255]),
    });
    const alpha = (tile: Uint8Array) => tile[(32 * 256 + 128) * 4 + 3]!;
    expect(alpha(poor)).toBeLessThan(alpha(normal));
  });
});
