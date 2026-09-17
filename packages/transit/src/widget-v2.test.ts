import { describe, expect, it } from 'vitest';
import { norwayInstant } from './clock.js';
import { commuteJourney } from './dashboard.js';
import type { TransitCommuteQuery, TransitLeg, TransitResult, TransitTrip } from './model.js';
import {
  commuteCommitHolds,
  commuteCommitId,
  commuteCommitKey,
  commuteCommitQuery,
  findCommittedTrip,
  commutePlaceAt,
  commuteSpliceTrip,
  commuteSubstituteQuery,
  commuteSubstituteTrip,
  commuteWidgetV2Queries,
  commuteConnectionBreak,
  commuteDirectionPinReleaseMs,
  commuteJourneyProgress,
  commuteSelectorOptions,
  commuteWidgetV2Board,
  resolveCommuteV2Directions,
  type TransitWidgetV2Commit,
} from './widget-v2.js';

/**
 * The v2 widget's own suite. v1's is beside it and stays there: the two boards
 * are different products (docs/TRANSIT.md §W1–§W7), and one file testing both is how a
 * change made for v2 quietly starts constraining the widget that is still the
 * fallback.
 */

const DAY = { year: 2026, month: 6, day: 30 }; // Thursday, summer time.
const at = (minutesOfDay: number) => norwayInstant(DAY.year, DAY.month, DAY.day, minutesOfDay);
const hm = (h: number, m: number) => at(h * 60 + m);

const place = (name: string, quay?: string) => ({
  name,
  position: { lat: 59.9, lng: 10.6 },
  ...(quay ? { quay: { publicCode: quay } } : {}),
});

function ride({
  line,
  from,
  to,
  startMs,
  endMs,
  delayMs = 0,
  quay,
  actualStartMs,
  actualEndMs,
}: {
  line: string;
  from: string;
  to: string;
  startMs: number;
  endMs: number;
  delayMs?: number;
  quay?: string;
  actualStartMs?: number;
  actualEndMs?: number;
}): TransitLeg {
  return {
    mode: line.startsWith('R') ? 'rail' : 'bus',
    distanceM: 8_000,
    durationMs: endMs - startMs,
    aimedStartMs: startMs,
    expectedStartMs: startMs + delayMs,
    aimedEndMs: endMs,
    expectedEndMs: endMs + delayMs,
    realtime: delayMs !== 0,
    from: place(from, quay),
    to: place(to),
    line: { id: `X:Line:${line}`, publicCode: line },
    intermediateStops: [],
    points: [],
    situations: [],
    ...(actualStartMs !== undefined ? { actualStartMs } : {}),
    ...(actualEndMs !== undefined ? { actualEndMs } : {}),
  };
}

function change(fromMs: number, toMs: number): TransitLeg {
  return {
    mode: 'foot',
    distanceM: 120,
    durationMs: toMs - fromMs,
    aimedStartMs: fromMs,
    expectedStartMs: fromMs,
    aimedEndMs: toMs,
    expectedEndMs: toMs,
    realtime: false,
    from: place('Asker stasjon'),
    to: place('Asker stasjon'),
    intermediateStops: [],
    points: [],
    situations: [],
  };
}

const trip = (...legs: TransitLeg[]): TransitTrip => ({
  startMs: legs[0]!.expectedStartMs,
  endMs: legs[legs.length - 1]!.expectedEndMs,
  durationMs: legs[legs.length - 1]!.expectedEndMs - legs[0]!.expectedStartMs,
  walkDistanceM: 120,
  legs,
});

/** The corridor these tests are about: bus to Asker, train to town. */
function twoLegTrip(over: { delayMs?: number; actualStartMs?: number; actualEndMs?: number } = {}) {
  return trip(
    ride({
      line: '280',
      from: 'Engelsrud',
      to: 'Asker stasjon',
      startMs: hm(7, 10),
      endMs: hm(7, 32),
      quay: '2',
      ...(over.delayMs !== undefined ? { delayMs: over.delayMs } : {}),
      ...(over.actualStartMs !== undefined ? { actualStartMs: over.actualStartMs } : {}),
      ...(over.actualEndMs !== undefined ? { actualEndMs: over.actualEndMs } : {}),
    }),
    change(hm(7, 32), hm(7, 34)),
    ride({
      line: 'R14',
      from: 'Asker stasjon',
      to: 'Nationaltheatret',
      startMs: hm(7, 41),
      endMs: hm(8, 14),
      quay: '3',
    }),
  );
}

const commute = (over: Partial<TransitCommuteQuery> = {}): TransitCommuteQuery => ({
  from: { name: 'Engelsrud', lat: 59.82, lng: 10.37 },
  via: [{ name: 'Asker stasjon', lat: 59.83, lng: 10.43 }],
  to: { name: 'Nationaltheatret', lat: 59.91, lng: 10.73 },
  filter: { select: [], exclude: [], modes: [] },
  outboundTime: { minutesOfDay: 7 * 60, arriveBy: false },
  inboundTime: { minutesOfDay: 16 * 60, arriveBy: false },
  days: [1, 2, 3, 4, 5],
  ...over,
});

const result = (...trips: TransitTrip[]): TransitResult => ({ trips, problems: [] });

// ------------------------------------------------------------ the ladder ---

describe('commuteJourneyProgress — TRANSIT.md §W2', () => {
  it('is a plain timetable read before anything has happened', () => {
    const journey = commuteJourney(twoLegTrip(), hm(6, 30));
    expect(commuteJourneyProgress(journey, hm(6, 30))).toEqual({
      phase: 'upcoming',
      rideIndex: 0,
      source: 'clock',
    });
  });

  it('says "go" inside the boarding lead', () => {
    const journey = commuteJourney(twoLegTrip(), hm(7, 4));
    expect(commuteJourneyProgress(journey, hm(7, 4)).phase).toBe('boarding');
  });

  it('walks the ladder on the clock alone — tier 3, no sensor and no permission', () => {
    const journey = commuteJourney(twoLegTrip(), hm(7, 0));
    const phaseAt = (ms: number) => commuteJourneyProgress(journey, ms);
    expect(phaseAt(hm(7, 20))).toEqual({ phase: 'riding', rideIndex: 0, source: 'clock' });
    expect(phaseAt(hm(7, 36))).toEqual({ phase: 'interchange', rideIndex: 1, source: 'clock' });
    expect(phaseAt(hm(7, 50))).toEqual({ phase: 'riding', rideIndex: 1, source: 'clock' });
    expect(phaseAt(hm(8, 20))).toEqual({ phase: 'arrived', rideIndex: 1, source: 'clock' });
  });

  it('prefers the published record over the clock — tier 2 outranks tier 3', () => {
    // The 280 is on the record as having left at 07:12 and reached Asker at
    // 07:35. At 07:33 the clock alone would still say "on the bus".
    const journey = commuteJourney(
      twoLegTrip({ actualStartMs: hm(7, 12), actualEndMs: hm(7, 30) }),
      hm(7, 33),
    );
    expect(commuteJourneyProgress(journey, hm(7, 33))).toEqual({
      phase: 'interchange',
      rideIndex: 1,
      source: 'record',
    });
  });

  it('does not read a missing record as "the bus is still standing there"', () => {
    // Absence is not evidence: most services publish an actual time and one with
    // no live feed never will, so the clock still decides.
    const journey = commuteJourney(twoLegTrip(), hm(7, 20));
    expect(commuteJourneyProgress(journey, hm(7, 20)).phase).toBe('riding');
    expect(commuteJourneyProgress(journey, hm(7, 20)).source).toBe('clock');
  });

  it('does not claim a departure the record puts in the future', () => {
    const journey = commuteJourney(twoLegTrip({ actualStartMs: hm(7, 12) }), hm(7, 11));
    expect(commuteJourneyProgress(journey, hm(7, 11)).phase).toBe('boarding');
  });
});

// ------------------------------------------------------------- the break ---

describe('commuteConnectionBreak — TRANSIT.md §W4', () => {
  it('says nothing about a change that still holds', () => {
    const journey = commuteJourney(twoLegTrip(), hm(7, 0));
    expect(commuteConnectionBreak(journey, hm(7, 20))).toBeNull();
  });

  it('breaks the change when the numbers say so, not when a sensor does', () => {
    // The bus is 12 minutes down: 07:44 at Asker, and the 07:41 train is gone.
    const journey = commuteJourney(twoLegTrip({ delayMs: 12 * 60_000 }), hm(7, 20));
    const broken = commuteConnectionBreak(journey, hm(7, 30));
    expect(broken?.index).toBe(1);
    expect(broken?.at).toBe('Asker stasjon');
    expect(broken?.label).toBe('Connection missed');
    // The two numbers that say so, so the widget never asserts it bare.
    expect(broken?.detail).toBe('07:44 arrival misses the 07:41');
    // 07:44 + the planner's own 2 min change against a 07:41 departure.
    expect(broken?.shortfallMs).toBe(5 * 60_000);
  });

  it('stops warning once the connection is history', () => {
    // The same delayed bus, read after the train has left with the traveller on
    // it: re-announcing a change already made is how a widget cries wolf.
    const journey = commuteJourney(twoLegTrip({ delayMs: 12 * 60_000 }), hm(7, 20));
    expect(commuteConnectionBreak(journey, hm(7, 50))).toBeNull();
  });

  it('counts a change with no slack at all as broken', () => {
    const journey = commuteJourney(
      trip(
        ride({ line: '280', from: 'Engelsrud', to: 'Asker', startMs: hm(7, 10), endMs: hm(7, 32) }),
        ride({ line: 'R14', from: 'Asker', to: 'Oslo', startMs: hm(7, 32), endMs: hm(8, 14) }),
      ),
      hm(7, 0),
    );
    expect(commuteConnectionBreak(journey, hm(7, 0))?.shortfallMs).toBe(60_000);
  });
});

// -------------------------------------------------------- the substitute ---

describe('the substitute journey — TRANSIT.md §W4', () => {
  /** The 280 twelve minutes down, so the 07:41 at Asker is gone. */
  const brokenJourney = () => commuteJourney(twoLegTrip({ delayMs: 12 * 60_000 }), hm(7, 20));
  const brokenAt = (nowMs: number) => commuteConnectionBreak(brokenJourney(), nowMs)!;
  /** The train that replaces it: the next one Asker offers towards town. */
  const substituteTrip = () =>
    trip(
      ride({
        line: 'R11',
        from: 'Asker stasjon',
        to: 'Nationaltheatret',
        startMs: hm(7, 57),
        endMs: hm(8, 30),
        quay: '3',
      }),
    );

  it('asks from the interchange to the destination, on the corridor own stops', () => {
    const query = commuteSubstituteQuery(
      commute(),
      'outbound',
      brokenJourney(),
      brokenAt(hm(7, 30)),
      hm(7, 30),
    )!;
    // The commute's own `via`, which carries a stopId — not the leg's bare
    // coordinates, which are a point near one of Asker's entrances.
    expect(query.from).toEqual(commute().via[0]);
    expect(query.to).toEqual(commute().to);
    expect(query.limit).toBe(3);
    // 07:44 at Asker plus the planner's own two-minute change: the same
    // arithmetic the break itself did, so the question cannot be about a moment
    // the warning did not mean.
    expect(query.dateTimeMs).toBe(hm(7, 46));
  });

  it('never asks about a departure that has already gone', () => {
    // Read at 08:10, half an hour after the missed change: anchoring on the
    // original arrival would return journeys nobody can still catch.
    const query = commuteSubstituteQuery(
      commute(),
      'outbound',
      brokenJourney(),
      brokenAt(hm(7, 30)),
      hm(8, 10),
    )!;
    expect(query.dateTimeMs).toBe(hm(8, 10));
  });

  it('leaves the rest of the corridor as vias, rather than knowing about Asker', () => {
    const corridor = commute({
      via: [
        { name: 'Asker stasjon', lat: 59.83, lng: 10.43 },
        { name: 'Sandvika', lat: 59.89, lng: 10.52 },
      ],
    });
    const query = commuteSubstituteQuery(
      corridor,
      'outbound',
      brokenJourney(),
      brokenAt(hm(7, 30)),
      hm(7, 30),
    )!;
    expect(query.via).toEqual([corridor.via[1]]);
    expect(query.to).toEqual(corridor.to);
  });

  it('re-plans the way home from the same interchange, reversed', () => {
    const query = commuteSubstituteQuery(
      commute(),
      'inbound',
      brokenJourney(),
      brokenAt(hm(7, 30)),
      hm(7, 30),
    )!;
    expect(query.from).toEqual(commute().via[0]);
    expect(query.to).toEqual(commute().from);
  });

  it('picks the earliest catchable journey out of a ranked answer', () => {
    // Entur ranks rather than orders, so the first trip is not the earliest —
    // the same trap `findCommittedTrip` walks `commuteJourneyList` for.
    const late = substituteTrip();
    const early = trip(
      ride({
        line: 'R12',
        from: 'Asker stasjon',
        to: 'Nationaltheatret',
        startMs: hm(7, 50),
        endMs: hm(8, 26),
      }),
    );
    const tooEarly = trip(
      ride({
        line: 'R13',
        from: 'Asker stasjon',
        to: 'Nationaltheatret',
        startMs: hm(7, 41),
        endMs: hm(8, 14),
      }),
    );
    expect(
      commuteSubstituteTrip(result(late, tooEarly, early), hm(7, 46), hm(7, 30))?.legs[0]?.line
        ?.publicCode,
    ).toBe('R12');
    // Nothing after the floor is a real outcome, not a failure to report.
    expect(commuteSubstituteTrip(result(tooEarly), hm(7, 46), hm(7, 30))).toBeNull();
    expect(commuteSubstituteTrip(result(), hm(7, 46), hm(7, 30))).toBeNull();
  });

  it('splices the substitute onto the legs already travelled', () => {
    const spliced = commuteSpliceTrip(twoLegTrip({ delayMs: 12 * 60_000 }), substituteTrip(), 1)!;
    // The bus that was ridden, the walk across the platform that still happens,
    // then the train that replaced the one nobody caught.
    expect(spliced.legs.map((leg) => leg.line?.publicCode ?? leg.mode)).toEqual([
      '280',
      'foot',
      'R11',
    ]);
    expect(spliced.startMs).toBe(hm(7, 10));
    expect(spliced.endMs).toBe(hm(8, 30));
    expect(spliced.durationMs).toBe(hm(8, 30) - hm(7, 10));
    // Recomputed from the legs that survived, not carried over from either half.
    expect(spliced.walkDistanceM).toBe(120);
    expect(spliced.co2Grams).toBeUndefined();
    // The commitment still names the journey it was made about: the first
    // ride's scheduled departure and line are untouched, so the pin holds.
    expect(commuteCommitId('outbound', commuteJourney(spliced, hm(7, 50)))).toBe(
      commuteCommitId('outbound', commuteJourney(twoLegTrip(), hm(7, 50))),
    );
  });

  it('has nothing to splice onto a journey with no ride before the break', () => {
    expect(commuteSpliceTrip(twoLegTrip(), substituteTrip(), 0)).toBeNull();
    expect(commuteSpliceTrip(twoLegTrip(), { ...substituteTrip(), legs: [] }, 1)).toBeNull();
    expect(commuteSpliceTrip(twoLegTrip(), substituteTrip(), 4)).toBeNull();
  });

  it('stops the ladder reading "riding" off a vehicle nobody boarded', () => {
    // The trap this whole design exists for: the *original* 07:41 leaves on
    // time and publishes its own record, while the traveller is still on a bus
    // that has not reached Asker. Tier 2 is the strongest rung of the ladder,
    // so it says "riding" — confidently, with the operator behind it.
    const committed = trip(
      ride({
        line: '280',
        from: 'Engelsrud',
        to: 'Asker stasjon',
        startMs: hm(7, 10),
        endMs: hm(7, 32),
        delayMs: 12 * 60_000,
        quay: '2',
      }),
      change(hm(7, 32), hm(7, 34)),
      ride({
        line: 'R14',
        from: 'Asker stasjon',
        to: 'Nationaltheatret',
        startMs: hm(7, 41),
        endMs: hm(8, 14),
        actualStartMs: hm(7, 41),
        actualEndMs: hm(8, 14),
        quay: '3',
      }),
    );
    expect(commuteJourneyProgress(commuteJourney(committed, hm(7, 50)), hm(7, 50))).toEqual({
      phase: 'riding',
      rideIndex: 1,
      source: 'record',
    });
    // Replacing the journey the ladder runs on — rather than teaching the
    // ladder about substitutions — makes every derivation right at once.
    const spliced = commuteSpliceTrip(committed, substituteTrip(), 1)!;
    expect(commuteJourneyProgress(commuteJourney(spliced, hm(7, 50)), hm(7, 50)).phase).toBe(
      'interchange',
    );
  });

  it('expires the commitment at the arrival the traveller will actually make', () => {
    const spliced = commuteSpliceTrip(twoLegTrip({ delayMs: 12 * 60_000 }), substituteTrip(), 1)!;
    const late = hm(8, 40);
    // The original journey is over and its commitment has let go; the one the
    // traveller is on has not arrived yet.
    expect(commuteCommitHolds(commuteJourney(twoLegTrip(), late), late)).toBe(false);
    expect(commuteCommitHolds(commuteJourney(spliced, late), late)).toBe(true);
  });

  it('says the connection was replaced where it said it was missed', () => {
    const spliced = commuteSpliceTrip(twoLegTrip({ delayMs: 12 * 60_000 }), substituteTrip(), 1)!;
    const commit: TransitWidgetV2Commit = {
      direction: 'outbound',
      departureMs: hm(7, 10),
      line: '280',
    };
    const board = (over: Parameters<typeof commuteWidgetV2Board>[0]) =>
      commuteWidgetV2Board(over).focus.alert;
    const shared = {
      query: commute(),
      results: [
        { key: 'outbound' as const, result: result(twoLegTrip()), emptyReason: 'none' as const },
      ],
      resolution: resolveCommuteV2Directions({
        query: commute(),
        selector: 'outbound' as const,
        pinnedAtMs: 0,
        commit,
        place: null,
        nowMs: hm(7, 38),
      }),
      selector: 'outbound' as const,
      commit,
      // Before the 07:41 leaves: past it the change is history rather than a
      // warning, which is a rule of the break itself.
      nowMs: hm(7, 38),
    };
    // Before: the warning, which is the half that must never be wrong.
    expect(board({ ...shared, committedTrip: twoLegTrip({ delayMs: 12 * 60_000 }) })).toBe(
      'Connection missed at Asker stasjon — 07:44 arrival misses the 07:41',
    );
    // After: which vehicle takes them on, in the same slot.
    expect(
      board({
        ...shared,
        committedTrip: spliced,
        replaced: { at: 'Asker stasjon', index: 1 },
      }),
    ).toBe('Connection replaced at Asker stasjon — 07:57 R11, 25 min change');
  });
});

// ---------------------------------------------------------- the selector ---

describe('the direction selector — TRANSIT.md §W1', () => {
  it('offers the same three modes as the commute panel', () => {
    expect(commuteSelectorOptions(commute())).toEqual([
      { key: 'outbound', label: 'Engelsrud → Nationaltheatret', short: 'OUTBOUND' },
      {
        key: 'interchange',
        label: 'Departures from the interchange',
        short: 'INTERCHANGE',
      },
      { key: 'inbound', label: 'Nationaltheatret → Engelsrud', short: 'RETURN' },
    ]);
  });

  it('omits interchange when the commute has no saved change', () => {
    expect(commuteSelectorOptions(commute({ via: [] })).map((option) => option.key)).toEqual([
      'outbound',
      'inbound',
    ]);
  });

  it('releases a pin when the other direction`s window opens', () => {
    const pinnedAt = hm(7, 30);
    // Pinned outbound in the morning: the way home at 16:00 is what ends it.
    expect(commuteDirectionPinReleaseMs(commute(), 'outbound', pinnedAt)).toBe(hm(16, 0));
  });

  it('falls back to the end of the service day when the commute saves no times', () => {
    const query = commute({ inboundTime: { minutesOfDay: null, arriveBy: false } });
    const release = commuteDirectionPinReleaseMs(query, 'outbound', hm(7, 30));
    // 03:00 the next morning — a night bus at 00:40 belongs to the evening it
    // started, so a pin may not release under someone standing at a stop.
    expect(release).toBe(norwayInstant(DAY.year, DAY.month, DAY.day + 1, 3 * 60));
  });

  it('lets a manual choice win, and lets it expire', () => {
    const query = commute();
    const held = resolveCommuteV2Directions({
      query,
      selector: 'outbound',
      pinnedAtMs: hm(7, 30),
      commit: null,
      place: null,
      nowMs: hm(8, 0),
    });
    expect(held).toEqual({
      directions: ['outbound'],
      reason: 'pinned',
      pin: { direction: 'outbound', releasesAtMs: hm(16, 0) },
    });
    // Past its release the pin is not re-applied: the clock takes over rather
    // than the widget silently holding a direction that is wrong all afternoon.
    const expired = resolveCommuteV2Directions({
      query,
      selector: 'outbound',
      pinnedAtMs: hm(7, 30),
      commit: null,
      place: null,
      nowMs: hm(17, 0),
    });
    expect(expired.reason).toBe('clock');
    expect(expired.pin).toBeNull();
    // The way home pinned in the morning has no *other* window left today, so it
    // holds to the end of the service day instead — the two halves of §W1's rule.
    const untilDayEnd = resolveCommuteV2Directions({
      query,
      selector: 'inbound',
      pinnedAtMs: hm(7, 30),
      commit: null,
      place: null,
      nowMs: hm(8, 0),
    });
    expect(untilDayEnd.pin?.releasesAtMs).toBe(
      norwayInstant(DAY.year, DAY.month, DAY.day + 1, 3 * 60),
    );
  });

  it('lets a commitment outrank the clock, and the clock decide when nothing else can', () => {
    const query = commute();
    const commit: TransitWidgetV2Commit = {
      direction: 'inbound',
      departureMs: hm(7, 10),
      line: '280',
    };
    expect(
      resolveCommuteV2Directions({
        query,
        selector: 'auto',
        pinnedAtMs: 0,
        commit,
        place: null,
        nowMs: hm(7, 20),
      }),
    ).toEqual({ directions: ['inbound'], reason: 'committed', pin: null });
    expect(
      resolveCommuteV2Directions({
        query,
        selector: 'auto',
        pinnedAtMs: 0,
        commit: null,
        place: null,
        nowMs: hm(6, 30),
      }),
    ).toEqual({ directions: ['outbound'], reason: 'clock', pin: null });
  });

  it('draws both directions at the interchange rather than guessing — §W5', () => {
    expect(
      resolveCommuteV2Directions({
        query: commute(),
        selector: 'auto',
        pinnedAtMs: 0,
        commit: null,
        place: 'interchange',
        nowMs: hm(12, 0),
      }),
    ).toEqual({ directions: ['outbound', 'inbound'], reason: 'interchange', pin: null });
  });

  it('lets the interchange pill select the two boards explicitly', () => {
    expect(
      resolveCommuteV2Directions({
        query: commute(),
        selector: 'interchange',
        pinnedAtMs: hm(7, 30),
        commit: null,
        place: null,
        nowMs: hm(12, 0),
      }),
    ).toEqual({ directions: ['outbound', 'inbound'], reason: 'interchange', pin: null });
  });

  it('never lets the cached fix override a tap', () => {
    // A lower tier may not override a higher one: the fix is presentation only.
    const resolved = resolveCommuteV2Directions({
      query: commute(),
      selector: 'auto',
      pinnedAtMs: 0,
      commit: { direction: 'outbound', departureMs: hm(7, 10), line: '280' },
      place: 'interchange',
      nowMs: hm(7, 40),
    });
    expect(resolved).toEqual({ directions: ['outbound'], reason: 'committed', pin: null });
  });
});

// ------------------------------------------------------------- the board ---

describe('commuteWidgetV2Board', () => {
  const query = commute();
  const board = (
    over: Parameters<typeof commuteWidgetV2Board>[0] extends never
      ? never
      : Partial<Parameters<typeof commuteWidgetV2Board>[0]> = {},
  ) =>
    commuteWidgetV2Board({
      query,
      results: [{ key: 'outbound', result: result(twoLegTrip()), emptyReason: 'none' }],
      resolution: { directions: ['outbound'], reason: 'clock', pin: null },
      selector: 'auto',
      commit: null,
      committedTrip: null,
      nowMs: hm(6, 50),
      ...over,
    });

  it('is a timetable, and invents no commitment — §W3', () => {
    const answer = board();
    expect(answer.variant).toBe('v2');
    expect(answer.commitId).toBeNull();
    // No tap, so nothing is claimed about where the traveller is.
    expect(answer.focus.phase).toBeNull();
    expect(answer.focus.action).toBe('Board 🚌 280');
    // The scheduled time leads, as it does on every other Atlas transit surface.
    expect(answer.focus.when).toBe('07:10');
    expect(answer.focus.whenDelay).toBeNull();
    expect(answer.focus.platform).toBe('plat. 2');
    expect(answer.focus.countdown).toBe('in 20 min');
    expect(answer.focus.detail).toBe('arrives 08:14 · 1 h 4 min');
  });

  it('gives every row the id a tap commits to', () => {
    const answer = board();
    const journey = commuteJourney(twoLegTrip(), hm(6, 50));
    expect(answer.blocks[0]?.rows[0]?.id).toBe(commuteCommitId('outbound', journey));
    expect(answer.blocks[0]?.rows[0]?.committed).toBe(false);
  });

  it('follows the committed journey through the ladder', () => {
    const committedTrip = twoLegTrip();
    const commit: TransitWidgetV2Commit = {
      direction: 'outbound',
      departureMs: hm(7, 10),
      line: '280',
    };
    const answer = board({ commit, committedTrip, nowMs: hm(7, 36) });
    expect(answer.commitId).toBe('outbound:' + hm(7, 10) + ':280');
    expect(answer.focus.phase).toBe('interchange');
    expect(answer.focus.phaseLabel).toBe('At interchange');
    expect(answer.focus.action).toBe('Change to 🚆 R14');
    expect(answer.focus.when).toBe('07:41');
    expect(answer.focus.platform).toBe('plat. 3');
    // Direction and state stay separate axes — §W6's second bullet.
    expect(answer.focus.direction).toBe('outbound');
    expect(answer.focus.directionLabel).toBe('Engelsrud → Nationaltheatret');
  });

  it('marks the committed row in the list it came from', () => {
    const commit: TransitWidgetV2Commit = {
      direction: 'outbound',
      departureMs: hm(7, 10),
      line: '280',
    };
    const answer = board({ commit, committedTrip: twoLegTrip(), nowMs: hm(7, 0) });
    expect(answer.blocks[0]?.rows[0]?.committed).toBe(true);
  });

  it('lets a commitment go once the journey is over, rather than holding overnight', () => {
    const commit: TransitWidgetV2Commit = {
      direction: 'outbound',
      departureMs: hm(7, 10),
      line: '280',
    };
    // Scheduled arrival 08:14 plus the slack; an hour later nothing holds.
    const answer = board({ commit, committedTrip: twoLegTrip(), nowMs: hm(9, 30) });
    expect(answer.commitId).toBeNull();
    expect(answer.commitNote).toBeNull();
  });

  it('prints the timetable`s time and the correction beside it, never instead of it', () => {
    // The failure this guards against is a focus reading "07:22" above a row
    // reading "07:10 (+12 min)" — one widget contradicting itself, with nothing
    // to tell the reader which half to believe.
    const answer = board({
      results: [
        {
          key: 'outbound',
          result: result(twoLegTrip({ delayMs: 12 * 60_000 })),
          emptyReason: 'none',
        },
      ],
      nowMs: hm(7, 0),
    });
    expect(answer.focus.when).toBe('07:10');
    expect(answer.focus.whenDelay).toBe('+12 min');
    expect(answer.blocks[0]?.rows[0]?.time).toBe('07:10');
    // And the countdown is measured against the estimate, because that is the
    // number that is about being at the stop in time.
    expect(answer.focus.countdown).toBe('in 22 min');
  });

  it('states the broken connection instead of pretending the plan holds — §W4', () => {
    const committedTrip = twoLegTrip({ delayMs: 12 * 60_000 });
    const commit: TransitWidgetV2Commit = {
      direction: 'outbound',
      departureMs: hm(7, 10),
      line: '280',
    };
    const answer = board({ commit, committedTrip, nowMs: hm(7, 30) });
    expect(answer.focus.alert).toBe(
      'Connection missed at Asker stasjon — 07:44 arrival misses the 07:41',
    );
    // The vehicles may all be running; the plan is what is gone.
    expect(answer.focus.state).toBe('delayed');
  });

  it('says when a pinned direction lets go', () => {
    const answer = board({
      selector: 'outbound',
      resolution: {
        directions: ['outbound'],
        reason: 'pinned',
        pin: { direction: 'outbound', releasesAtMs: hm(16, 0) },
      },
    });
    expect(answer.selector.label).toBe('OUTBOUND');
    expect(answer.selector.note).toBe('Pinned until 16:00');
    expect(answer.selector.releasesAtMs).toBe(hm(16, 0));
  });

  it('asks again on the ladder`s cadence while committed, not the timetable`s', () => {
    const plain = board();
    const committed = board({
      commit: { direction: 'outbound', departureMs: hm(7, 10), line: '280' },
      committedTrip: twoLegTrip(),
      nowMs: hm(7, 20),
    });
    expect(committed.nextRefreshMs - hm(7, 20)).toBe(2 * 60_000);
    // And the un-committed board keeps v1's own schedule, which is minutes away.
    expect(plain.nextRefreshMs).toBeGreaterThan(hm(6, 50));
  });

  it('explains an empty direction instead of showing a broken-looking block', () => {
    const answer = board({
      results: [{ key: 'outbound', result: result(), emptyReason: 'filtered' }],
    });
    expect(answer.blocks[0]?.note).toBe('No journey uses only your chosen lines');
    expect(answer.focus.action).toBe('Nothing upcoming');
  });

  it('keeps a commitment when the selector is pinned the other way, without following it', () => {
    // §W1 says a manual choice wins, and §W3 says a commitment releases on its own
    // terms — so pinning the way home while riding out must show the way home
    // and must NOT throw the commitment away.
    const answer = board({
      selector: 'inbound',
      resolution: {
        directions: ['inbound'],
        reason: 'pinned',
        pin: { direction: 'inbound', releasesAtMs: hm(16, 0) },
      },
      results: [{ key: 'inbound', result: result(twoLegTrip()), emptyReason: 'none' }],
      commit: { direction: 'outbound', departureMs: hm(7, 10), line: '280' },
      committedTrip: twoLegTrip(),
      nowMs: hm(7, 36),
    });
    expect(answer.commitId).toBe(`outbound:${hm(7, 10)}:280`);
    // The focus is about the direction on screen, not about a block that is not.
    expect(answer.focus.direction).toBe('inbound');
    expect(answer.focus.phase).toBeNull();
    expect(answer.commitNote).toBe('Still committed to the 07:10 · Engelsrud → Nationaltheatret');
  });

  it('tells the reader how to let a commitment go, only when the row is there', () => {
    const answer = board({
      commit: { direction: 'outbound', departureMs: hm(7, 10), line: '280' },
      committedTrip: twoLegTrip(),
      nowMs: hm(7, 0),
    });
    expect(answer.commitNote).toBe('Committed to the 07:10 · tap it again to release');
  });

  it('draws two blocks when the resolution says both', () => {
    const answer = board({
      results: [
        { key: 'outbound', result: result(twoLegTrip()), emptyReason: 'none' },
        { key: 'inbound', result: result(twoLegTrip()), emptyReason: 'none' },
      ],
      resolution: { directions: ['outbound', 'inbound'], reason: 'interchange', pin: null },
    });
    expect(answer.blocks.map((block) => block.short)).toEqual(['TO NATIONALTHEA…', 'TO ENGELSRUD']);
  });
});

// ------------------------------------------------------- the questions ----

describe('commuteWidgetV2Queries', () => {
  it('asks the committed direction from now, and the others at their saved time', () => {
    const query = commute();
    const asked = commuteWidgetV2Queries({
      query,
      directions: ['outbound', 'inbound'],
      commit: { direction: 'outbound', departureMs: hm(7, 10), line: '280' },
      nowMs: hm(7, 40),
      maxRows: 3,
    });
    // Mid-journey, "the saved 07:00 departure" resolves to tomorrow morning —
    // right for "when does my commute leave", useless under a focus that says
    // "on the bus".
    expect(asked[0]?.key).toBe('outbound');
    expect(asked[0]?.query.dateTimeMs).toBeUndefined();
    // The direction nobody is on keeps its saved time, so an evening glance
    // still shows tomorrow's 07:10 rather than nothing.
    expect(asked[1]?.query.dateTimeMs).toBe(hm(16, 0));
  });

  it('keeps both saved times when nothing is committed', () => {
    const asked = commuteWidgetV2Queries({
      query: commute(),
      directions: ['outbound', 'inbound'],
      commit: null,
      nowMs: hm(6, 0),
      maxRows: 3,
    });
    expect(asked.map((entry) => entry.query.dateTimeMs)).toEqual([hm(7, 0), hm(16, 0)]);
  });

  it('asks the two departures from the saved interchange', () => {
    const asked = commuteWidgetV2Queries({
      query: commute(),
      directions: ['outbound', 'inbound'],
      interchange: true,
      commit: null,
      nowMs: hm(6, 0),
      maxRows: 3,
    });
    expect(
      asked.map(({ label, query }) => ({ label, from: query.from.name, to: query.to.name })),
    ).toEqual([
      {
        label: 'Asker stasjon → Nationaltheatret',
        from: 'Asker stasjon',
        to: 'Nationaltheatret',
      },
      { label: 'Asker stasjon → Engelsrud', from: 'Asker stasjon', to: 'Engelsrud' },
    ]);
    expect(asked.every((entry) => entry.query.dateTimeMs === undefined)).toBe(true);
  });
});

// ------------------------------------------------------- the cached fix ----

describe('commutePlaceAt — TRANSIT.md §W2, presentation only', () => {
  const query = commute();

  it('names the ends of the commute and the change between them', () => {
    expect(commutePlaceAt(query, { lat: 59.82, lng: 10.37 })).toBe('home');
    expect(commutePlaceAt(query, { lat: 59.83, lng: 10.43 })).toBe('interchange');
    expect(commutePlaceAt(query, { lat: 59.91, lng: 10.73 })).toBe('away');
  });

  it('says "unknown" rather than guessing at the nearest end', () => {
    // Trondheim. A coarse fix that means nothing about this commute must say so:
    // it may only ever choose AUTO's presentation, and the honest presentation
    // for "somewhere else entirely" is the one the clock would have chosen.
    expect(commutePlaceAt(query, { lat: 63.43, lng: 10.39 })).toBe('unknown');
  });

  it('prefers the interchange when the ends are close together', () => {
    // The via stop is checked first on purpose: standing at the change is the
    // one place where either direction is genuinely live, and a commute whose
    // home stop is inside the station forecourt would otherwise read as "home".
    const tight = commute({ via: [{ name: 'Engelsrud', lat: 59.82, lng: 10.37 }] });
    expect(commutePlaceAt(tight, { lat: 59.82, lng: 10.37 })).toBe('interchange');
  });
});

// --------------------------------------------------------- the commitment ---

describe('a commitment made from the interchange — TRANSIT.md §13', () => {
  const journey = () => commuteJourney(twoLegTrip(), hm(7, 0));

  it('keeps the door form of the id exactly as it was', () => {
    // A key written before the board could start anywhere else still has to
    // match the journey it named, in this process and in a widget's store.
    expect(commuteCommitId('outbound', journey())).toBe(`outbound:${hm(7, 10)}:280`);
    expect(commuteCommitKey({ direction: 'outbound', departureMs: hm(7, 10), line: '280' })).toBe(
      `outbound:${hm(7, 10)}:280`,
    );
  });

  it('tells the two starting points apart', () => {
    expect(commuteCommitId('outbound', journey(), 'interchange')).toBe(
      `outbound@interchange:${hm(7, 10)}:280`,
    );
    expect(
      commuteCommitKey({
        direction: 'outbound',
        departureMs: hm(7, 10),
        line: '280',
        origin: 'interchange',
      }),
    ).toBe(`outbound@interchange:${hm(7, 10)}:280`);
  });

  /**
   * The reason the origin is part of a commitment at all: the question that
   * re-reads the journey. A train home tracked from Asker is not in an answer
   * asked from Engelsrud, so without this the commitment would release itself
   * on the next refresh.
   */
  it('re-reads the journey from where it was committed to', () => {
    const query = commute();
    const asked = commuteCommitQuery(query, {
      direction: 'outbound',
      departureMs: hm(7, 10),
      line: '280',
      origin: 'interchange',
    });
    expect(asked.from.name).toBe('Asker stasjon');
    expect(asked.to.name).toBe('Nationaltheatret');
    expect(asked.via).toEqual([]);
    // And the door commitment is asked exactly as it always was.
    const door = commuteCommitQuery(query, {
      direction: 'inbound',
      departureMs: hm(16, 10),
      line: 'R14',
    });
    expect(door.from.name).toBe('Nationaltheatret');
    expect(door.via?.map((place) => place.name)).toEqual(['Asker stasjon']);
    expect(door.to.name).toBe('Engelsrud');
  });

  it('falls back to the door when the commute has no interchange to start from', () => {
    const asked = commuteCommitQuery(commute({ via: [] }), {
      direction: 'outbound',
      departureMs: hm(7, 10),
      line: '280',
      origin: 'interchange',
    });
    expect(asked.from.name).toBe('Engelsrud');
    expect(asked.to.name).toBe('Nationaltheatret');
  });
});

// -------------------------------------------------- finding what was tapped ---

describe('findCommittedTrip', () => {
  it('resolves a commitment the same way the board listed it', () => {
    // Two journeys board the same 07:10 bus and change onto different trains, so
    // they share a commit id — measured on the live corridor, where the 23:42
    // 280 came back arriving both 00:21 and 00:39. The board keeps the earliest
    // arrival; the commitment must resolve to the same one, or the focus follows
    // a train the tapped row never mentioned.
    const early = twoLegTrip();
    const late = trip(
      ride({
        line: '280',
        from: 'Engelsrud',
        to: 'Asker stasjon',
        startMs: hm(7, 10),
        endMs: hm(7, 32),
        quay: '2',
      }),
      change(hm(7, 32), hm(7, 34)),
      ride({
        line: 'L1',
        from: 'Asker stasjon',
        to: 'Nationaltheatret',
        startMs: hm(7, 55),
        endMs: hm(8, 40),
        quay: '1',
      }),
    );
    const commit = { direction: 'outbound' as const, departureMs: hm(7, 10), line: '280' };
    // Entur ranks rather than sorts, so the slower option can come back first.
    const found = findCommittedTrip(result(late, early), commit, hm(7, 0));
    expect(found).toBe(early);
  });

  it('releases a commitment the planner no longer offers', () => {
    const commit = { direction: 'outbound' as const, departureMs: hm(9, 99), line: 'X9' };
    expect(findCommittedTrip(result(twoLegTrip()), commit, hm(7, 0))).toBeNull();
  });
});
