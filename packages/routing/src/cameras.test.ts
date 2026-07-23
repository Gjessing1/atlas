import { describe, expect, it } from 'vitest';

import { conflateCameras, type NvdbCameraPoint, type NvdbCameraSection } from './cameras.js';

/**
 * A north-going route of `n` vertices, ~111 m apart (0.001° latitude), on the
 * meridian 10°E — the same convention as nvdb.test.ts, so vertex i sits at
 * ~i × 111 m along the route and the travel bearing is 0° (due north).
 */
function route(n: number, lng = 10) {
  return Array.from({ length: n }, (_, i) => ({ lat: 60 + i * 0.001, lng }));
}

/** A camera at vertex `idx`, controlled bearing 0° (northbound) by default. */
function camera(idx: number, bearingDeg: number | null = 0, name = 'ATK'): NvdbCameraPoint {
  return { lat: 60 + idx * 0.001, lng: 10, bearingDeg, name };
}

/** A section tracing the route between two vertex indices, in that order. */
function section(fromIdx: number, toIdx: number, name = 'S-ATK'): NvdbCameraSection {
  const step = fromIdx <= toIdx ? 1 : -1;
  const points = [];
  for (let i = fromIdx; step > 0 ? i <= toIdx : i >= toIdx; i += step) {
    points.push({ lat: 60 + i * 0.001, lng: 10 });
  }
  return { name, points };
}

describe('conflateCameras point matching', () => {
  it('returns nothing for degenerate input', () => {
    expect(conflateCameras(route(1), { points: [camera(0)], sections: [] })).toEqual({
      points: [],
      sections: [],
    });
    expect(conflateCameras(route(10), { points: [], sections: [] })).toEqual({
      points: [],
      sections: [],
    });
  });

  it('matches a camera on the route at its along-route distance', () => {
    const { points } = conflateCameras(route(20), { points: [camera(10)], sections: [] });
    expect(points).toHaveLength(1);
    expect(points[0]!.atM).toBeGreaterThan(1090);
    expect(points[0]!.atM).toBeLessThan(1130);
    expect(points[0]!.name).toBe('ATK');
  });

  it('ignores a camera beyond the tolerance (a parallel road)', () => {
    // ~110 m east of the route — far outside the 40 m default.
    const off: NvdbCameraPoint = { ...camera(10), lng: 10.002 };
    expect(conflateCameras(route(20), { points: [off], sections: [] }).points).toEqual([]);
  });

  it('ignores a camera controlling the opposite direction', () => {
    // The route travels north (0°); a camera facing southbound traffic (180°)
    // is the other carriageway's and must stay silent.
    const southbound = camera(10, 180);
    expect(conflateCameras(route(20), { points: [southbound], sections: [] }).points).toEqual([]);
  });

  it('matches a camera whose direction is unknown (either way)', () => {
    const unknown = camera(10, null);
    expect(conflateCameras(route(20), { points: [unknown], sections: [] }).points).toHaveLength(1);
  });

  it('tolerates a skewed but same-way bearing', () => {
    // 40° off the route's 0° travel bearing — inside the 65° tolerance.
    expect(
      conflateCameras(route(20), { points: [camera(10, 40)], sections: [] }).points,
    ).toHaveLength(1);
  });

  it('sorts multiple cameras by along-route distance', () => {
    const { points } = conflateCameras(route(30), {
      points: [camera(20), camera(5)],
      sections: [],
    });
    expect(points.map((p) => Math.round(p.atM / 111))).toEqual([5, 20]);
  });
});

describe('conflateCameras section matching', () => {
  it('matches a section the route drives end to end, in order', () => {
    const { sections } = conflateCameras(route(60), {
      points: [],
      sections: [section(10, 50)],
    });
    expect(sections).toHaveLength(1);
    expect(sections[0]!.startM).toBeGreaterThan(1050);
    expect(sections[0]!.startM).toBeLessThan(1170);
    expect(sections[0]!.endM).toBeGreaterThan(5500);
    expect(sections[0]!.endM).toBeLessThan(5620);
  });

  it('rejects a section driven against its controlled direction', () => {
    // The section runs south (from vertex 50 down to 10); the route drives
    // north. Same geometry, wrong way — the average is not being measured.
    const { sections } = conflateCameras(route(60), {
      points: [],
      sections: [section(50, 10)],
    });
    expect(sections).toEqual([]);
  });

  it('rejects a section the route only joins mid-way', () => {
    // Route covers vertices 0..30 of a section that continues to 50: the exit
    // end is off the route, so the measured stretch was never completed.
    const { sections } = conflateCameras(route(31), {
      points: [],
      sections: [section(10, 50)],
    });
    expect(sections).toEqual([]);
  });

  it('rejects a section on a parallel road', () => {
    const parallel = {
      ...section(10, 50),
      points: section(10, 50).points.map((p) => ({ ...p, lng: p.lng + 0.002 })),
    };
    expect(conflateCameras(route(60), { points: [], sections: [parallel] }).sections).toEqual([]);
  });

  it('suppresses the endpoint point-cameras of a matched section', () => {
    // The entry and exit cameras of a Streknings-ATK are also Punkt-ATK
    // objects; a stand-alone camera far outside the stretch must survive.
    const { points, sections } = conflateCameras(route(80), {
      points: [camera(10, 0, 'entry'), camera(50, 0, 'exit'), camera(70, 0, 'standalone')],
      sections: [section(10, 50)],
    });
    expect(sections).toHaveLength(1);
    expect(points.map((p) => p.name)).toEqual(['standalone']);
  });

  it('keeps the endpoint cameras when the section itself did not match', () => {
    // Driving the stretch the uncontrolled way: no section, but the exit-end
    // camera still controls its own (matching) direction and must announce.
    const { points, sections } = conflateCameras(route(60), {
      points: [camera(30, 0, 'northbound point')],
      sections: [section(50, 10)],
    });
    expect(sections).toEqual([]);
    expect(points).toHaveLength(1);
  });
});
