import { parsePlaceStand } from '@atlas/core';
import { describe, expect, it } from 'vitest';
import type { PotentialSpot } from './api.js';
import { FISH_SPECIES } from './species.js';
import {
  spotApproachLabel,
  spotColor,
  spotPlaceDraft,
  spotStandRecord,
  spotsFeatureCollection,
  SPOT_MIN_RANK,
  SPOT_MIN_SEPARATION_M,
  thinSpots,
} from './spots.js';
import { SURFACE_BANDS } from './surface.js';

function spot(overrides: Partial<PotentialSpot> = {}): PotentialSpot {
  return {
    id: 'x',
    position: { lat: 59.85, lng: 10.42 },
    cell: '11/1083/596',
    rank: 0.98,
    cellRank: 0.98,
    score: 98,
    band: 'prime',
    bandLabel: 'Prime',
    reason: 'Inflow mouth right here.',
    factors: [],
    access: null,
    stand: null,
    ...overrides,
  };
}

/** The hunter-side half of a paired recommendation, as the engine returns it. */
const STAND = {
  maxRangeM: 150,
  vantageM: 6,
  lanes: [
    { key: 'e', label: 'E', bearing: 90, rangeM: 120 },
    { key: 'se', label: 'SE', bearing: 135, rangeM: 85 },
  ],
  aim: { label: 'SE', bearing: 135, distanceM: 115, position: { lat: 59.85, lng: 10.42 } },
  warning: 'Verify backstop.',
};

/** ~metres north of a point, for readable separation cases. */
function north(from: { lat: number; lng: number }, metres: number) {
  return { lat: from.lat + metres / 111_320, lng: from.lng };
}

describe('thinSpots', () => {
  const base = { lat: 59.85, lng: 10.42 };

  it('keeps the strongest candidate of a neighbourhood and drops its neighbours', () => {
    const kept = thinSpots([
      { position: base, rank: 0.9 },
      { position: north(base, 50), rank: 0.99 },
      { position: north(base, 90), rank: 0.95 },
    ]);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.rank).toBe(0.99);
  });

  it('keeps candidates that are genuinely apart, strongest first', () => {
    const kept = thinSpots([
      { position: base, rank: 0.9 },
      { position: north(base, SPOT_MIN_SEPARATION_M + 50), rank: 0.99 },
    ]);
    expect(kept.map((k) => k.rank)).toEqual([0.99, 0.9]);
  });

  it('honours the limit', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      position: north(base, i * (SPOT_MIN_SEPARATION_M + 50)),
      rank: 1 - i / 100,
    }));
    expect(thinSpots(many, { limit: 3 })).toHaveLength(3);
  });

  it('merges across cell boundaries — the reason it is metres and not pixels', () => {
    // Same bay, two cells: without a geographic merge this is offered twice.
    const kept = thinSpots([
      { position: base, rank: 0.97, cell: '11/1083/596' },
      { position: north(base, 40), rank: 0.96, cell: '11/1083/597' },
    ]);
    expect(kept).toHaveLength(1);
  });
});

describe('the shortlist agrees with the ramp', () => {
  it('takes its threshold from the ramp itself', () => {
    expect(SPOT_MIN_RANK).toBe(SURFACE_BANDS[SURFACE_BANDS.length - 1]!.minRank);
  });

  it('colours a marker with its own band, at full strength', () => {
    const [r, g, b] = SURFACE_BANDS.find((band) => band.key === 'prime')!.color;
    expect(spotColor({ band: 'prime' })).toBe(`rgb(${r}, ${g}, ${b})`);
  });
});

describe('spotsFeatureCollection', () => {
  it('numbers the markers in list order, so map and list cannot disagree', () => {
    const fc = spotsFeatureCollection([spot({ id: 'a' }), spot({ id: 'b', rank: 0.96 })]);
    expect(fc.features.map((f) => f.properties.number)).toEqual([1, 2]);
    expect(fc.features.map((f) => f.properties.label)).toEqual(['1', '2']);
    expect(fc.features[0]!.properties.id).toBe('a');
    expect(fc.features[0]!.geometry.coordinates).toEqual([10.42, 59.85]);
  });

  it('draws the stand rose and paired-habitat bearing as lines', () => {
    const at = spot({
      stand: {
        maxRangeM: 150,
        vantageM: 4,
        lanes: [
          { key: 'e', label: 'E', bearing: 90, rangeM: 120 },
          { key: 'w', label: 'W', bearing: 270, rangeM: 10 },
        ],
        aim: { label: 'E', bearing: 90, distanceM: 100, position: { lat: 59.85, lng: 10.422 } },
        warning: 'Verify backstop.',
      },
    });
    const fc = spotsFeatureCollection([at]);
    expect(fc.features.map((feature) => feature.properties.kind)).toEqual(['spot', 'lane', 'aim']);
    expect(fc.features.slice(1).every((feature) => feature.geometry.type === 'LineString')).toBe(
      true,
    );
  });
});

describe('spotPlaceDraft', () => {
  it('carries the reasoning into the notes — the pin outlives the surface', () => {
    const draft = spotPlaceDraft(
      spot({
        access: { distanceM: 900, durationS: 720, approximate: false, from: spot().position },
      }),
      2,
      { targetLabel: 'Ørret' },
    );
    expect(draft.name).toBe('Ørret spot 3');
    expect(draft.notes).toContain('Inflow mouth right here.');
    expect(draft.notes).toContain('12 min walk');
    expect(draft.tags).toContain('fishing');
  });

  it('marks an approximate walk as approximate', () => {
    const draft = spotPlaceDraft(
      spot({
        access: { distanceM: 900, durationS: 720, approximate: true, from: spot().position },
      }),
      0,
    );
    expect(draft.notes).toContain('≈12 min walk');
  });

  it('carries a disturbed approach into the field note', () => {
    const at = spot({
      access: {
        distanceM: 900,
        durationS: 720,
        approximate: false,
        from: spot().position,
        approach: {
          risk: 'high',
          basis: 'direct-line',
          holdingCoverM: 184,
          assessedM: 860,
        },
      },
    });
    expect(spotApproachLabel(at)).toContain('about 180 m');
    expect(spotApproachLabel(at)).toContain('Direct off-path');
    expect(spotPlaceDraft(at, 0).notes).toContain('consider another way in');
  });

  it('saves a stand with its habitat bearing and safety caveat', () => {
    const draft = spotPlaceDraft(
      spot({
        stand: {
          maxRangeM: 150,
          vantageM: 6,
          lanes: [
            { key: 'e', label: 'E', bearing: 90, rangeM: 120 },
            { key: 'se', label: 'SE', bearing: 135, rangeM: 85 },
          ],
          aim: { label: 'SE', bearing: 135, distanceM: 115, position: { lat: 59.85, lng: 10.42 } },
          warning: 'Verify backstop.',
        },
      }),
      0,
      { targetLabel: 'Rådyrbukk' },
    );
    expect(draft.name).toBe('Rådyrbukk stand 1');
    expect(draft.lat).toBe(spot().position.lat);
    expect(draft.lng).toBe(spot().position.lng);
    expect(draft.notes).toContain('vantage +6 m');
    expect(draft.notes).toContain('Visibility rose (terrain/canopy): E 120 m · SE 85 m');
    expect(draft.notes).toContain('115 m SE');
    expect(draft.notes).toContain('Verify backstop');
    expect(draft.tags).toContain('stand');
  });

  // Four claims — direction, rose, walk-in, safety — are four statements, and
  // the notes field is free text, so newlines cost nothing.
  it('writes the reasoning as lines rather than one run-on paragraph', () => {
    const draft = spotPlaceDraft(spot({ stand: STAND }), 0, { targetLabel: 'Rådyrbukk' });
    expect(draft.notes.split('\n').length).toBeGreaterThan(2);
  });
});

describe('spotStandRecord', () => {
  const at = spot({
    stand: STAND,
    access: {
      distanceM: 900,
      durationS: 720,
      approximate: false,
      from: { lat: 59.84, lng: 10.4 },
      approach: { risk: 'caution', basis: 'mapped-route', holdingCoverM: 64, assessedM: 860 },
    },
  });

  it('structures what the prose could only describe', () => {
    const record = spotStandRecord(at, { targetLabel: 'Rådyrbukk · lokkejakt', now: 1_700_000 });
    expect(record).toMatchObject({
      kind: 'stand',
      source: 'atlas-potential',
      target: 'Rådyrbukk · lokkejakt',
      vantageM: 6,
      maxRangeM: 150,
      bandLabel: 'Prime',
      savedAt: 1_700_000,
    });
    expect(record!.lanes).toHaveLength(2);
    expect(record!.aim.bearing).toBe(135);
  });

  it('is the record the card and the map read — it must parse as one', () => {
    expect(parsePlaceStand(spotStandRecord(at))).not.toBeNull();
  });

  // The verdict judges the route's cover; the minutes are how long it takes.
  // Reading both off `approach` would have made every walk zero.
  it('takes the walk-in minutes from the access reading, not the verdict', () => {
    expect(spotStandRecord(at)!.approach).toMatchObject({
      risk: 'caution',
      walkMinutes: 12,
      approximate: false,
    });
  });

  it('records no approach when nothing routed the walk in', () => {
    expect(spotStandRecord(spot({ stand: STAND }))!.approach).toBeNull();
  });

  it('is null for fishing water — only a hunt spot is a stand', () => {
    expect(spotStandRecord(spot())).toBeNull();
    expect(spotPlaceDraft(spot(), 0).stand).toBeNull();
  });
});

describe('species carry a conditions band', () => {
  it('every fish target maps onto a band the conditions engine knows', () => {
    const known = ['trout', 'char', 'perch', 'pike'];
    for (const species of FISH_SPECIES) {
      expect(known).toContain(species.conditionsSpecies);
    }
  });
});
