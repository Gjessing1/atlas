import { describe, expect, it } from 'vitest';
import { parseExportedData } from './records.js';

/**
 * The import path reads a file the user picked, so every one of these inputs is
 * something a real user can hand us by mistake. None may throw.
 */
describe('parseExportedData', () => {
  const dump = {
    exportedAt: 1_700_000_000_000,
    collections: [{ id: 'c1', name: 'Trips' }],
    places: [{ id: 'p1', name: 'P', lat: 1, lng: 2 }],
    tracks: [{ id: 't1', name: 'T', gpx: '<gpx/>' }],
    settings: { units: 'metric' },
  };

  it('accepts a well-formed dump', () => {
    const parsed = parseExportedData(dump);
    expect(parsed?.collections).toHaveLength(1);
    expect(parsed?.places).toHaveLength(1);
    expect(parsed?.tracks).toHaveLength(1);
    expect(parsed?.settings).toEqual({ units: 'metric' });
    expect(parsed?.exportedAt).toBe(1_700_000_000_000);
  });

  it('rejects things that are not an export at all', () => {
    expect(parseExportedData(null)).toBeNull();
    expect(parseExportedData('a string')).toBeNull();
    expect(parseExportedData(42)).toBeNull();
    expect(parseExportedData([])).toBeNull();
    expect(parseExportedData({})).toBeNull();
    // A GPX-shaped or unrelated JSON file: no record arrays.
    expect(parseExportedData({ type: 'FeatureCollection', features: [] })).toBeNull();
    // Present but wrong type.
    expect(parseExportedData({ ...dump, places: 'nope' })).toBeNull();
  });

  it('keeps the good records and drops only the unusable ones', () => {
    const parsed = parseExportedData({
      ...dump,
      collections: [{ id: 'c1', name: 'Trips' }, { name: 'no id' }, null, 'x'],
      places: [
        { id: 'p1', name: 'Good', lat: 1, lng: 2 },
        { id: 'p2', name: 'No position' },
        { id: 'p3', name: 'NaN', lat: Number.NaN, lng: 2 },
        { id: 'p4', name: 'String coords', lat: '1', lng: '2' },
        { id: '', name: 'Empty id', lat: 1, lng: 2 },
      ],
      tracks: [
        { id: 't1', name: 'Good', gpx: '<gpx/>' },
        { id: 't2', name: 'No document' },
      ],
    });
    expect(parsed?.collections.map((c) => c.id)).toEqual(['c1']);
    expect(parsed?.places.map((p) => p.id)).toEqual(['p1']);
    expect(parsed?.tracks.map((t) => t.id)).toEqual(['t1']);
  });

  it('tolerates missing or malformed settings and exportedAt', () => {
    const parsed = parseExportedData({
      collections: [],
      places: [],
      tracks: [],
      settings: { good: 'v', dropped: 42, alsoDropped: { nested: true } },
    });
    expect(parsed?.settings).toEqual({ good: 'v' });
    expect(parsed?.exportedAt).toBeGreaterThan(0);

    expect(parseExportedData({ collections: [], places: [], tracks: [] })?.settings).toEqual({});
  });
});
