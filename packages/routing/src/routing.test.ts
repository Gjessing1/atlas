import { describe, expect, it } from 'vitest';
import { fetchRoute, RoutingError } from './client.js';
import { buildRouteRequest, parseRouteResponse } from './graphhopper.js';
import { viaInsertIndex } from './insert.js';
import { routePathToTrackData } from './model.js';
import { optimizeWaypointOrder } from './optimize.js';
import { httpRouteProvider } from './provider.js';

const oslo = { lat: 59.9139, lng: 10.7522 };
const sognsvann = { lat: 59.9706, lng: 10.7305 };

// A GraphHopper response trimmed to the fields Atlas consumes.
const ghResponse = {
  hints: { 'visited_nodes.sum': 100 },
  info: { copyrights: ['GraphHopper', 'OpenStreetMap contributors'] },
  paths: [
    {
      distance: 4300.2,
      time: 421_000,
      ascend: 55.5,
      descend: 12.25,
      bbox: [10.75, 59.91, 10.8, 59.93],
      points: {
        type: 'LineString',
        coordinates: [
          [10.7522, 59.9139, 4.02],
          [10.76, 59.92, 10.5],
          [10.8, 59.93, 21.0],
        ],
      },
    },
    {
      distance: 4600,
      time: 450_000,
      points: {
        type: 'LineString',
        coordinates: [
          [10.7522, 59.9139],
          [10.8, 59.93],
        ],
      },
    },
  ],
};

describe('buildRouteRequest', () => {
  it('builds a plain point-to-point request', () => {
    const body = buildRouteRequest({ profile: 'car', points: [oslo, sognsvann] });
    expect(body).toMatchObject({
      profile: 'car',
      points: [
        [10.7522, 59.9139],
        [10.7305, 59.9706],
      ],
      elevation: true,
      points_encoded: false,
      instructions: false,
    });
    expect(body['algorithm']).toBeUndefined();
  });

  it('requests instructions only when asked', () => {
    const off = buildRouteRequest({ profile: 'car', points: [oslo, sognsvann] });
    expect(off['instructions']).toBe(false);
    const on = buildRouteRequest({ profile: 'car', points: [oslo, sognsvann], instructions: true });
    expect(on['instructions']).toBe(true);
  });

  it('requests alternatives only for 2-point queries', () => {
    const twoPoints = buildRouteRequest({
      profile: 'bike',
      points: [oslo, sognsvann],
      alternatives: true,
    });
    expect(twoPoints['algorithm']).toBe('alternative_route');

    const threePoints = buildRouteRequest({
      profile: 'bike',
      points: [oslo, sognsvann, oslo],
      alternatives: true,
    });
    expect(threePoints['algorithm']).toBeUndefined();
  });

  it('builds round-trip requests', () => {
    const body = buildRouteRequest({
      profile: 'hike',
      points: [oslo],
      roundTrip: { distanceM: 5000.7, seed: 3 },
    });
    expect(body['algorithm']).toBe('round_trip');
    expect(body['round_trip.distance']).toBe(5001);
    expect(body['round_trip.seed']).toBe(3);
  });
});

describe('parseRouteResponse', () => {
  it('maps paths, elevation and bbox', () => {
    const result = parseRouteResponse(ghResponse);
    expect(result.paths).toHaveLength(2);
    const [primary, alt] = result.paths;
    expect(primary!.distanceM).toBe(4300.2);
    expect(primary!.timeMs).toBe(421_000);
    expect(primary!.ascentM).toBe(55.5);
    expect(primary!.descentM).toBe(12.25);
    expect(primary!.points[0]).toEqual({ lat: 59.9139, lng: 10.7522, ele: 4 });
    expect(primary!.bbox).toEqual({
      sw: { lat: 59.91, lng: 10.75 },
      ne: { lat: 59.93, lng: 10.8 },
    });
    // Alternative without elevation/bbox still parses.
    expect(alt!.points[0]).toEqual({ lat: 59.9139, lng: 10.7522 });
    expect(alt!.bbox).toBeUndefined();
  });

  it('throws on responses without usable paths', () => {
    expect(() => parseRouteResponse({})).toThrow(/no paths/);
    expect(() => parseRouteResponse({ paths: [] })).toThrow(/no paths/);
    expect(() => parseRouteResponse({ paths: [{ points: { coordinates: [] } }] })).toThrow(
      /no usable paths/,
    );
  });

  it('parses turn instructions when present, skipping malformed entries', () => {
    const withInstructions = {
      paths: [
        {
          distance: 100,
          time: 20_000,
          points: {
            coordinates: [
              [10.75, 59.91],
              [10.76, 59.92],
              [10.77, 59.93],
            ],
          },
          instructions: [
            {
              text: 'Head north on Karl Johans gate',
              distance: 60,
              time: 12_000,
              sign: 0,
              street_name: 'Karl Johans gate',
              interval: [0, 1],
            },
            { text: 'Turn right', distance: 40, time: 8000, sign: 2, interval: [1, 2] },
            { text: 'no interval', sign: 4 }, // malformed → skipped
          ],
        },
      ],
    };
    const [path] = parseRouteResponse(withInstructions).paths;
    expect(path!.instructions).toHaveLength(2);
    expect(path!.instructions![0]).toEqual({
      text: 'Head north on Karl Johans gate',
      distanceM: 60,
      timeMs: 12_000,
      sign: 0,
      streetName: 'Karl Johans gate',
      interval: [0, 1],
    });
    expect(path!.instructions![1]!.sign).toBe(2);
    expect(path!.instructions![1]!.streetName).toBeUndefined();
  });

  it('omits instructions when the response has none', () => {
    const [path] = parseRouteResponse(ghResponse).paths;
    expect(path!.instructions).toBeUndefined();
  });
});

describe('routePathToTrackData', () => {
  it('wraps the path as a single-segment track', () => {
    const { paths } = parseRouteResponse(ghResponse);
    const data = routePathToTrackData(paths[0]!, 'Morning ride');
    expect(data.name).toBe('Morning ride');
    expect(data.segments).toHaveLength(1);
    expect(data.segments[0]).toHaveLength(3);
    expect(data.waypoints).toEqual([]);
  });
});

describe('fetchRoute', () => {
  const okFetch = (body: unknown, status = 200): typeof fetch =>
    (async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;

  it('POSTs to /api/route and parses the response', async () => {
    let captured: { url: string; init?: RequestInit } | null = null;
    const fetchImpl: typeof fetch = async (url, init) => {
      captured = { url: String(url), init };
      return new Response(JSON.stringify(ghResponse), { status: 200 });
    };
    const result = await fetchRoute({ profile: 'car', points: [oslo, sognsvann] }, { fetchImpl });
    expect(result.paths).toHaveLength(2);
    expect(captured!.url).toBe('/api/route');
    expect(captured!.init?.method).toBe('POST');
    const sent = JSON.parse(String(captured!.init?.body)) as Record<string, unknown>;
    expect(sent['profile']).toBe('car');
  });

  it('surfaces the GraphHopper error message', async () => {
    const fetchImpl = okFetch({ message: 'Point 0 is out of bounds: 5,5' }, 400);
    await expect(
      fetchRoute({ profile: 'car', points: [oslo, sognsvann] }, { fetchImpl }),
    ).rejects.toThrow(RoutingError);
    await expect(
      fetchRoute({ profile: 'car', points: [oslo, sognsvann] }, { fetchImpl }),
    ).rejects.toThrow(/out of bounds/);
  });
});

describe('viaInsertIndex', () => {
  // A straight west→east path with waypoints at both ends and one in the middle.
  const pathPoints = Array.from({ length: 11 }, (_, i) => ({ lat: 60, lng: 10 + i * 0.1 }));
  const waypoints = [
    { lat: 60, lng: 10.0 },
    { lat: 60, lng: 10.5 },
    { lat: 60, lng: 11.0 },
  ];

  it('inserts into the clicked route section', () => {
    // Clicked between start and the middle stop → insert before index 1.
    expect(viaInsertIndex(pathPoints, waypoints, { lat: 60.01, lng: 10.2 })).toBe(1);
    // Clicked between the middle stop and the end → insert before index 2.
    expect(viaInsertIndex(pathPoints, waypoints, { lat: 60.01, lng: 10.8 })).toBe(2);
  });

  it('falls back to before-the-end for degenerate input', () => {
    expect(viaInsertIndex([], waypoints, { lat: 60, lng: 10.2 })).toBe(2);
    expect(viaInsertIndex(pathPoints, [waypoints[0]!], { lat: 60, lng: 10.2 })).toBe(1);
  });
});

describe('optimizeWaypointOrder', () => {
  it('returns identity for fewer than 4 points', () => {
    expect(optimizeWaypointOrder([oslo])).toEqual([0]);
    expect(optimizeWaypointOrder([oslo, sognsvann])).toEqual([0, 1]);
    expect(optimizeWaypointOrder([oslo, sognsvann, oslo])).toEqual([0, 1, 2]);
  });

  it('sorts shuffled stops along a line, keeping endpoints fixed', () => {
    // Points on a west→east line, intermediates shuffled: 0, (3, 1, 2), 4.
    const at = (lng: number) => ({ lat: 60, lng });
    const points = [at(10.0), at(10.3), at(10.2), at(10.1), at(10.4)];
    expect(optimizeWaypointOrder(points)).toEqual([0, 3, 2, 1, 4]);
  });

  it('untangles a crossing that nearest-neighbor alone would keep', () => {
    // Start west, end east, with two pairs of stops arranged so the greedy
    // pass zig-zags; 2-opt must produce a shorter tour than the greedy one.
    const points = [
      { lat: 60.0, lng: 10.0 },
      { lat: 60.05, lng: 10.5 },
      { lat: 59.95, lng: 10.52 },
      { lat: 60.05, lng: 10.54 },
      { lat: 59.95, lng: 10.5 },
      { lat: 60.0, lng: 11.0 },
    ];
    const order = optimizeWaypointOrder(points);
    expect(order[0]).toBe(0);
    expect(order[order.length - 1]).toBe(5);
    expect([...order].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5]);
  });
});

describe('httpRouteProvider', () => {
  it('routes through fetchRoute against the configured base URL', async () => {
    let captured: string | null = null;
    const fetchImpl: typeof fetch = async (url) => {
      captured = String(url);
      return new Response(JSON.stringify(ghResponse), { status: 200 });
    };
    const provider = httpRouteProvider({ baseUrl: 'https://atlas.example', fetchImpl });
    const result = await provider.route({ profile: 'car', points: [oslo, sognsvann] });
    expect(result.paths).toHaveLength(2);
    expect(captured).toBe('https://atlas.example/api/route');
  });

  it('forwards an abort signal to the request', async () => {
    const controller = new AbortController();
    const fetchImpl: typeof fetch = async (_url, init) => {
      expect(init?.signal).toBe(controller.signal);
      return new Response(JSON.stringify(ghResponse), { status: 200 });
    };
    const provider = httpRouteProvider({ fetchImpl });
    await provider.route({ profile: 'car', points: [oslo, sognsvann] }, controller.signal);
  });
});
