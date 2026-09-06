import { describe, expect, it } from 'vitest';

import {
  elementAgeDays,
  elementEpochMs,
  coversGround,
  footprintRing,
  groundTrackSegments,
  horizonHalfAngleDeg,
  meanAltitudeKm,
  orbitalPeriodMinutes,
  parseOmmRecords,
  predictPasses,
  predictPassesForSet,
  splitAtAntimeridian,
  subpointAt,
  type SatelliteOmm,
} from './index.js';

/**
 * A real CelesTrak GP record, fetched 2026-09-05.
 *
 * The expectations built on it below were cross-checked once against an
 * independent tracker (api.wheretheiss.at) at the instant `AT` names: the
 * sub-point agreed to 0.8 km, the altitude and speed to the digit shown, and
 * the illumination flag agreed too. That is what makes these golden numbers
 * worth pinning — they are not merely this code's own output recorded back.
 */
const ISS: SatelliteOmm = {
  OBJECT_NAME: 'ISS (ZARYA)',
  OBJECT_ID: '1998-067A',
  EPOCH: '2026-09-05T11:57:50.773248',
  MEAN_MOTION: 15.48996812,
  ECCENTRICITY: 0.00050573,
  INCLINATION: 51.631,
  RA_OF_ASC_NODE: 262.6049,
  ARG_OF_PERICENTER: 109.4187,
  MEAN_ANOMALY: 250.7348,
  EPHEMERIS_TYPE: 0,
  CLASSIFICATION_TYPE: 'U',
  NORAD_CAT_ID: 25544,
  ELEMENT_SET_NO: 999,
  REV_AT_EPOCH: 58420,
  BSTAR: 0.000081465205,
  MEAN_MOTION_DOT: 0.0000404,
  MEAN_MOTION_DDOT: 0,
};

const AT = new Date('2026-09-05T21:50:30.000Z');
const OSLO = { lat: 59.9139, lng: 10.7522 };
const TROMSO = { lat: 69.6492, lng: 18.9553 };

describe('element sets', () => {
  it('reads a zoneless CelesTrak epoch as UTC, not local time', () => {
    // The trap: ECMAScript reads a bare date-time as local. Parsed in Oslo that
    // would shift every satellite by the UTC offset — about 55 000 km of ISS
    // track, i.e. the wrong continent, with no symptom but "it seems off".
    expect(elementEpochMs({ EPOCH: '2026-09-05T11:57:50.773248' })).toBe(
      Date.UTC(2026, 8, 5, 11, 57, 50, 773),
    );
    // An epoch that already carries a zone must not get a second one.
    expect(elementEpochMs({ EPOCH: '2026-09-05T11:57:50.773Z' })).toBe(
      Date.UTC(2026, 8, 5, 11, 57, 50, 773),
    );
  });

  it('measures element age in days', () => {
    const sixHoursLater = elementEpochMs(ISS) + 6 * 3_600_000;
    expect(elementAgeDays(ISS, sixHoursLater)).toBeCloseTo(0.25, 6);
    // A future epoch is not negative age.
    expect(elementAgeDays(ISS, elementEpochMs(ISS) - 86_400_000)).toBe(0);
  });

  it('drops malformed records instead of failing the whole set', () => {
    const parsed = parseOmmRecords([
      ISS,
      { ...ISS, NORAD_CAT_ID: 40000, MEAN_MOTION: null },
      { ...ISS, NORAD_CAT_ID: 40001, EPOCH: 'not a date' },
      { ...ISS, NORAD_CAT_ID: 40002, MEAN_MOTION: 0 },
      { ...ISS, OBJECT_NAME: '  ' },
      null,
      'nonsense',
    ]);
    expect(parsed.map((p) => p.NORAD_CAT_ID)).toEqual([25544]);
  });

  it('de-duplicates objects that appear in more than one group', () => {
    // The ISS is in both `stations` and `visual`; merging the two sets must not
    // draw it twice or predict every pass twice.
    expect(parseOmmRecords([ISS, { ...ISS }])).toHaveLength(1);
  });

  it('tags records with the group they came from, first tag winning', () => {
    const stations = parseOmmRecords([ISS], 'stations');
    expect(stations[0]!.ATLAS_GROUP).toBe('stations');

    // The backend re-parses the merged list to de-duplicate. The ISS is in both
    // `stations` and `visual`; it must come out of that pass still a station,
    // because that tag is what earns it a label and a drawn ground track.
    const visual = parseOmmRecords([ISS], 'visual');
    const merged = parseOmmRecords([...stations, ...visual]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.ATLAS_GROUP).toBe('stations');

    // An untagged set stays untagged rather than inventing a group.
    expect(parseOmmRecords([ISS])[0]!.ATLAS_GROUP).toBeUndefined();
  });

  it('carries the group through to a fix, for the clients to style on', () => {
    const tagged = parseOmmRecords([ISS], 'stations')[0]!;
    expect(subpointAt(tagged, AT)!.group).toBe('stations');
  });

  it('rejects an array-shaped nothing', () => {
    expect(parseOmmRecords(null)).toEqual([]);
    expect(parseOmmRecords({ error: 'rate limited' })).toEqual([]);
  });

  it('derives period and altitude from mean motion', () => {
    expect(orbitalPeriodMinutes(ISS)).toBeCloseTo(92.96, 2);
    expect(meanAltitudeKm(ISS)).toBeCloseTo(426.8, 1);
    expect(horizonHalfAngleDeg(meanAltitudeKm(ISS))).toBeCloseTo(20.41, 2);
  });
});

describe('propagation', () => {
  it('puts the ISS where an independent tracker puts it', () => {
    const fix = subpointAt(ISS, AT)!;
    expect(fix).not.toBeNull();
    expect(fix.lat).toBeCloseTo(32.6043, 3);
    expect(fix.lng).toBeCloseTo(97.6928, 3);
    expect(fix.altitudeKm).toBeCloseTo(418.53, 1);
    expect(fix.speedKmS).toBeCloseTo(7.6662, 3);
    expect(fix.sunlit).toBe(true);
    expect(fix.noradId).toBe(25544);
  });

  it('never leaves the latitude band its inclination allows', () => {
    for (let minutes = 0; minutes < 95; minutes += 5) {
      const fix = subpointAt(ISS, new Date(AT.getTime() + minutes * 60_000))!;
      expect(Math.abs(fix.lat)).toBeLessThanOrEqual(ISS.INCLINATION + 0.5);
      expect(fix.lng).toBeGreaterThanOrEqual(-180);
      expect(fix.lng).toBeLessThan(180);
    }
  });

  it('is in sunlight for most, but not all, of an orbit', () => {
    // A satellite permanently lit or permanently dark means the eclipse test is
    // wired wrong — the failure mode that silently empties a pass list.
    let lit = 0;
    const samples = 60;
    for (let i = 0; i < samples; i++) {
      if (subpointAt(ISS, new Date(AT.getTime() + i * 90_000))!.sunlit) lit++;
    }
    expect(lit).toBeGreaterThan(samples * 0.4);
    expect(lit).toBeLessThan(samples);
  });

  it('draws a ground track as segments cut at the antimeridian', () => {
    const segments = groundTrackSegments(ISS, { at: AT, revolutions: 1, stepSeconds: 30 });
    expect(segments.length).toBeGreaterThan(0);
    for (const segment of segments) {
      for (let i = 1; i < segment.length; i++) {
        // The whole point: no step inside a segment may jump the map.
        expect(Math.abs(segment[i]![0] - segment[i - 1]![0])).toBeLessThanOrEqual(180);
      }
    }
  });
});

describe('antimeridian splitting', () => {
  it('cuts a crossing and lands both halves on the edge at one latitude', () => {
    const segments = splitAtAntimeridian([
      [170, 10],
      [179, 12],
      [-179, 13],
      [-170, 15],
    ]);
    expect(segments).toHaveLength(2);
    const first = segments[0]!;
    const second = segments[1]!;
    expect(first[first.length - 1]![0]).toBe(180);
    expect(second[0]![0]).toBe(-180);
    // Same point, approached from both sides — the track must not step in
    // latitude across the seam.
    expect(first[first.length - 1]![1]).toBeCloseTo(second[0]![1], 10);
    expect(first[first.length - 1]![1]).toBeCloseTo(12.5, 1);
  });

  it('leaves a track that never crosses in one piece', () => {
    const points: [number, number][] = [
      [10, 59],
      [11, 60],
      [12, 61],
    ];
    expect(splitAtAntimeridian(points)).toEqual([points]);
  });

  it('handles a westbound crossing too', () => {
    const segments = splitAtAntimeridian([
      [-175, 5],
      [175, 5],
    ]);
    expect(segments).toHaveLength(2);
    expect(segments[0]![segments[0]!.length - 1]![0]).toBe(-180);
    expect(segments[1]![0]![0]).toBe(180);
  });

  it('has nothing to split in a degenerate run', () => {
    expect(splitAtAntimeridian([])).toEqual([]);
    expect(splitAtAntimeridian([[10, 10]])).toEqual([[[10, 10]]]);
  });
});

describe('footprint', () => {
  const km = (a: [number, number], b: [number, number]) => {
    const r = Math.PI / 180;
    const x =
      Math.sin(((b[1] - a[1]) * r) / 2) ** 2 +
      Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(((b[0] - a[0]) * r) / 2) ** 2;
    return 2 * 6371 * Math.asin(Math.sqrt(x));
  };

  it('is a closed ring about 2250 km across the ground for the ISS', () => {
    const fix = subpointAt(ISS, AT)!;
    const ring = footprintRing(fix);
    expect(ring[0]).toEqual(ring[ring.length - 1]);
    // Independently reported as a 4500 km diameter by api.wheretheiss.at.
    for (const point of ring) expect(km([fix.lng, fix.lat], point)).toBeCloseTo(2250, -2);
  });

  it('shrinks to the elevation floor the pass list actually uses', () => {
    // The whole reason the mask is plumbed through: a 10° circle is not a
    // detail smaller than the 0° one, it is little more than half the radius,
    // and it is the one that matches the list drawn beside it.
    const fix = subpointAt(ISS, AT)!;
    for (const point of footprintRing(fix, { minElevationDeg: 10 })) {
      expect(km([fix.lng, fix.lat], point)).toBeCloseTo(1390, -2);
    }
  });

  it('collapses only at a floor no point but the sub-point can clear', () => {
    // 89.999 deg still leaves a real (tiny) circle — the honest boundary is 90.
    const fix = subpointAt(ISS, AT)!;
    expect(footprintRing(fix, { minElevationDeg: 89.999 }).length).toBeGreaterThan(8);
    expect(footprintRing(fix, { minElevationDeg: 90 })).toEqual([]);
  });

  it('closes over the pole instead of refusing to draw there', () => {
    // The Arctic case, which for a polar orbit is most revolutions — and so
    // the case Norway sees. Every meridian is inside the circle, so the ring
    // sweeps a full turn of longitude and the polygon is closed across the cap.
    const polar = { ...subpointAt(ISS, AT)!, lat: 88, lng: 0 };
    const ring = footprintRing(polar);
    expect(ring.length).toBeGreaterThan(8);
    expect(ring[0]).toEqual(ring[ring.length - 1]);
    expect(ring.some(([, lat]) => lat === 90)).toBe(true);
    const longitudes = ring.map(([lng]) => lng);
    expect(Math.max(...longitudes) - Math.min(...longitudes)).toBeGreaterThanOrEqual(360);
  });

  it('keeps longitudes continuous across the antimeridian', () => {
    // Normalising each vertex into [-180, 180) here is what turns the ring
    // inside out and fills the other 358° of the planet.
    const fix = { ...subpointAt(ISS, AT)!, lat: 0, lng: 179 };
    const ring = footprintRing(fix);
    for (let i = 1; i < ring.length; i++) {
      expect(Math.abs(ring[i]![0] - ring[i - 1]![0])).toBeLessThan(10);
    }
    expect(Math.max(...ring.map(([lng]) => lng))).toBeGreaterThan(180);
  });

  it('agrees with the overhead test the badge reads from', () => {
    const fix = subpointAt(ISS, AT)!;
    // On the rim by construction, so both sides of it must answer correctly.
    expect(coversGround(fix, { lat: fix.lat, lng: fix.lng })).toBe(true);
    // Vertex 0 sits due north of the sub-point, so nudging past its latitude
    // steps straight out of the circle.
    const north = footprintRing(fix)[0]!;
    expect(coversGround(fix, { lat: north[1] - 0.01, lng: north[0] })).toBe(true);
    expect(coversGround(fix, { lat: north[1] + 0.01, lng: north[0] })).toBe(false);
    expect(coversGround(fix, { lat: fix.lat, lng: fix.lng }, 90)).toBe(false);
  });
});

describe('visible passes', () => {
  it('finds evening-twilight ISS passes over Oslo', () => {
    const passes = predictPasses(ISS, OSLO, {
      from: new Date('2026-09-12T00:00:00Z'),
      hours: 48,
      minElevationDeg: 10,
    });
    expect(passes.length).toBeGreaterThan(0);
    for (const pass of passes) {
      expect(pass.sunlit).toBe(true);
      expect(pass.darkSky).toBe(true);
      expect(pass.maxElevationDeg).toBeGreaterThanOrEqual(10);
      expect(Date.parse(pass.start)).toBeLessThan(Date.parse(pass.peak));
      expect(Date.parse(pass.peak)).toBeLessThan(Date.parse(pass.end));
      // Both crossings are refined. The old falling-edge bug returned the
      // previous 30-second scan sample verbatim for every set time.
      expect(Date.parse(pass.end) % 30_000).not.toBe(0);
      expect(pass.durationSeconds).toBeGreaterThan(0);
      // A pass is minutes, not hours — a wider bracket means the scanner
      // merged two passes into one.
      expect(pass.durationSeconds).toBeLessThan(15 * 60);
      // The ISS is the one object with a standard magnitude worth quoting.
      expect(pass.magnitude).toBeLessThan(0);
    }
  });

  it('reports unlit passes as invisible rather than hiding the geometry', () => {
    const from = new Date('2026-09-05T12:00:00Z');
    const visible = predictPasses(ISS, OSLO, { from, hours: 120, minElevationDeg: 10 });
    const all = predictPasses(ISS, OSLO, {
      from,
      hours: 120,
      minElevationDeg: 10,
      visibleOnly: false,
      limit: 100,
    });
    // This window is a real visibility gap: the ISS crosses Oslo's night sky
    // repeatedly and is in Earth's shadow every time.
    expect(all.length).toBeGreaterThan(0);
    expect(visible).toHaveLength(0);
    expect(all.every((pass) => !pass.sunlit)).toBe(true);
  });

  it('knows the ISS never rises usefully over Tromso', () => {
    // Inclination 51.6° puts the ground track 18° south of Tromso at closest,
    // which is a graze along the horizon and never an observable pass. This is
    // why Atlas ships the polar-orbit `visual` set and not the ISS alone.
    const grazes = predictPasses(ISS, TROMSO, {
      from: new Date('2026-09-05T12:00:00Z'),
      hours: 168,
      minElevationDeg: 0,
      visibleOnly: false,
      limit: 100,
    });
    expect(grazes.length).toBeGreaterThan(0);
    expect(Math.max(...grazes.map((p) => p.maxElevationDeg))).toBeLessThan(5);

    const usable = predictPasses(ISS, TROMSO, {
      from: new Date('2026-09-05T12:00:00Z'),
      hours: 168,
      minElevationDeg: 10,
      visibleOnly: false,
    });
    expect(usable).toHaveLength(0);
  });

  it('skips orbits that can never reach the observer', () => {
    // A 28° orbit is below the horizon from Oslo permanently, so the scan must
    // not be run at all rather than run and find nothing.
    const equatorial = { ...ISS, NORAD_CAT_ID: 99001, INCLINATION: 28 };
    expect(
      predictPasses(equatorial, OSLO, { from: AT, hours: 48, visibleOnly: false }),
    ).toHaveLength(0);
  });

  it('merges a set into one time-ordered list', () => {
    const tiangong: SatelliteOmm = {
      ...ISS,
      OBJECT_NAME: 'CSS (TIANHE)',
      OBJECT_ID: '2021-035A',
      NORAD_CAT_ID: 48274,
      EPOCH: '2026-09-05T11:49:14.964384',
      MEAN_MOTION: 15.59601072,
      ECCENTRICITY: 0.00023054,
      INCLINATION: 41.4675,
      RA_OF_ASC_NODE: 194.4869,
      ARG_OF_PERICENTER: 258.4916,
      MEAN_ANOMALY: 101.5663,
      BSTAR: 0.0001751281,
      MEAN_MOTION_DOT: 0.00014037,
    };
    const merged = predictPassesForSet([ISS, tiangong], OSLO, {
      from: new Date('2026-09-12T00:00:00Z'),
      hours: 72,
      minElevationDeg: 10,
      visibleOnly: false,
      limit: 30,
    });
    expect(merged.length).toBeGreaterThan(1);
    for (let i = 1; i < merged.length; i++) {
      expect(Date.parse(merged[i]!.start)).toBeGreaterThanOrEqual(Date.parse(merged[i - 1]!.start));
    }
  });

  it('declines elements SGP4 cannot initialise', () => {
    const broken = { ...ISS, NORAD_CAT_ID: 99002, ECCENTRICITY: 1.5 };
    expect(subpointAt(broken, AT)).toBeNull();
    expect(groundTrackSegments(broken)).toEqual([]);
    expect(predictPasses(broken, OSLO, { from: AT, hours: 24 })).toEqual([]);
  });
});
