import { describe, expect, it } from 'vitest';
import {
  closestFrameIndex,
  decodeClouds,
  decodePrecipitationLevel,
  decodeSeaTemperature,
  decodeTemperature,
  decodeWind,
  legendRowSwatches,
  normalizeMetAlerts,
  nowFrameIndex,
  paintWeatherTile,
  precipitationText,
  RAIN_COLORS,
  rampRgb,
  sampleScalarGrid,
  sampleWindGrid,
  SNOW_COLORS,
  TEMPERATURE_RAMP,
  timelineDayMarks,
  weatherFrameCaption,
  tilePixelAt,
  weatherGridLabels,
  weatherGridZoom,
  weatherValueAt,
  weatherValueLabels,
  weatherMapLegend,
  weatherPointIdentify,
  weatherTileFootprint,
  weatherWarningIdentify,
  WIND_RAMP,
  windFromDeg,
  windSpeed,
  type WeatherGridResponse,
  type WeatherMosaic,
  type WeatherMapFrame,
  type WeatherWarningProperties,
} from './index.js';

const NOW = Date.parse('2026-09-16T17:30:00Z');

function frame(time: string, kind: WeatherMapFrame['kind']): WeatherMapFrame {
  return { id: `${kind}-${time}`, time, kind, tilePath: `/t/${time}/{z}/{x}/{y}.png` };
}

describe('decoding MET map pixels', () => {
  // Pixels sampled on 2026-09-16 beside MET's point forecast for the same hour.
  it('reads air temperature from the red channel', () => {
    expect(decodeTemperature(157)).toBe(29); // Cairo, forecast 29.7 °C
    expect(decodeTemperature(131)).toBe(3); // Longyearbyen, forecast 4.1 °C
    expect(decodeTemperature(143)).toBe(15); // Oslo, forecast 15.5 °C
  });

  it('reads sea temperature in quarter degrees and treats alpha 0 as no water', () => {
    expect(decodeSeaTemperature(76, 255)).toBeCloseTo(16.5, 5); // Oslofjord, forecast 16.4 °C
    expect(decodeSeaTemperature(36, 255)).toBeCloseTo(6.5, 5); // off Svalbard, forecast 6.6 °C
    expect(decodeSeaTemperature(81, 0)).toBeNull();
  });

  it('reads 16-bit wind components on a ±75 m/s scale', () => {
    // Lofoten: forecast 8.5 m/s from 354°.
    const lofoten = decodeWind(33086, 28370);
    expect(windSpeed(lofoten)).toBeCloseTo(10.1, 1);
    expect(windFromDeg(lofoten)).toBeGreaterThan(350);
    // Longyearbyen: forecast 8.1 m/s from 146°.
    const svalbard = decodeWind(30224, 35876);
    expect(windFromDeg(svalbard)).toBeGreaterThan(135);
    expect(windFromDeg(svalbard)).toBeLessThan(145);
    expect(windSpeed(decodeWind(32768, 32768))).toBe(0);
  });

  it('names the direction the wind comes from', () => {
    expect(windFromDeg({ u: 0, v: -5 })).toBeCloseTo(0, 5); // blowing south = from north
    expect(windFromDeg({ u: -5, v: 0 })).toBeCloseTo(90, 5); // blowing west = from east
    expect(windFromDeg({ u: 5, v: 0 })).toBeCloseTo(270, 5);
  });

  it('reads cloud decks and combines them with random overlap', () => {
    const madrid = decodeClouds(19, 10, 3); // forecast 11.7 / 4.7 / 1.6 → 15.6 % total
    expect(madrid.low).toBe(9.5);
    expect(madrid.total).toBeGreaterThan(14);
    expect(madrid.total).toBeLessThan(18);
    expect(decodeClouds(200, 200, 200).total).toBe(100);
    expect(decodeClouds(0, 0, 0).total).toBe(0);
  });

  it('maps the precipitation palette to ordered levels, with no-data and dry apart', () => {
    expect(decodePrecipitationLevel(0, 0, 0)).toBe(0);
    expect(decodePrecipitationLevel(255, 255, 255)).toBeNull();
    expect(decodePrecipitationLevel(0, 0, 0, 0)).toBeNull();
    expect(decodePrecipitationLevel(145, 228, 255)).toBe(1);
    expect(decodePrecipitationLevel(94, 215, 255)).toBe(2);
    expect(decodePrecipitationLevel(0, 170, 255)).toBe(3);
    expect(decodePrecipitationLevel(0, 128, 255)).toBe(4);
    expect(decodePrecipitationLevel(0, 85, 255)).toBe(5);
    expect(decodePrecipitationLevel(122, 0, 135)).toBe(6);
    // A resampled edge pixel still lands in a class rather than reading dry.
    expect(decodePrecipitationLevel(4, 166, 252)).toBe(3);
  });
});

/** A 256 px tile of one raw pixel value. */
function uniform(rgba: number[]) {
  const data = new Array<number>(256 * 256 * 4);
  for (let i = 0; i < data.length; i += 4) data.splice(i, 4, ...rgba);
  return { width: 256, height: 256, data };
}

/** A tile split at a column: `left` before it, `right` from it on. */
function halves(left: number[], right: number[], split = 128) {
  const data = new Array<number>(256 * 256 * 4);
  for (let y = 0; y < 256; y++) {
    for (let x = 0; x < 256; x++) data.splice((y * 256 + x) * 4, 4, ...(x < split ? left : right));
  }
  return { width: 256, height: 256, data };
}

/** A one-tile world at z0. */
const world = (tile: ReturnType<typeof uniform>): WeatherMosaic => ({
  z: 0,
  tile: (x, y) => (x === 0 && y === 0 ? tile : null),
});

const px = (out: Uint8Array, x: number, y = 128) =>
  Array.from(out.slice((y * 256 + x) * 4, (y * 256 + x) * 4 + 4));

describe('painting tiles', () => {
  it('colours temperature on the shared ramp', () => {
    const out = paintWeatherTile('temperature', world(uniform([140, 0, 0, 255])), 0, 0, 0);
    expect(px(out, 10)).toEqual([...rampRgb(TEMPERATURE_RAMP, 12), 255]);
  });

  it('interpolates values, not pixels, when painting deeper than the data', () => {
    // −4 °C beside +4 °C at source column 100. Tile (6, 6) at z4 spans source
    // columns 96–112, sixteen output pixels to one source pixel, seam at x ≈ 64.
    const mosaic = world(halves([124, 0, 0, 255], [132, 0, 0, 255], 100));
    const out = paintWeatherTile('temperature', mosaic, 4, 6, 6);
    // A gradient across the seam rather than one step: every sample different…
    const across = [16, 40, 56, 64, 72, 88, 112].map((x) => px(out, x).slice(0, 3).join());
    expect(new Set(across).size).toBe(across.length);
    // …settling on the data's values away from it, and about 0 °C on it.
    expect(temperatureAt(out, 0)).toBeCloseTo(-4, 0);
    expect(temperatureAt(out, 255)).toBeCloseTo(4, 0);
    expect(Math.abs(temperatureAt(out, 64))).toBeLessThan(1.5);
  });

  it('keeps the data’s own pixels at the data’s own zoom, smoothing only at a seam', () => {
    const mosaic = world(halves([124, 0, 0, 255], [132, 0, 0, 255], 100));
    const out = paintWeatherTile('temperature', mosaic, 0, 0, 0);
    expect(px(out, 95).slice(0, 3)).toEqual(rampRgb(TEMPERATURE_RAMP, -4));
    expect(px(out, 104).slice(0, 3)).toEqual(rampRgb(TEMPERATURE_RAMP, 4));
  });

  it('leaves dry and no-coverage precipitation transparent and fades a shower’s edge', () => {
    const dry = paintWeatherTile('precipitation', world(uniform([0, 0, 0, 255])), 0, 0, 0);
    expect(px(dry, 10)[3]).toBe(0);
    const outside = paintWeatherTile(
      'precipitation',
      world(uniform([255, 255, 255, 255])),
      0,
      0,
      0,
    );
    expect(px(outside, 10)[3]).toBe(0);
    const edge = paintWeatherTile(
      'precipitation',
      world(halves([0, 0, 0, 255], [0, 128, 255, 255], 100)),
      4,
      6,
      6,
    );
    const alphas = [0, 32, 40, 48, 96].map((x) => px(edge, x)[3]!);
    expect(alphas[0]).toBe(0);
    expect(alphas[4]).toBeGreaterThan(200);
    // Soft, not stepped: alpha climbs through values in between.
    expect(alphas.slice(1, 4).some((a) => a > 0 && a < 200)).toBe(true);
    for (let i = 1; i < alphas.length; i++)
      expect(alphas[i]).toBeGreaterThanOrEqual(alphas[i - 1]!);
  });

  it('draws precipitation as snow where the air is at or below +1 °C', () => {
    const rain = world(uniform([0, 128, 255, 255]));
    const warm = paintWeatherTile('precipitation', rain, 0, 0, 0, world(uniform([133, 0, 0, 255])));
    const cold = paintWeatherTile('precipitation', rain, 0, 0, 0, world(uniform([127, 0, 0, 255])));
    const hex = (out: Uint8Array) =>
      `#${px(out, 10)
        .slice(0, 3)
        .map((c) => c.toString(16).padStart(2, '0'))
        .join('')}`;
    expect(hex(warm)).toBe(RAIN_COLORS[3]);
    expect(hex(cold)).toBe(SNOW_COLORS[3]);
  });

  it('masks sea temperature where the ocean model has no water, softly at the coast', () => {
    const out = paintWeatherTile(
      'sea-temperature',
      world(halves([76, 0, 0, 0], [76, 0, 0, 255])),
      0,
      0,
      0,
    );
    expect(px(out, 10)[3]).toBe(0);
    expect(px(out, 200)[3]).toBe(255);
  });

  it('darkens clear sky and brightens cloud', () => {
    const clear = paintWeatherTile('clouds', world(uniform([0, 0, 0, 255])), 0, 0, 0);
    const overcast = paintWeatherTile('clouds', world(uniform([200, 200, 200, 255])), 0, 0, 0);
    expect(px(clear, 10)[0]).toBeLessThan(60);
    expect(px(overcast, 10)[0]).toBeGreaterThan(200);
    expect(px(overcast, 10)[3]).toBeGreaterThan(px(clear, 10)[3]!);
  });

  it('lists the source tiles a deeper tile reads, neighbours at its edge included', () => {
    // Deep inside one source tile: just that one.
    expect(weatherTileFootprint(8, 21, 21, 5)).toEqual([{ x: 2, y: 2 }]);
    // At a source tile's corner: the four around it.
    expect(weatherTileFootprint(8, 24, 24, 5)).toHaveLength(4);
    // The data's own zoom never needs a neighbour.
    expect(weatherTileFootprint(5, 3, 3, 5)).toEqual([{ x: 3, y: 3 }]);
    // Wraps across the antimeridian.
    expect(weatherTileFootprint(3, 0, 1, 1).map((t) => t.x)).toContain(1);
  });
});

/** The temperature a painted pixel's colour stands for, by searching the ramp. */
function temperatureAt(out: Uint8Array, x: number): number {
  const target = px(out, x).slice(0, 3);
  let best = 0;
  let bestDistance = Infinity;
  for (let t = -10; t <= 10; t += 0.01) {
    const c = rampRgb(TEMPERATURE_RAMP, t);
    const d = c.reduce((sum, v, i) => sum + (v - target[i]!) ** 2, 0);
    if (d < bestDistance) {
      bestDistance = d;
      best = t;
    }
  }
  return best;
}

describe('legend', () => {
  it('is built from the same ramp the tiles are painted with', () => {
    const legend = weatherMapLegend('wind');
    expect(legend.unit).toBe('m/s');
    const row = legend.rows[0]!;
    for (const stop of WIND_RAMP.filter((s) => s.value > 0 && s.value < 30)) {
      expect(row.stops.some((s) => s.color === stop.color)).toBe(true);
    }
    expect(row.ticks.map((t) => t.label)).toEqual(['0', '5', '10', '15', '20', '25']);
  });

  it('labels only the precipitation thresholds MET publishes, and shows snow separately', () => {
    const legend = weatherMapLegend('precipitation');
    expect(legend.rows.map((r) => r.label)).toEqual(['Rain', 'Snow']);
    expect(legend.rows[0]!.ticks.map((t) => t.label)).toEqual(['<0.2', '≈5', '>15']);
  });

  it('samples swatches for renderers without gradients', () => {
    const swatches = legendRowSwatches(weatherMapLegend('precipitation').rows[0]!, 6);
    expect(swatches).toEqual(RAIN_COLORS);
  });
});

describe('timeline', () => {
  const radar = [
    frame('2026-09-16T17:20:00Z', 'observation'),
    frame('2026-09-16T17:25:00Z', 'observation'),
    frame('2026-09-16T17:30:00Z', 'nowcast'),
    frame('2026-09-16T17:35:00Z', 'nowcast'),
  ];

  it('puts now on the newest radar observation', () => {
    expect(nowFrameIndex(radar, NOW)).toBe(1);
  });

  it('falls back to the nearest frame without observations', () => {
    const forecast = [
      frame('2026-09-16T17:00:00Z', 'forecast'),
      frame('2026-09-16T18:00:00Z', 'forecast'),
    ];
    expect(nowFrameIndex(forecast, NOW + 20 * 60_000)).toBe(1);
    expect(closestFrameIndex([], NOW)).toBe(0);
  });

  it('says how old a radar picture is', () => {
    expect(weatherFrameCaption(radar[0]!, NOW)).toBe('Radar · 10 min ago');
    expect(weatherFrameCaption(radar[3]!, NOW)).toBe('Nowcast · in 5 min');
    expect(weatherFrameCaption(frame('2026-09-17T12:00:00Z', 'forecast'), NOW)).toBe('Forecast');
    // A day of archived radar reads in hours, not "315 min ago".
    const hoursAgo = (m: number) => frame(new Date(NOW - m * 60_000).toISOString(), 'observation');
    expect(weatherFrameCaption(hoursAgo(315), NOW)).toBe('Radar · 5 h 15 min ago');
    expect(weatherFrameCaption(hoursAgo(20 * 60), NOW)).toBe('Radar · 20 h ago');
  });

  it('marks day boundaries along the track', () => {
    const frames = [0, 6, 12, 18, 24, 30].map((h) =>
      frame(new Date(Date.parse('2026-09-16T00:00:00') + h * 3_600_000).toISOString(), 'forecast'),
    );
    const marks = timelineDayMarks(frames, Date.parse('2026-09-16T10:00:00'));
    expect(marks).toHaveLength(1);
    expect(marks[0]!.label).toBe('Tomorrow');
    expect(marks[0]!.at).toBeCloseTo(4 / 5, 5);
  });
});

describe('point card', () => {
  const sample = {
    time: '2026-09-16T18:00:00Z',
    temperatureC: 12,
    wind: { speed: 6.2, fromDeg: 225 },
    precipitation: { level: 2, frozen: false, radar: true },
    cloudCoverPct: 80.4,
    seaTemperatureC: null,
  };

  it('leads with the layer the reader is looking at', () => {
    const group = weatherPointIdentify(sample, 'wind', NOW)!;
    expect(Object.keys(group.properties)[0]).toBe('Wind');
    expect(group.properties['Wind']).toBe('6 m/s from SW ↗');
    expect(group.properties['Radar']).toBe('Light rain');
    expect(group.properties['Cloud cover']).toBe('80 %');
    expect(group.properties['Sea']).toBeUndefined();
    expect(group.title.startsWith('Weather · ')).toBe(true);
  });

  it('words frozen and extreme precipitation with MET’s published thresholds', () => {
    expect(precipitationText(1, true)).toBe('Very light snow or sleet (under 0.2 mm/h)');
    expect(precipitationText(6, false)).toBe('Extreme rain (over 15 mm/h)');
    expect(precipitationText(0, false)).toBe('Dry');
  });

  it('answers nothing when no layer had data', () => {
    expect(
      weatherPointIdentify(
        { ...sample, temperatureC: null, wind: null, precipitation: null, cloudCoverPct: null },
        null,
      ),
    ).toBeNull();
  });
});

describe('grid', () => {
  const grid: WeatherGridResponse = {
    layer: 'wind',
    frame: 'f',
    time: '2026-09-16T18:00:00Z',
    bbox: [0, 0, 2, 2],
    cols: 2,
    rows: 2,
    u: [0, 2, 0, 2],
    v: [-4, -4, null, -4],
  };

  it('labels wind with its speed and the bearing it blows toward', () => {
    const labels = weatherGridLabels(grid);
    expect(labels.features).toHaveLength(3); // the null cell is skipped
    expect(labels.features[0]!.properties).toMatchObject({ label: '4', rotation: 180 });
    expect(labels.features[0]!.geometry.coordinates).toEqual([0.5, 1.5]);
  });

  it('interpolates wind between cell centres and refuses gaps', () => {
    expect(sampleWindGrid(grid, 0.5, 0)).toEqual({ u: 1, v: -4 });
    expect(sampleWindGrid(grid, 0.5, 0.5)).toBeNull();
    expect(sampleWindGrid(grid, -1, 0)).toBeNull();
  });

  it('labels temperature as whole degrees', () => {
    const labels = weatherGridLabels({
      ...grid,
      layer: 'temperature',
      values: [3.4, null, -2, 10],
    });
    expect(labels.features.map((f) => f.properties!['label'])).toEqual(['3°', '-2°', '10°']);
  });
});

describe('weather warnings', () => {
  const polygon = {
    type: 'Polygon' as const,
    coordinates: [
      [
        [5, 60],
        [6, 60],
        [6, 61],
        [5, 61],
        [5, 60],
      ],
    ],
  };
  const alert = (level: string, ends: string, event = 'gale') => ({
    type: 'Feature',
    geometry: polygon,
    properties: {
      id: `${level}-${event}`,
      awareness_level: level,
      event,
      area: 'Fedje - Bulandet',
      description: 'Northwest gale force 8.',
      instruction: 'Consider not taking the boat out.',
      web: 'https://www.met.no/',
    },
    when: { interval: ['2026-09-16T12:00:00+00:00', ends] },
  });

  it('keeps live yellow-or-worse warnings with a badge point each, worst drawn last', () => {
    const fc = normalizeMetAlerts(
      {
        features: [
          alert('3; orange; Severe', '2026-09-17T06:00:00+00:00', 'rain'),
          alert('2; yellow; Moderate', '2026-09-17T06:00:00+00:00'),
          alert('1; green; Minor', '2026-09-17T06:00:00+00:00'),
          alert('2; yellow; Moderate', '2026-09-16T06:00:00+00:00', 'wind'),
        ],
      },
      NOW,
    );
    const props = fc.features.map((f) => f.properties as WeatherWarningProperties);
    expect(props.map((p) => p.level)).toEqual(['yellow', 'yellow', 'orange', 'orange']);
    expect(props.filter((p) => p.badge)).toHaveLength(2);
    const badge = fc.features.find((f) => (f.properties as WeatherWarningProperties).badge)!;
    expect(badge.geometry.type).toBe('Point');
    expect(props[2]!.eventLabel).toBe('Heavy rain');
  });

  it('ignores a malformed feed', () => {
    expect(normalizeMetAlerts(null).features).toEqual([]);
    expect(normalizeMetAlerts({ features: [{ properties: {} }] }).features).toEqual([]);
  });

  it('describes a tapped warning with its validity and advice', () => {
    const fc = normalizeMetAlerts(
      { features: [alert('2; yellow; Moderate', '2026-09-17T06:00:00+00:00')] },
      NOW,
    );
    const group = weatherWarningIdentify(fc.features[0]!.properties, NOW)!;
    expect(group.title).toBe('Gale');
    expect(group.properties['Level']).toBe('Yellow');
    expect(group.properties['Advice']).toBe('Consider not taking the boat out.');
    expect(group.properties['Valid']).toContain('–');
  });
});

describe('tile addressing', () => {
  it('finds the tile and pixel under a point', () => {
    expect(tilePixelAt(0, 0, 0)).toEqual({ x: 0, y: 0, px: 128, py: 128 });
    const oslo = tilePixelAt(10.75, 59.91, 5);
    expect(oslo.x).toBe(16);
    expect(oslo.y).toBe(9);
    // The poles clamp into the last row instead of producing NaN.
    expect(tilePixelAt(0, 90, 2).y).toBe(0);
    expect(tilePixelAt(180, -90, 2)).toMatchObject({ x: 0, y: 3 });
  });

  it('reads a decoded value at a pixel', () => {
    const raster = { width: 1, height: 1, data: [140, 0, 0, 255] };
    expect(weatherValueAt('temperature', raster, 0, 0)).toEqual({
      layer: 'temperature',
      value: 12,
    });
    const dry = { width: 1, height: 1, data: [0, 0, 0, 255] };
    expect(weatherValueAt('precipitation', dry, 0, 0).value).toBe(0);
  });

  it('reads a grid at a zoom fine enough for its cells but bounded in tiles', () => {
    // Southern Norway at 40 columns: 0.3° cells want pixels of 0.15° or finer — z4's 0.088°.
    expect(weatherGridZoom([4, 57, 16, 64], 40, 0, 6)).toBe(4);
    expect(weatherGridZoom([10, 59, 11, 60], 40, 0, 5)).toBe(5);
    // The world at 1000 columns would want z3, which is 64 tiles; z2 fits in 16.
    expect(weatherGridZoom([-180, -80, 180, 80], 1000, 0, 6)).toBe(2);
  });
});

describe('cloud colour', () => {
  it('never wraps a channel past 255 on full high cloud', () => {
    for (const deck of [
      [0, 0, 200],
      [0, 200, 200],
      [200, 200, 200],
      [0, 0, 180],
    ]) {
      const out = paintWeatherTile('clouds', world(uniform([...deck, 255])), 0, 0, 0);
      // Grey, never tinted: blue within a few steps of red.
      expect(Math.abs(px(out, 10)[2]! - px(out, 10)[0]!)).toBeLessThan(12);
    }
  });
});

describe('temperature numbers', () => {
  const grid: WeatherGridResponse = {
    layer: 'temperature',
    frame: 'f',
    time: '2026-09-16T18:00:00Z',
    bbox: [0, 0, 6, 6],
    cols: 6,
    rows: 6,
    values: Array.from({ length: 36 }, (_, i) => (i % 6) * 2),
  };

  it('interpolates a value at a town between cell centres', () => {
    expect(sampleScalarGrid(grid, 1, 3)).toBeCloseTo(1, 5);
    expect(sampleScalarGrid(grid, 9, 3)).toBeNull();
  });

  it('puts a number at each labelled town, then a sparse fill of the grid', () => {
    const labels = weatherValueLabels(grid, [{ lng: 2.5, lat: 3 }], 3);
    expect(labels.features[0]!.properties).toEqual({ label: '4°', value: 4, place: true });
    const fill = labels.features.filter((f) => f.properties!['place'] === false);
    expect(fill).toHaveLength(4); // rows and columns 1 and 4
  });
});
