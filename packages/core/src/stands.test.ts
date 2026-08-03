import { describe, expect, it } from 'vitest';
import {
  parsePlaceStand,
  savedStandFeatures,
  standApproachNote,
  standCardModel,
  standRose,
  STAND_LANE_MIN_M,
  type PlaceStand,
} from './stands.js';

function stand(overrides: Partial<PlaceStand> = {}): PlaceStand {
  return {
    kind: 'stand',
    source: 'atlas-potential',
    target: 'Rådyrbukk · lokkejakt',
    aim: { label: 'SE', bearing: 135, distanceM: 48, position: { lat: 59.851, lng: 10.421 } },
    vantageM: 6,
    maxRangeM: 150,
    lanes: [
      { key: 'e', label: 'E', bearing: 90, rangeM: 120 },
      { key: 'se', label: 'SE', bearing: 135, rangeM: 85 },
      { key: 'n', label: 'N', bearing: 0, rangeM: 8 },
    ],
    approach: {
      risk: 'caution',
      basis: 'mapped-route',
      holdingCoverM: 64,
      walkMinutes: 12,
      approximate: false,
    },
    bandLabel: 'Prime ground',
    warning: 'Terrain visibility is not a backstop check.',
    // Midday UTC, so the rendered date is the same calendar day in every
    // timezone a build machine plausibly runs in.
    savedAt: Date.UTC(2026, 8, 12, 12, 0),
    ...overrides,
  };
}

describe('parsePlaceStand', () => {
  it('round-trips a stand through JSON', () => {
    const parsed = parsePlaceStand(JSON.parse(JSON.stringify(stand())));
    expect(parsed).toEqual(stand());
  });

  it.each([
    ['not an object', 42],
    ['a foreign payload', { kind: 'area', source: 'inatur' }],
    ['a stand from an unknown source', { ...stand(), source: 'guesswork' }],
    ['a missing aim', { ...stand(), aim: undefined }],
    ['an aim with no position', { ...stand(), aim: { label: 'SE', bearing: 1, distanceM: 2 } }],
    ['lanes that are not a list', { ...stand(), lanes: 'E 120 m' }],
    ['a lane with no bearing', { ...stand(), lanes: [{ key: 'e', label: 'E', rangeM: 120 }] }],
    ['an unknown approach risk', { ...stand(), approach: { ...stand().approach, risk: 'maybe' } }],
    ['a non-finite vantage', { ...stand(), vantageM: Number.NaN }],
  ])('rejects %s rather than repairing it', (_label, input) => {
    expect(parsePlaceStand(input)).toBeNull();
  });

  it('accepts a stand with no approach — the shortlist may have had no route', () => {
    expect(parsePlaceStand({ ...stand(), approach: null })?.approach).toBeNull();
  });

  it('drops fields the shape does not define, so a peer cannot smuggle state in', () => {
    const parsed = parsePlaceStand({ ...stand(), sneaky: 'value' }) as Record<string, unknown>;
    expect(parsed['sneaky']).toBeUndefined();
  });
});

describe('standCardModel', () => {
  it('leads with the direction to face and the distance to the habitat', () => {
    const rows = standCardModel(stand()).rows;
    expect(rows[0]!.label).toBe('Face');
    expect(rows[0]!.value).toContain('SE');
    expect(rows[0]!.value).toContain('48 m');
  });

  it('states the vantage against the ground it was measured over', () => {
    expect(standCardModel(stand()).rows[1]!.value).toBe('+6 m above the ground within 150 m');
    expect(standCardModel(stand({ vantageM: -4 })).rows[1]!.value).toContain('below');
    expect(standCardModel(stand({ vantageM: 0 })).rows[1]!.value).toBe(
      'level with the surrounding ground',
    );
  });

  it('lists only the lanes that are sight lines, longest first', () => {
    const sight = standCardModel(stand()).rows.find((row) => row.key === 'sight')!;
    expect(sight.value).toBe('E 120 m · SE 85 m');
  });

  it('says so when terrain closes the stand rather than showing an empty rose', () => {
    const closed = standCardModel(
      stand({ lanes: [{ key: 'n', label: 'N', bearing: 0, rangeM: 4 }] }),
    );
    expect(closed.rose).toHaveLength(0);
    expect(closed.rows.find((row) => row.key === 'sight')!.value).toContain('close this stand');
  });

  it('marks an approximate walk-in as approximate', () => {
    const model = standCardModel(
      stand({ approach: { ...stand().approach!, approximate: true, walkMinutes: 25 } }),
    );
    expect(model.rows.find((row) => row.key === 'walk')!.value).toContain('≈25 min');
  });

  it('omits the walk row entirely when nothing routed it', () => {
    const model = standCardModel(stand({ approach: null }));
    expect(model.rows.some((row) => row.key === 'walk')).toBe(false);
    expect(model.approachNote).toBeNull();
  });

  // The plan is history the moment it is saved: the surface is re-derived, the
  // router re-run and the forecast replaced. A block that could not date itself
  // would present last season's arithmetic as this evening's.
  it('dates the plan and names the band it was saved at', () => {
    const model = standCardModel(stand());
    expect(model.savedNote).toBe('Planned 12 Sep 2026 · Prime ground');
  });

  it('never drops the safety caveat', () => {
    expect(standCardModel(stand()).warning).toContain('backstop');
  });
});

describe('standApproachNote', () => {
  it('rounds cover to the source pixels, not to single metres', () => {
    expect(standApproachNote({ risk: 'high', basis: 'direct-line', holdingCoverM: 184 })).toContain(
      'about 180 m',
    );
  });

  it('names the basis, so a straight-line guess is never read as a route', () => {
    expect(standApproachNote({ risk: 'clear', basis: 'direct-line', holdingCoverM: 0 })).toContain(
      'Direct off-path',
    );
    expect(standApproachNote({ risk: 'clear', basis: 'mapped-route', holdingCoverM: 0 })).toContain(
      'Mapped approach',
    );
  });
});

describe('standRose', () => {
  // Normalising to the longest lane would draw a closed hollow and an open ridge
  // as the same figure — exactly the comparison the rose exists to allow.
  it('scales spokes against the planning distance, not the longest lane', () => {
    const rose = standRose(stand());
    const east = rose.spokes.find((spoke) => spoke.key === 'e')!;
    expect(east.share).toBeCloseTo(120 / 150, 5);
    // Due east: dead level with the centre, to the right of it.
    expect(east.y).toBeCloseTo(0.5, 5);
    expect(east.x).toBeGreaterThan(0.5);
  });

  it('puts north up, as an SVG box rather than a compass', () => {
    const rose = standRose(stand({ lanes: [{ key: 'n', label: 'N', bearing: 0, rangeM: 150 }] }));
    expect(rose.spokes[0]!.y).toBeLessThan(0.5);
    expect(rose.spokes[0]!.x).toBeCloseTo(0.5, 5);
  });

  it('drops spokes too short to be sight lines', () => {
    const rose = standRose(
      stand({ lanes: [{ key: 'n', label: 'N', bearing: 0, rangeM: STAND_LANE_MIN_M - 1 }] }),
    );
    expect(rose.spokes).toHaveLength(0);
  });

  // The habitat can sit beyond the traced lanes; the drawing is clamped while
  // the card still states the true distance.
  it('clamps an aim beyond the planning distance into the box', () => {
    const rose = standRose(stand({ aim: { ...stand().aim, distanceM: 400 } }));
    expect(rose.aim.share).toBe(1);
  });
});

describe('savedStandFeatures', () => {
  const place = { id: 'p1', lat: 59.85, lng: 10.42, stand: stand() };

  it('draws each sight line and the aim from the pin', () => {
    const fc = savedStandFeatures([place]);
    expect(fc.features.map((f) => f.properties.kind)).toEqual(['lane', 'lane', 'aim']);
    expect(fc.features.every((f) => f.geometry.coordinates[0]![0] === place.lng)).toBe(true);
  });

  it('carries the place id, so a rose can be traced back to its pin', () => {
    expect(savedStandFeatures([place]).features[0]!.properties.placeId).toBe('p1');
  });

  it('ignores ordinary places — most pins are not stands', () => {
    expect(savedStandFeatures([{ id: 'p2', lat: 59.85, lng: 10.42 }]).features).toHaveLength(0);
  });
});
