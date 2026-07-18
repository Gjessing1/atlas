import { describe, expect, it } from 'vitest';
import { fetchRoute, RoutingError } from './client.js';
import { httpRouteProvider, valhallaRouteProvider } from './provider.js';
import { buildValhallaRequest, parseValhallaResponse, roundTripLocations } from './valhalla.js';

const oslo = { lat: 59.9139, lng: 10.7522 };
const sognsvann = { lat: 59.9706, lng: 10.7305 };

/** Encode `[lat, lng]` pairs as a Valhalla polyline (precision 6) — inverse of the parser's decoder. */
function encodeShape(coords: [number, number][], precision = 6): string {
  const factor = 10 ** precision;
  let out = '';
  let prevLat = 0;
  let prevLng = 0;
  const enc = (current: number, previous: number): string => {
    let value = (Math.round(current * factor) - Math.round(previous * factor)) << 1;
    if (value < 0) value = ~value;
    let chunk = '';
    while (value >= 0x20) {
      chunk += String.fromCharCode((0x20 | (value & 0x1f)) + 63);
      value >>= 5;
    }
    chunk += String.fromCharCode(value + 63);
    return chunk;
  };
  for (const [lat, lng] of coords) {
    out += enc(lat, prevLat);
    out += enc(lng, prevLng);
    prevLat = lat;
    prevLng = lng;
  }
  return out;
}

// One-leg Valhalla trip: a short drive with three shape points and two maneuvers.
const legShape: [number, number][] = [
  [59.9139, 10.7522],
  [59.92, 10.76],
  [59.93, 10.77],
];
const valhallaResponse = {
  trip: {
    units: 'kilometers',
    summary: {
      length: 4.3, // km
      time: 421, // s
      min_lat: 59.9139,
      min_lon: 10.7522,
      max_lat: 59.93,
      max_lon: 10.77,
    },
    legs: [
      {
        shape: encodeShape(legShape),
        maneuvers: [
          {
            type: 1, // start → continue (0)
            instruction: 'Drive northeast on Karl Johans gate.',
            street_names: ['Karl Johans gate'],
            length: 2.5,
            time: 200,
            begin_shape_index: 0,
            end_shape_index: 1,
          },
          {
            type: 10, // right (2)
            instruction: 'Turn right.',
            length: 1.8,
            time: 221,
            begin_shape_index: 1,
            end_shape_index: 2,
          },
          {
            type: 4, // destination (4)
            instruction: 'You have arrived.',
            length: 0,
            time: 0,
            begin_shape_index: 2,
            end_shape_index: 2,
          },
        ],
      },
    ],
  },
};

describe('buildValhallaRequest', () => {
  it('maps points and the costing model', () => {
    const body = buildValhallaRequest({ profile: 'car', points: [oslo, sognsvann] });
    expect(body).toMatchObject({
      locations: [
        { lat: 59.9139, lon: 10.7522 },
        { lat: 59.9706, lon: 10.7305 },
      ],
      costing: 'auto',
      directions_options: { units: 'kilometers', language: 'en' },
    });
    expect(body['alternates']).toBeUndefined();
  });

  it('maps each profile to its costing model', () => {
    expect(buildValhallaRequest({ profile: 'bike', points: [oslo, sognsvann] })['costing']).toBe(
      'bicycle',
    );
    expect(buildValhallaRequest({ profile: 'foot', points: [oslo, sognsvann] })['costing']).toBe(
      'pedestrian',
    );
    const hike = buildValhallaRequest({ profile: 'hike', points: [oslo, sognsvann] });
    expect(hike['costing']).toBe('pedestrian');
    // Hiking allows mountain paths that plain pedestrian costing rejects.
    expect(hike['costing_options']).toEqual({ pedestrian: { max_hiking_difficulty: 6 } });
  });

  it('requests alternates only for 2-point queries', () => {
    expect(
      buildValhallaRequest({ profile: 'car', points: [oslo, sognsvann], alternatives: true })[
        'alternates'
      ],
    ).toBe(2);
    expect(
      buildValhallaRequest({
        profile: 'car',
        points: [oslo, sognsvann, oslo],
        alternatives: true,
      })['alternates'],
    ).toBeUndefined();
  });

  it('puts the travel direction on the first location only', () => {
    const body = buildValhallaRequest({
      profile: 'car',
      points: [oslo, sognsvann],
      headingDeg: 123.6,
    });
    const locations = body['locations'] as Record<string, unknown>[];
    expect(locations[0]).toMatchObject({ lat: oslo.lat, lon: oslo.lng, heading: 124 });
    expect(locations[1]!['heading']).toBeUndefined();
    // Negative headings normalize onto the compass.
    const wrapped = buildValhallaRequest({
      profile: 'car',
      points: [oslo, sognsvann],
      headingDeg: -90,
    });
    expect((wrapped['locations'] as Record<string, unknown>[])[0]!['heading']).toBe(270);
    // No heading given — none sent.
    const plain = buildValhallaRequest({ profile: 'car', points: [oslo, sognsvann] });
    expect((plain['locations'] as Record<string, unknown>[])[0]!['heading']).toBeUndefined();
  });

  it('requests maneuvers only when instructions are asked for', () => {
    const planning = buildValhallaRequest({ profile: 'car', points: [oslo, sognsvann] });
    expect(planning['directions_type']).toBe('none');
    const nav = buildValhallaRequest({
      profile: 'car',
      points: [oslo, sognsvann],
      instructions: true,
    });
    expect(nav['directions_type']).toBeUndefined();
  });

  it('synthesizes round trips as a loop of through-locations', () => {
    const body = buildValhallaRequest({
      profile: 'hike',
      points: [oslo],
      roundTrip: { distanceM: 5000, seed: 3 },
    });
    const locations = body['locations'] as { lat: number; lon: number; type: string }[];
    // Start and end at the single starting point, vias in between.
    expect(locations).toHaveLength(5);
    expect(locations[0]).toMatchObject({ lat: oslo.lat, lon: oslo.lng, type: 'break' });
    expect(locations[4]).toMatchObject({ lat: oslo.lat, lon: oslo.lng, type: 'break' });
    for (const via of locations.slice(1, 4)) expect(via.type).toBe('through');
    // Round trips never ask for alternates.
    expect(body['alternates']).toBeUndefined();
  });
});

describe('roundTripLocations', () => {
  it('lays the loop out at roughly the requested distance', () => {
    const locs = roundTripLocations(oslo, 5000, 0);
    expect(locs[0]).toEqual(oslo);
    expect(locs[locs.length - 1]).toEqual(oslo);
    // Straight-line perimeter of the loop polygon approximates the asked-for
    // distance (roads only ever make it longer).
    let perimeter = 0;
    for (let i = 1; i < locs.length; i++) {
      const a = locs[i - 1]!;
      const b = locs[i]!;
      const dLat = ((b.lat - a.lat) * Math.PI) / 180;
      const dLng = ((b.lng - a.lng) * Math.PI) / 180;
      const mLat = ((a.lat + b.lat) / 2) * (Math.PI / 180);
      perimeter += 6371008.8 * Math.hypot(dLat, dLng * Math.cos(mLat));
    }
    expect(perimeter).toBeGreaterThan(4000);
    expect(perimeter).toBeLessThan(6000);
  });

  it('varies the loop with the seed but stays deterministic', () => {
    const a = roundTripLocations(oslo, 5000, 1);
    const b = roundTripLocations(oslo, 5000, 2);
    const a2 = roundTripLocations(oslo, 5000, 1);
    expect(a).toEqual(a2);
    expect(a[1]).not.toEqual(b[1]);
  });
});

describe('parseValhallaResponse', () => {
  it('decodes geometry, converts units, and maps maneuvers', () => {
    const { paths } = parseValhallaResponse(valhallaResponse);
    expect(paths).toHaveLength(1);
    const path = paths[0]!;
    // km → m, s → ms.
    expect(path.distanceM).toBeCloseTo(4300, 5);
    expect(path.timeMs).toBe(421_000);
    // Decoded polyline round-trips to the original coordinates (precision 6).
    expect(path.points).toHaveLength(3);
    expect(path.points[0]!.lat).toBeCloseTo(59.9139, 6);
    expect(path.points[0]!.lng).toBeCloseTo(10.7522, 6);
    expect(path.points[2]!.lat).toBeCloseTo(59.93, 6);
    expect(path.points[0]!.ele).toBeUndefined();
    expect(path.ascentM).toBe(0);
    expect(path.bbox).toEqual({
      sw: { lat: 59.9139, lng: 10.7522 },
      ne: { lat: 59.93, lng: 10.77 },
    });
    expect(path.instructions).toHaveLength(3);
    expect(path.instructions![0]).toMatchObject({
      text: 'Drive northeast on Karl Johans gate.',
      sign: 0,
      streetName: 'Karl Johans gate',
      interval: [0, 1],
      distanceM: 2500,
      timeMs: 200_000,
    });
    expect(path.instructions![1]).toMatchObject({ sign: 2, interval: [1, 2] });
    expect(path.instructions![1]!.streetName).toBeUndefined();
    expect(path.instructions![2]!.sign).toBe(4);
  });

  it('concatenates multi-leg trips, dropping the shared join vertex and offsetting intervals', () => {
    const legA: [number, number][] = [
      [60, 10.0],
      [60, 10.1],
      [60, 10.2],
    ];
    // Leg B starts where leg A ended (shared vertex at 60,10.2).
    const legB: [number, number][] = [
      [60, 10.2],
      [60, 10.3],
    ];
    const multi = {
      trip: {
        units: 'kilometers',
        summary: { length: 20, time: 100 },
        legs: [
          {
            shape: encodeShape(legA),
            maneuvers: [{ type: 1, begin_shape_index: 0, end_shape_index: 2 }],
          },
          {
            shape: encodeShape(legB),
            // Local indices [0,1] must offset to global [2,3].
            maneuvers: [{ type: 15, begin_shape_index: 0, end_shape_index: 1 }],
          },
        ],
      },
    };
    const path = parseValhallaResponse(multi).paths[0]!;
    // 3 + (2 - 1 shared) = 4 points, not 5.
    expect(path.points).toHaveLength(4);
    expect(path.points[3]!.lng).toBeCloseTo(10.3, 6);
    expect(path.instructions![0]!.interval).toEqual([0, 2]);
    expect(path.instructions![1]!.interval).toEqual([2, 3]);
    expect(path.instructions![1]!.sign).toBe(-2); // type 15 → left
  });

  it('maps roundabout maneuvers with an exit number', () => {
    const round = {
      trip: {
        units: 'kilometers',
        summary: { length: 1, time: 10 },
        legs: [
          {
            shape: encodeShape([
              [60, 10],
              [60, 10.01],
            ]),
            maneuvers: [
              {
                type: 26,
                instruction: 'Enter the roundabout.',
                roundabout_exit_count: 2,
                begin_shape_index: 0,
                end_shape_index: 1,
              },
            ],
          },
        ],
      },
    };
    const ins = parseValhallaResponse(round).paths[0]!.instructions![0]!;
    expect(ins.sign).toBe(6);
    expect(ins.exitNumber).toBe(2);
  });

  it('keeps ramp/exit/keep/merge maneuvers distinct via kind', () => {
    const shape = encodeShape([
      [60, 10],
      [60, 10.01],
    ]);
    const trip = (type: number) => ({
      trip: {
        units: 'kilometers',
        summary: { length: 1, time: 10 },
        legs: [{ shape, maneuvers: [{ type, begin_shape_index: 0, end_shape_index: 1 }] }],
      },
    });
    // type → [sign, kind]: on-ramps, exits, forks and merges no longer
    // collapse into one indistinguishable ±7 keep.
    const cases: [number, number, string | undefined][] = [
      [18, 7, 'ramp'],
      [19, -7, 'ramp'],
      [20, 7, 'exit'],
      [21, -7, 'exit'],
      [23, 7, 'keep'],
      [24, -7, 'keep'],
      [17, 0, 'ramp'], // ramp straight: straight geometry, still a decision
      [22, 0, 'keep'],
      [25, 0, 'merge'],
      [37, 7, 'merge'],
      [38, -7, 'merge'],
      [10, 2, undefined], // a plain turn carries no kind
    ];
    for (const [type, sign, kind] of cases) {
      const ins = parseValhallaResponse(trip(type)).paths[0]!.instructions![0]!;
      expect(ins.sign, `type ${type}`).toBe(sign);
      expect(ins.kind, `type ${type}`).toBe(kind);
    }
  });

  it('reads alternates as extra paths', () => {
    const withAlt = {
      ...valhallaResponse,
      alternates: [valhallaResponse],
    };
    expect(parseValhallaResponse(withAlt).paths).toHaveLength(2);
  });

  it('converts miles when the trip reports imperial units', () => {
    const miles = {
      trip: {
        units: 'miles',
        summary: { length: 1, time: 60 },
        legs: [
          {
            shape: encodeShape([
              [60, 10],
              [60, 10.02],
            ]),
            maneuvers: [],
          },
        ],
      },
    };
    expect(parseValhallaResponse(miles).paths[0]!.distanceM).toBeCloseTo(1609.344, 3);
  });

  it('throws on responses without a usable trip', () => {
    expect(() => parseValhallaResponse({})).toThrow(/no paths/);
    expect(() => parseValhallaResponse({ trip: { legs: [] } })).toThrow(/no paths/);
    expect(() => parseValhallaResponse({ trip: { legs: [{ shape: '' }] } })).toThrow(/no paths/);
  });
});

describe('fetchRoute', () => {
  it('POSTs a Valhalla payload to /api/route and parses the response', async () => {
    let captured: { url: string; init?: RequestInit } | null = null;
    const fetchImpl: typeof fetch = async (url, init) => {
      captured = { url: String(url), init };
      return new Response(JSON.stringify(valhallaResponse), { status: 200 });
    };
    const result = await fetchRoute({ profile: 'car', points: [oslo, sognsvann] }, { fetchImpl });
    expect(result.paths).toHaveLength(1);
    expect(captured!.url).toBe('/api/route');
    expect(captured!.init?.method).toBe('POST');
    const sent = JSON.parse(String(captured!.init?.body)) as Record<string, unknown>;
    expect(sent['costing']).toBe('auto');
  });

  it('surfaces the routing error message', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ message: 'No suitable edges near location' }), {
        status: 400,
      });
    await expect(
      fetchRoute({ profile: 'car', points: [oslo, sognsvann] }, { fetchImpl }),
    ).rejects.toThrow(RoutingError);
    await expect(
      fetchRoute({ profile: 'car', points: [oslo, sognsvann] }, { fetchImpl }),
    ).rejects.toThrow(/suitable edges/);
  });
});

describe('httpRouteProvider', () => {
  it('routes through fetchRoute against the configured base URL', async () => {
    let captured: string | null = null;
    const fetchImpl: typeof fetch = async (url) => {
      captured = String(url);
      return new Response(JSON.stringify(valhallaResponse), { status: 200 });
    };
    const provider = httpRouteProvider({ baseUrl: 'https://atlas.example', fetchImpl });
    const result = await provider.route({ profile: 'car', points: [oslo, sognsvann] });
    expect(result.paths).toHaveLength(1);
    expect(captured).toBe('https://atlas.example/api/route');
  });

  it('forwards an abort signal to the request', async () => {
    const controller = new AbortController();
    const fetchImpl: typeof fetch = async (_url, init) => {
      expect(init?.signal).toBe(controller.signal);
      return new Response(JSON.stringify(valhallaResponse), { status: 200 });
    };
    const provider = httpRouteProvider({ fetchImpl });
    await provider.route({ profile: 'car', points: [oslo, sognsvann] }, controller.signal);
  });
});

describe('valhallaRouteProvider', () => {
  it('builds the request, calls the transport, and parses the response', async () => {
    let captured: Record<string, unknown> | null = null;
    const provider = valhallaRouteProvider(async (request) => {
      captured = request;
      return valhallaResponse;
    });
    const result = await provider.route({ profile: 'bike', points: [oslo, sognsvann] });
    expect(result.paths).toHaveLength(1);
    expect(captured!['costing']).toBe('bicycle');
  });

  it('forwards the abort signal to the transport', async () => {
    const controller = new AbortController();
    const provider = valhallaRouteProvider(async (_request, signal) => {
      expect(signal).toBe(controller.signal);
      return valhallaResponse;
    });
    await provider.route({ profile: 'car', points: [oslo, sognsvann] }, controller.signal);
  });
});
