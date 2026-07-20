import { describe, expect, it } from 'vitest';

import {
  buildTraceAttributesRequest,
  enrichRoute,
  enrichmentAt,
  parseTraceAttributes,
  speedLimitKphAt,
} from './enrich.js';
import type { RoutePath } from './model.js';

/** A straight north-going line of `n` points, ~111 m apart (0.001° of latitude). */
function line(n: number) {
  return Array.from({ length: n }, (_, i) => ({ lat: 60 + i * 0.001, lng: 10 }));
}

function pathOf(n: number): RoutePath {
  return { points: line(n), distanceM: 0, timeMs: 0, ascentM: 0, descentM: 0 };
}

describe('buildTraceAttributesRequest', () => {
  it('walks the given edges rather than map-matching a GPS trace', () => {
    const req = buildTraceAttributesRequest(line(3), 'car');
    expect(req['shape_match']).toBe('edge_walk');
    expect(req['costing']).toBe('auto');
    expect(req['shape']).toEqual([
      { lat: 60, lon: 10 },
      { lat: 60.001, lon: 10 },
      { lat: 60.002, lon: 10 },
    ]);
  });

  it('asks for kilometres so limits come back in km/h', () => {
    const req = buildTraceAttributesRequest(line(2), 'car');
    expect(req['directions_options']).toEqual({ units: 'kilometers' });
  });
});

describe('parseTraceAttributes', () => {
  const points = line(5);

  it('keys edge attributes to distance along the shape', () => {
    const segments = parseTraceAttributes(
      {
        edges: [
          { begin_shape_index: 0, end_shape_index: 2, speed_limit: 80, road_class: 'trunk' },
          { begin_shape_index: 2, end_shape_index: 4, speed_limit: 50, names: ['Storgata'] },
        ],
      },
      points,
    );
    expect(segments).toHaveLength(2);
    expect(segments[0]!.startM).toBe(0);
    expect(segments[0]!.speedLimitKph).toBe(80);
    expect(segments[0]!.roadClass).toBe('trunk');
    // Two ~111 m steps in, give or take the earth's shape.
    expect(segments[1]!.startM).toBeCloseTo(222, 0);
    expect(segments[1]!.name).toBe('Storgata');
  });

  it('treats a zero or missing limit as unknown, not as 0 km/h', () => {
    const segments = parseTraceAttributes(
      {
        edges: [
          { begin_shape_index: 0, end_shape_index: 2, speed_limit: 0 },
          { begin_shape_index: 2, end_shape_index: 4 },
        ],
      },
      points,
    );
    expect(segments[0]!.speedLimitKph).toBeUndefined();
    expect(segments[1]!.speedLimitKph).toBeUndefined();
  });

  it('offsets distances when the shape is a chunk of a longer route', () => {
    const segments = parseTraceAttributes(
      { edges: [{ begin_shape_index: 0, end_shape_index: 2, speed_limit: 90 }] },
      points,
      5000,
    );
    expect(segments[0]!.startM).toBe(5000);
    expect(segments[0]!.endM).toBeCloseTo(5222, 0);
  });

  it('survives junk instead of throwing — enrichment is optional', () => {
    expect(parseTraceAttributes(null, points)).toEqual([]);
    expect(parseTraceAttributes({}, points)).toEqual([]);
    expect(parseTraceAttributes({ edges: 'nope' }, points)).toEqual([]);
    // Degenerate and out-of-range indices are dropped, not clamped into lies.
    expect(
      parseTraceAttributes({ edges: [{ begin_shape_index: 3, end_shape_index: 3 }] }, points),
    ).toEqual([]);
  });
});

describe('enrichRoute', () => {
  it('coalesces touching edges that carry the same attributes', async () => {
    const enrichment = await enrichRoute(pathOf(5), 'car', async () => ({
      edges: [
        { begin_shape_index: 0, end_shape_index: 2, speed_limit: 80 },
        { begin_shape_index: 2, end_shape_index: 4, speed_limit: 80 },
      ],
    }));
    expect(enrichment.segments).toHaveLength(1);
    expect(enrichment.segments[0]!.speedLimitKph).toBe(80);
    expect(enrichment.segments[0]!.endM).toBeCloseTo(445, -1);
  });

  it('chunks a long shape and stitches the pieces back by distance', async () => {
    const sent: unknown[] = [];
    const enrichment = await enrichRoute(
      pathOf(7),
      'car',
      async (request) => {
        sent.push(request);
        const shape = (request as { shape: unknown[] }).shape;
        return {
          edges: [
            {
              begin_shape_index: 0,
              end_shape_index: shape.length - 1,
              speed_limit: sent.length === 1 ? 80 : 60,
            },
          ],
        };
      },
      { maxShapePoints: 4 },
    );
    expect(sent).toHaveLength(2);
    // Chunks overlap by one point, so no edge falls into the seam.
    expect((sent[1] as { shape: { lat: number }[] }).shape[0]!.lat).toBeCloseTo(60.003, 6);
    expect(enrichment.segments.map((s) => s.speedLimitKph)).toEqual([80, 60]);
    expect(enrichment.segments[1]!.startM).toBeCloseTo(enrichment.segments[0]!.endM, 0);
  });

  it('keeps the chunks it already has when a later one fails', async () => {
    let calls = 0;
    const enrichment = await enrichRoute(
      pathOf(7),
      'car',
      async () => {
        calls += 1;
        if (calls > 1) throw new Error('engine went away');
        return { edges: [{ begin_shape_index: 0, end_shape_index: 3, speed_limit: 80 }] };
      },
      { maxShapePoints: 4 },
    );
    expect(enrichment.segments).toHaveLength(1);
    expect(enrichment.segments[0]!.speedLimitKph).toBe(80);
  });

  it('propagates an abort instead of silently returning half a route', async () => {
    await expect(
      enrichRoute(pathOf(5), 'car', async () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      }),
    ).rejects.toThrow('aborted');
  });

  it('returns nothing for a degenerate route without calling the engine', async () => {
    let called = false;
    const enrichment = await enrichRoute(pathOf(1), 'car', async () => {
      called = true;
      return {};
    });
    expect(called).toBe(false);
    expect(enrichment.segments).toEqual([]);
  });
});

describe('lookups', () => {
  const enrichment = {
    segments: [
      { startM: 0, endM: 100, speedLimitKph: 50 },
      { startM: 100, endM: 300, tunnel: true },
      { startM: 300, endM: 500, speedLimitKph: 90 },
    ],
  };

  it('finds the stretch covering a distance', () => {
    expect(enrichmentAt(enrichment, 150)?.tunnel).toBe(true);
    expect(speedLimitKphAt(enrichment, 50)).toBe(50);
    expect(speedLimitKphAt(enrichment, 400)).toBe(90);
  });

  it('reports unknown rather than the neighbouring limit', () => {
    // Inside the tunnel stretch, which carries no limit of its own.
    expect(speedLimitKphAt(enrichment, 200)).toBeNull();
    // Past the enriched range (a route enriched only part-way).
    expect(speedLimitKphAt(enrichment, 900)).toBeNull();
    expect(speedLimitKphAt(null, 10)).toBeNull();
    expect(speedLimitKphAt({ segments: [] }, 10)).toBeNull();
  });
});
