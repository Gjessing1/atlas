import { describe, expect, it } from 'vitest';

import type { RouteInstruction, RoutePath } from './model.js';
import { applyNvdbLanes, nvdbLaneOverrides, type NvdbLaneSegment } from './nvdbLanes.js';

const point = (index: number, lng = 10) => ({ lat: 60 + index * 0.0001, lng });
const instruction = (sign: number, start: number): RouteInstruction => ({
  text: 'turn',
  distanceM: 100,
  timeMs: 10_000,
  sign,
  interval: [start, start + 1],
});
const path = (sign: number): RoutePath => ({
  points: Array.from({ length: 10 }, (_, index) => point(index)),
  distanceM: 100,
  timeMs: 10_000,
  ascentM: 0,
  descentM: 0,
  instructions: [instruction(0, 0), instruction(sign, 7), instruction(4, 9)],
});
const segment = (fieldCodes: string[], reverse = false): NvdbLaneSegment => ({
  fieldCodes,
  points: reverse ? [point(7), point(4)] : [point(4), point(7)],
});

describe('nvdbLaneOverrides', () => {
  it('turns an aligned V field into authoritative left-lane guidance', () => {
    const overrides = nvdbLaneOverrides(path(-2), [segment(['1', '1V1', '2'])]);
    expect(overrides).toEqual([
      {
        instructionIndex: 1,
        lanes: [
          { directions: ['left'], state: 'active', recommendedDirection: 'left' },
          { directions: ['straight'], state: 'invalid' },
        ],
      },
    ]);
  });

  it('uses even field codes when the route runs against geometry order', () => {
    const overrides = nvdbLaneOverrides(path(2), [segment(['1', '2', '2H1'], true)]);
    expect(overrides[0]?.lanes).toEqual([
      { directions: ['straight'], state: 'invalid' },
      { directions: ['right'], state: 'active', recommendedDirection: 'right' },
    ]);
  });

  it('marks ordinary lanes as carrying straight while keeping restricted lanes dim', () => {
    const overrides = nvdbLaneOverrides(path(0), [segment(['1V1', '1', '3K', '2'])]);
    expect(overrides[0]?.lanes).toEqual([
      { directions: ['left'], state: 'invalid' },
      { directions: ['straight'], state: 'active', recommendedDirection: 'straight' },
      { directions: ['straight'], state: 'invalid' },
    ]);
  });

  it('does not invent guidance without an explicit dedicated turn field', () => {
    expect(nvdbLaneOverrides(path(-2), [segment(['1', '3', '2', '4'])])).toEqual([]);
    expect(nvdbLaneOverrides(path(2), [segment(['1', '1V1', '2'])])).toEqual([]);
  });

  it('rejects a nearby road crossing the routed approach', () => {
    const crossing: NvdbLaneSegment = {
      fieldCodes: ['1', '1V1', '2'],
      points: [
        { lat: point(6).lat, lng: 9.999 },
        { lat: point(6).lat, lng: 10.001 },
      ],
    };
    expect(nvdbLaneOverrides(path(-2), [crossing])).toEqual([]);
  });
});

describe('applyNvdbLanes', () => {
  it('replaces the matched maneuver and preserves every other instruction', () => {
    const route = path(-2);
    route.instructions![1]!.lanes = [
      { directions: ['straight'], state: 'active', recommendedDirection: 'straight' },
    ];
    const overrides = nvdbLaneOverrides(route, [segment(['1', '1V1', '2'])]);
    const updated = applyNvdbLanes(route, overrides);
    expect(updated).not.toBe(route);
    expect(updated.instructions![0]).toBe(route.instructions![0]);
    expect(updated.instructions![1]!.lanes?.[0]?.directions).toEqual(['left']);
  });
});
