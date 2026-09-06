import { describe, expect, it } from 'vitest';

import {
  elementAgeDays,
  elementEpochMs,
  freshTrains,
  launchIdOf,
  trainMembers,
  trainOf,
  TRAIN_MAX_ALTITUDE_KM,
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

/**
 * A synthetic Starlink batch, built so that the *propagated* geometry is the
 * thing under test.
 *
 * Members are given staggered epochs on purpose. CelesTrak publishes one
 * launch's elements up to 40 hours apart, and at 15.9 revolutions a day that
 * is 26 revolutions of phase between the first record and the last — so each
 * member's `MEAN_ANOMALY` is wound *backwards* from the phase it should hold
 * at `TRAIN_AT`, exactly as a real feed does. Any implementation that compares
 * stored mean anomalies across the batch sees a spread of hundreds of degrees
 * where the sky holds a neat chain.
 */
const TRAIN_AT = new Date('2026-09-06T12:00:00.000Z');

function batchMember(options: {
  index: number;
  launchId: string;
  altitudeKm: number;
  /** Along-track separation between neighbours, degrees of orbit. */
  phaseStepDeg: number;
  noradId: number;
}): SatelliteOmm {
  const { index, launchId, altitudeKm, phaseStepDeg, noradId } = options;
  const semiMajorAxis = 6371 + altitudeKm;
  const meanMotion = (86_400 / (2 * Math.PI)) * Math.sqrt(398_600.4418 / semiMajorAxis ** 3);
  // Up to 39 hours of stagger across a batch, oldest last.
  const epochOffsetHours = index * 3;
  const epoch = new Date(TRAIN_AT.getTime() - epochOffsetHours * 3_600_000);
  const phaseAtEpoch = 40 + index * phaseStepDeg - meanMotion * 360 * (epochOffsetHours / 24);
  return {
    OBJECT_NAME: `STARLINK-${38_000 + index}`,
    OBJECT_ID: `${launchId}${String.fromCharCode(65 + index)}`,
    EPOCH: epoch.toISOString().replace('Z', ''),
    MEAN_MOTION: meanMotion,
    ECCENTRICITY: 0.0001,
    INCLINATION: 53.16,
    RA_OF_ASC_NODE: 120.4,
    ARG_OF_PERICENTER: 90,
    MEAN_ANOMALY: ((phaseAtEpoch % 360) + 360) % 360,
    EPHEMERIS_TYPE: 0,
    CLASSIFICATION_TYPE: 'U',
    NORAD_CAT_ID: noradId,
    ELEMENT_SET_NO: 999,
    REV_AT_EPOCH: 120,
    BSTAR: 0.0008,
    MEAN_MOTION_DOT: 0.0001,
    MEAN_MOTION_DDOT: 0,
  };
}

/** `count` objects from one launch, evenly spaced along a shared orbit. */
function batch(options: {
  launchId: string;
  count: number;
  altitudeKm: number;
  phaseStepDeg: number;
  firstNoradId: number;
}): SatelliteOmm[] {
  return Array.from({ length: options.count }, (_, index) =>
    batchMember({
      index,
      launchId: options.launchId,
      altitudeKm: options.altitudeKm,
      phaseStepDeg: options.phaseStepDeg,
      noradId: options.firstNoradId + index,
    }),
  );
}

// 2.2 degrees of a 324 km orbit is about 250 km of ground — the spacing a
// batch a few days old actually flies at.
const FRESH = batch({
  launchId: '2026-197',
  count: 24,
  altitudeKm: 324,
  phaseStepDeg: 2.2,
  firstNoradId: 100_502,
});

const ISS_LAUNCH_GROUP: SatelliteOmm[] = [
  {
    OBJECT_NAME: 'ISS (ZARYA)',
    OBJECT_ID: '1998-067A',
    EPOCH: '2026-09-06T03:26:51.861984',
    MEAN_MOTION: 15.49001728,
    ECCENTRICITY: 0.00050232,
    INCLINATION: 51.6309,
    RA_OF_ASC_NODE: 259.4125,
    ARG_OF_PERICENTER: 112.3189,
    MEAN_ANOMALY: 247.8332,
    EPHEMERIS_TYPE: 0,
    CLASSIFICATION_TYPE: 'U',
    NORAD_CAT_ID: 25544,
    ELEMENT_SET_NO: 999,
    REV_AT_EPOCH: 58430,
    BSTAR: 0.00007453319,
    MEAN_MOTION_DOT: 0.00003658,
    MEAN_MOTION_DDOT: 0,
  },
  {
    OBJECT_NAME: 'HRC MONOBLOCK CAMERA',
    OBJECT_ID: '1998-067XR',
    EPOCH: '2026-09-05T15:47:54.136608',
    MEAN_MOTION: 15.90687243,
    ECCENTRICITY: 0.00055505,
    INCLINATION: 51.6158,
    RA_OF_ASC_NODE: 221.3922,
    ARG_OF_PERICENTER: 80.5194,
    MEAN_ANOMALY: 279.6439,
    EPHEMERIS_TYPE: 0,
    CLASSIFICATION_TYPE: 'U',
    NORAD_CAT_ID: 66052,
    ELEMENT_SET_NO: 999,
    REV_AT_EPOCH: 5073,
    BSTAR: 0.00049580233,
    MEAN_MOTION_DOT: 0.00154624,
    MEAN_MOTION_DDOT: 0.000019895955,
  },
  {
    OBJECT_NAME: 'DUPLEX',
    OBJECT_ID: '1998-067XS',
    EPOCH: '2026-09-05T05:26:33.130176',
    MEAN_MOTION: 15.68691024,
    ECCENTRICITY: 0.0004406,
    INCLINATION: 51.624,
    RA_OF_ASC_NODE: 243.485,
    ARG_OF_PERICENTER: 95.4748,
    MEAN_ANOMALY: 264.6751,
    EPHEMERIS_TYPE: 0,
    CLASSIFICATION_TYPE: 'U',
    NORAD_CAT_ID: 66906,
    ELEMENT_SET_NO: 999,
    REV_AT_EPOCH: 4319,
    BSTAR: 0.00030872,
    MEAN_MOTION_DOT: 0.00035501,
    MEAN_MOTION_DDOT: 0,
  },
  {
    OBJECT_NAME: 'KNACKSAT-2',
    OBJECT_ID: '1998-067XZ',
    EPOCH: '2026-09-06T00:03:59.009184',
    MEAN_MOTION: 15.67719918,
    ECCENTRICITY: 0.00076116,
    INCLINATION: 51.6247,
    RA_OF_ASC_NODE: 245.6941,
    ARG_OF_PERICENTER: 125.4424,
    MEAN_ANOMALY: 234.7283,
    EPHEMERIS_TYPE: 0,
    CLASSIFICATION_TYPE: 'U',
    NORAD_CAT_ID: 67683,
    ELEMENT_SET_NO: 999,
    REV_AT_EPOCH: 3292,
    BSTAR: 0.00040719387,
    MEAN_MOTION_DOT: 0.0004526,
    MEAN_MOTION_DDOT: 0,
  },
  {
    OBJECT_NAME: 'GXIBA-1',
    OBJECT_ID: '1998-067YB',
    EPOCH: '2026-09-05T05:50:02.948352',
    MEAN_MOTION: 15.7116314,
    ECCENTRICITY: 0.00083253,
    INCLINATION: 51.6226,
    RA_OF_ASC_NODE: 247.3432,
    ARG_OF_PERICENTER: 117.8806,
    MEAN_ANOMALY: 242.3036,
    EPHEMERIS_TYPE: 0,
    CLASSIFICATION_TYPE: 'U',
    NORAD_CAT_ID: 67685,
    ELEMENT_SET_NO: 999,
    REV_AT_EPOCH: 3283,
    BSTAR: 0.0004513517,
    MEAN_MOTION_DOT: 0.00058101,
    MEAN_MOTION_DDOT: 0,
  },
  {
    OBJECT_NAME: 'UITMSAT-2',
    OBJECT_ID: '1998-067YC',
    EPOCH: '2026-09-05T23:32:31.888896',
    MEAN_MOTION: 15.80734587,
    ECCENTRICITY: 0.00079682,
    INCLINATION: 51.6208,
    RA_OF_ASC_NODE: 238.7244,
    ARG_OF_PERICENTER: 88.6188,
    MEAN_ANOMALY: 271.5726,
    EPHEMERIS_TYPE: 0,
    CLASSIFICATION_TYPE: 'U',
    NORAD_CAT_ID: 67686,
    ELEMENT_SET_NO: 999,
    REV_AT_EPOCH: 3301,
    BSTAR: 0.00065468561,
    MEAN_MOTION_DOT: 0.00130125,
    MEAN_MOTION_DDOT: 0,
  },
  {
    OBJECT_NAME: 'LEOPARD',
    OBJECT_ID: '1998-067YD',
    EPOCH: '2026-09-05T05:30:41.498208',
    MEAN_MOTION: 15.714129,
    ECCENTRICITY: 0.00079961,
    INCLINATION: 51.6242,
    RA_OF_ASC_NODE: 248.0402,
    ARG_OF_PERICENTER: 88.1908,
    MEAN_ANOMALY: 272.0006,
    EPHEMERIS_TYPE: 0,
    CLASSIFICATION_TYPE: 'U',
    NORAD_CAT_ID: 67687,
    ELEMENT_SET_NO: 999,
    REV_AT_EPOCH: 3274,
    BSTAR: 0.0006141878,
    MEAN_MOTION_DOT: 0.00080326,
    MEAN_MOTION_DDOT: 0,
  },
  {
    OBJECT_NAME: 'HMU-SAT2',
    OBJECT_ID: '1998-067YE',
    EPOCH: '2026-09-05T05:27:24.106176',
    MEAN_MOTION: 15.75655416,
    ECCENTRICITY: 0.00077768,
    INCLINATION: 51.6242,
    RA_OF_ASC_NODE: 244.9889,
    ARG_OF_PERICENTER: 87.1593,
    MEAN_ANOMALY: 273.0297,
    EPHEMERIS_TYPE: 0,
    CLASSIFICATION_TYPE: 'U',
    NORAD_CAT_ID: 67688,
    ELEMENT_SET_NO: 999,
    REV_AT_EPOCH: 3278,
    BSTAR: 0.00056816358,
    MEAN_MOTION_DOT: 0.00089286,
    MEAN_MOTION_DDOT: 0,
  },
];

describe('launch trains', () => {
  it('reads the launch a batch shares out of its designators', () => {
    expect(launchIdOf({ OBJECT_ID: '2026-197A' })).toBe('2026-197');
    expect(launchIdOf({ OBJECT_ID: '2026-197BK' })).toBe('2026-197');
    expect(launchIdOf({ OBJECT_ID: '1998-067A' })).toBe('1998-067');
    expect(launchIdOf({ OBJECT_ID: 'TBA - TO BE ASSIGNED' })).toBeNull();
    expect(launchIdOf({ OBJECT_ID: '' })).toBeNull();
  });

  it('finds a batch that is still low and still nose to tail', () => {
    const trains = freshTrains(FRESH, { at: TRAIN_AT });
    expect(trains).toHaveLength(1);
    const [train] = trains;
    expect(train!.launchId).toBe('2026-197');
    expect(train!.noradIds).toHaveLength(24);
    expect(train!.noradIds[0]).toBe(100_502);
    expect(train!.altitudeKm).toBeGreaterThan(300);
    expect(train!.altitudeKm).toBeLessThan(350);
    // ~250 km at a ground speed near 7.3 km/s: half a minute between beads.
    expect(train!.spacingKm).toBeGreaterThan(200);
    expect(train!.spacingKm).toBeLessThan(300);
    expect(train!.spacingSeconds).toBeGreaterThan(25);
    expect(train!.spacingSeconds).toBeLessThan(45);
  });

  it('judges the chain on propagated positions, not on stored mean anomalies', () => {
    // The guard for the trap the fixture is built around: these elements are
    // published across 69 hours, so their stored phases are scattered right
    // round the orbit while the objects themselves fly in formation.
    const anomalies = FRESH.map((omm) => omm.MEAN_ANOMALY);
    // Scattered over more than half the orbit, where the chain itself spans
    // 24 x 2.2 = 51 degrees.
    expect(Math.max(...anomalies) - Math.min(...anomalies)).toBeGreaterThan(180);
    expect(freshTrains(FRESH, { at: TRAIN_AT })).toHaveLength(1);
  });

  it('lets go of a batch once it has spread out along the orbit', () => {
    // Same launch, same altitude, 15 degrees apart instead of 2.2 — about
    // 1750 km, three and a half minutes of sky between neighbours.
    const spread = batch({
      launchId: '2026-197',
      count: 24,
      altitudeKm: 324,
      phaseStepDeg: 15,
      firstNoradId: 100_502,
    });
    expect(freshTrains(spread, { at: TRAIN_AT })).toEqual([]);
  });

  it('lets go of a batch once it has raised to the operational shell', () => {
    const raised = batch({
      launchId: '2026-197',
      count: 24,
      altitudeKm: 470,
      phaseStepDeg: 2.2,
      firstNoradId: 100_502,
    });
    expect(freshTrains(raised, { at: TRAIN_AT })).toEqual([]);
  });

  it('does not call a handful of rideshare leftovers a train', () => {
    expect(freshTrains(FRESH.slice(0, 6), { at: TRAIN_AT })).toEqual([]);
  });

  it('keeps two launches apart even when they fly at the same height', () => {
    const other = batch({
      launchId: '2026-198',
      count: 20,
      altitudeKm: 330,
      phaseStepDeg: 2.2,
      firstNoradId: 100_600,
    });
    const trains = freshTrains([...FRESH, ...other], { at: TRAIN_AT });
    expect(trains.map((train) => train.launchId).sort()).toEqual(['2026-197', '2026-198']);
    expect(trainMembers(trains).size).toBe(44);
    expect(trainOf(trains, 100_605)?.launchId).toBe('2026-198');
    expect(trainOf(trains, 25_544)).toBeNull();
    expect(trainOf(trains, null)).toBeNull();
  });

  it('leaves the ISS and its deployed cubesats alone', () => {
    // The real 1998-067 group, fetched 2026-09-06: one designator, eight
    // objects, median altitude 356 km. It clears the count gate and the
    // altitude gate, so the spacing test is the only thing standing between a
    // purple ISS and the user — these cubesats were deployed years apart and
    // are strung right round the orbit.
    expect(ISS_LAUNCH_GROUP).toHaveLength(8);
    expect(freshTrains(ISS_LAUNCH_GROUP, { at: TRAIN_AT })).toEqual([]);
    // And it is not the altitude gate doing the work by accident.
    const altitudes = ISS_LAUNCH_GROUP.map(meanAltitudeKm).sort((a, b) => a - b);
    expect(altitudes[3]).toBeLessThan(TRAIN_MAX_ALTITUDE_KM);
  });
});
