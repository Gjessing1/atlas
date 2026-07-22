import { describe, expect, it } from 'vitest';
import type { ArcGisLabelSource } from './catalog.js';
import { parseBbox, toLabelFeatures } from './labels.js';

const source: ArcGisLabelSource = {
  url: 'https://upstream.example/arcgis/4/query',
  valueField: 'maksdyp_m',
  nameField: 'innsjonavn',
  unit: 'm',
  minzoom: 10,
  simplifyDeg: 0.0005,
};

/** A square ring around 10.0–10.2 E, 59.0–59.2 N. */
const rings = [
  [
    [10.0, 59.0],
    [10.2, 59.0],
    [10.2, 59.2],
    [10.0, 59.2],
    [10.0, 59.0],
  ],
];

describe('parseBbox', () => {
  it('accepts a well-formed west,south,east,north box', () => {
    expect(parseBbox('10.0,59.0,10.3,59.3')).toEqual([10, 59, 10.3, 59.3]);
  });

  it('rejects nonsense, inverted, polar and oversized boxes', () => {
    expect(parseBbox(undefined)).toBeNull();
    expect(parseBbox('nope')).toBeNull();
    expect(parseBbox('10,59,10.3')).toBeNull();
    expect(parseBbox('10.3,59,10,59.3')).toBeNull(); // east ≤ west
    expect(parseBbox('10,59.3,10.3,59')).toBeNull(); // north ≤ south
    expect(parseBbox('10,-88,10.3,59')).toBeNull(); // outside mercator
    // A viewport this wide would ask the upstream for every lake in Norway.
    expect(parseBbox('0,0,30,10')).toBeNull();
    expect(parseBbox('0,0,10,30')).toBeNull();
  });
});

describe('toLabelFeatures', () => {
  it('places a labelled point inside the polygon', () => {
    const [feature, ...rest] = toLabelFeatures(
      {
        features: [
          { attributes: { maksdyp_m: 21.5, innsjonavn: ' Verkensvannet ' }, geometry: { rings } },
        ],
      },
      source,
    );
    expect(rest).toHaveLength(0);
    expect(feature!.properties).toEqual({ label: '21.5 m', value: 21.5, name: 'Verkensvannet' });
    const [lng, lat] = feature!.geometry.coordinates;
    expect(lng).toBeGreaterThan(10);
    expect(lng).toBeLessThan(10.2);
    expect(lat).toBeGreaterThan(59);
    expect(lat).toBeLessThan(59.2);
  });

  it('drops lakes with no usable depth', () => {
    const features = toLabelFeatures(
      {
        features: [
          { attributes: { maksdyp_m: -1 }, geometry: { rings } }, // "not measured"
          { attributes: { maksdyp_m: 0 }, geometry: { rings } },
          { attributes: { maksdyp_m: null }, geometry: { rings } },
          { attributes: { maksdyp_m: 'deep' }, geometry: { rings } },
          { attributes: {}, geometry: { rings } },
          { attributes: { maksdyp_m: 12 }, geometry: { rings: [] } }, // no geometry
          { attributes: { maksdyp_m: 12 } },
        ],
      },
      source,
    );
    expect(features).toEqual([]);
  });

  it('reads a numeric string and rounds the label to one decimal', () => {
    const [feature] = toLabelFeatures(
      { features: [{ attributes: { maksdyp_m: '30.04' }, geometry: { rings } }] },
      source,
    );
    // "30" not "30.0" — a depth reads as a number, not a fixed-point field.
    expect(feature!.properties.label).toBe('30 m');
    expect(feature!.properties.value).toBe(30.04);
  });

  it('omits the name when the layer has none or it is blank', () => {
    const [unnamed] = toLabelFeatures(
      { features: [{ attributes: { maksdyp_m: 12, innsjonavn: '  ' }, geometry: { rings } }] },
      source,
    );
    expect(unnamed!.properties).toEqual({ label: '12 m', value: 12 });

    const [nameless] = toLabelFeatures(
      { features: [{ attributes: { maksdyp_m: 12 }, geometry: { rings } }] },
      { ...source, nameField: undefined },
    );
    expect(nameless!.properties).toEqual({ label: '12 m', value: 12 });
  });

  it('answers empty for an empty or errored upstream body', () => {
    expect(toLabelFeatures({}, source)).toEqual([]);
    expect(toLabelFeatures({ error: { message: 'boom' } }, source)).toEqual([]);
  });
});
