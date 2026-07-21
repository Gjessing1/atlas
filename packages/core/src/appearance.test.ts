import { describe, expect, it } from 'vitest';
import { applyMapAppearance, isThemeMode } from './appearance.js';

const style = JSON.stringify({
  version: 8,
  sources: {},
  layers: [
    { id: 'background', type: 'background', paint: { 'background-color': '#fff' } },
    { id: 'water', type: 'fill', paint: { 'fill-color': '#00f' } },
    {
      id: 'road_path_pedestrian',
      type: 'line',
      minzoom: 14,
      paint: {
        'line-color': '#fff',
        'line-width': ['interpolate', ['linear'], ['zoom'], 14, 1, 20, 8],
      },
    },
    {
      id: 'road_service_track',
      type: 'line',
      paint: { 'line-color': '#fff', 'line-width': 2 },
    },
    {
      id: 'road_secondary_tertiary',
      type: 'line',
      paint: {
        'line-color': '#fea',
        'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.5, 20, 13],
      },
    },
    { id: 'label_city', type: 'symbol', paint: { 'text-color': '#000' } },
  ],
});

function layers(result: string) {
  return (
    JSON.parse(result) as {
      layers: Array<{ id: string; minzoom?: number; paint: Record<string, unknown> }>;
    }
  ).layers;
}

describe('map appearance', () => {
  it('adds restrained high-contrast path and track rendering', () => {
    const result = layers(applyMapAppearance(style, { colorScheme: 'light', profile: 'explore' }));
    expect(result.find((layer) => layer.id === 'background')?.paint['background-color']).toBe(
      '#f5f3ee',
    );
    expect(
      result.find((layer) => layer.id === 'road_path_pedestrian')?.paint['line-color'],
    ).toEqual(['match', ['get', 'class'], 'path', '#a94f4b', '#b67870']);
    expect(result.find((layer) => layer.id === 'road_service_track')?.paint['line-color']).toEqual([
      'match',
      ['get', 'class'],
      'track',
      '#815f37',
      '#f9f7f2',
    ]);
    expect(
      result.find((layer) => layer.id === 'atlas-road_service_track-track-contrast')?.paint[
        'line-dasharray'
      ],
    ).toEqual([2.4, 1.4]);
  });

  it('uses a dark basemap and lets Hike reveal and emphasize paths earlier', () => {
    const result = layers(applyMapAppearance(style, { colorScheme: 'dark', profile: 'hike' }));
    expect(result.find((layer) => layer.id === 'background')?.paint['background-color']).toBe(
      '#1d2427',
    );
    expect(result.find((layer) => layer.id === 'water')?.paint['fill-color']).toBe('#1d4358');
    expect(result.find((layer) => layer.id === 'road_path_pedestrian')?.minzoom).toBe(12);
    expect(
      result.find((layer) => layer.id === 'road_path_pedestrian')?.paint['line-width'],
    ).toEqual(['interpolate', ['linear'], ['zoom'], 14, 1.22, 20, 9.76]);
    expect(result.find((layer) => layer.id === 'road_service_track')?.paint['line-width']).toBe(
      2.24,
    );
    expect(result.find((layer) => layer.id === 'label_city')?.paint['text-color']).toBe('#eef2f5');
  });

  it('widens driving roads without wrapping native-incompatible width expressions', () => {
    const result = layers(applyMapAppearance(style, { colorScheme: 'light', profile: 'drive' }));
    expect(
      result.find((layer) => layer.id === 'road_secondary_tertiary')?.paint['line-width'],
    ).toEqual(['interpolate', ['linear'], ['zoom'], 8, 0.56, 20, 14.560000000000002]);
  });
});

describe('theme mode', () => {
  it('accepts only the three persisted values', () => {
    expect(isThemeMode('system')).toBe(true);
    expect(isThemeMode('light')).toBe(true);
    expect(isThemeMode('dark')).toBe(true);
    expect(isThemeMode('night')).toBe(false);
  });
});
