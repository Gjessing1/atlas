import { describe, expect, it } from 'vitest';

import { lightningIdentify, paintAuroraTile, parseOvation, parseUalf } from './sky.js';

const NOW = Date.parse('2026-09-16T12:30:00Z');

describe('Frost UALF lightning', () => {
  it('turns valid version-0 rows into age-coloured strike features', () => {
    const data = parseUalf(
      [
        '0 2026 09 16 12 25 00 123000000 60.1234 10.5678 -18 0 3 3 175.59 1.62 0.21 0.02 0 0 0 1 1 0 1',
        '0 2026 09 16 11 50 00 0 61 11 24 0 3 3 0 0 0 0 0 0 0 1 1 0 1',
        'bad row',
      ].join('\n'),
      NOW,
    );
    expect(data.features).toHaveLength(2);
    expect(data.features[0]).toMatchObject({
      geometry: { coordinates: [10.5678, 60.1234] },
      properties: {
        ageMinutes: 5,
        age: 'fresh',
        markerColor: '#fff3a3',
        peakCurrentKa: -18,
        polarity: 'negative',
      },
    });
    expect(data.features[1]!.properties).toMatchObject({ age: 'recent', polarity: 'positive' });
  });

  it('describes a tapped strike without trusting malformed properties', () => {
    expect(
      lightningIdentify({
        observedAt: '2026-09-16T12:25:00.000Z',
        ageMinutes: 5,
        peakCurrentKa: -18,
        polarity: 'negative',
      }),
    ).toEqual({
      title: 'Lightning strike',
      properties: {
        Observed: '2026-09-16 12:25 UTC',
        Age: '5 min',
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
    // Northern high latitude is bright; the equator is transparent.
    expect(rgba[(32 * 256 + 128) * 4 + 3]).toBeGreaterThan(100);
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
});
