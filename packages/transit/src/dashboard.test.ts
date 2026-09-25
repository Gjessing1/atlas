import { describe, expect, it } from 'vitest';

import { norwayInstant } from './clock.js';
import {
  commuteBoardRows,
  commuteDurationLabel,
  commuteEstimateLabel,
  commuteInterchange,
  commuteInterchangeHops,
  commuteJourney,
  commuteJourneyList,
  commuteLeaveNow,
  commuteLineBadge,
  commuteListing,
  commuteModeChip,
  commuteModes,
  commuteModeTitle,
  commuteNowLabel,
  commuteOffDayNote,
  commuteOrigins,
  commuteRibbon,
  commuteRibbonProgress,
  commuteSegments,
  commuteSharedDisruptions,
  commuteFreshnessLabel,
} from './dashboard.js';
import { legTimeParts } from './labels.js';
import type {
  TransitCommuteQuery,
  TransitLeg,
  TransitResult,
  TransitSituation,
  TransitTrip,
} from './model.js';

/** Tuesday 25 August 2026, 08:32 Norwegian summer time — the spec's own clock. */
const NOW = norwayInstant(2026, 7, 25, 8 * 60 + 32);
const at = (minutesOfDay: number) => norwayInstant(2026, 7, 25, minutesOfDay);
const hm = (hours: number, minutes: number) => at(hours * 60 + minutes);

const place = (name: string, quay?: string) => ({
  name,
  position: { lat: 59.9, lng: 10.6 },
  ...(quay ? { quay: { publicCode: quay } } : {}),
});

function ride(
  opts: Partial<TransitLeg> & {
    line: string;
    from: string;
    to: string;
    aimedStartMs: number;
    aimedEndMs: number;
  },
): TransitLeg {
  const { line, from, to, ...rest } = opts;
  return {
    mode: 'bus',
    distanceM: 5_000,
    durationMs: rest.aimedEndMs - rest.aimedStartMs,
    expectedStartMs: rest.aimedStartMs,
    expectedEndMs: rest.aimedEndMs,
    realtime: false,
    from: place(from),
    to: place(to),
    line: { id: `X:Line:${line}`, publicCode: line },
    intermediateStops: [],
    points: [],
    situations: [],
    ...rest,
  };
}

function walk(fromMs: number, toMs: number): TransitLeg {
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

/** The spec's own journey: 08:36 bus → 09:02 Asker → 09:11 train → 09:24. */
const specJourney = () =>
  trip(
    ride({
      line: '270',
      from: 'Engelsrud Terrasse',
      to: 'Asker stasjon',
      aimedStartMs: hm(8, 36),
      aimedEndMs: hm(9, 2),
    }),
    walk(hm(9, 2), hm(9, 4)),
    ride({
      line: 'L1',
      mode: 'rail',
      from: 'Asker stasjon',
      to: 'Nationaltheatret',
      aimedStartMs: hm(9, 11),
      aimedEndMs: hm(9, 24),
    }),
  );

const commuteQuery = (via = true): TransitCommuteQuery => ({
  from: { name: 'Engelsrud Terrasse', lat: 59.83, lng: 10.42 },
  via: via ? [{ name: 'Asker stasjon', lat: 59.83, lng: 10.43 }] : [],
  to: { name: 'Nationaltheatret', lat: 59.91, lng: 10.73 },
  filter: { select: [], exclude: [], modes: [] },
  outboundTime: { minutesOfDay: null, arriveBy: false },
  inboundTime: { minutesOfDay: null, arriveBy: false },
  days: [],
});

describe('commuteJourney', () => {
  it('reads the ends off the vehicles, not off the walk to the stop', () => {
    const journey = commuteJourney(specJourney(), NOW);
    expect(journey.departure.aimed).toBe('08:36');
    expect(journey.arrival.aimed).toBe('09:24');
    expect(journey.duration).toBe('48 min');
    expect(journey.scan).toBe('08:36 → 09:24 · 48 min');
  });

  it('computes the connection so nobody subtracts two clock times on a platform', () => {
    const journey = commuteJourney(specJourney(), NOW);
    expect(journey.connections).toHaveLength(1);
    expect(journey.connections[0]).toMatchObject({
      at: 'Asker stasjon',
      arrive: '09:02',
      depart: '09:11',
      label: '9 min',
      tight: false,
    });
  });

  /**
   * The collapsed row's whole job, and the gap this closed: "🚌 270 🚆 L1" says
   * a train is involved and says nothing about when it leaves Asker or when it
   * reaches town, so the one screen opened to answer that made the reader expand
   * a row to find out.
   */
  it('gives every vehicle its own window, so a collapsed row still names the legs', () => {
    const journey = commuteJourney(specJourney(), NOW);
    expect(journey.rides.map((entry) => `${entry.line} ${entry.window}`)).toEqual([
      '270 08:36 → 09:02',
      'L1 09:11 → 09:24',
    ]);
    // And the change between them, phrased once for both clients.
    expect(journey.connections[0]!.chip).toBe('9 min at Asker stasjon');
    expect(journey.connections[0]!.summary).toBe('9 min connection · 120 m walk');
    expect(journey.connections[0]!.brief).toBe('Asker stasjon · 9 min');
    expect(journey.connections[0]!.walk).toBe('120 m walk');
  });

  it('calls a platform step no walk at all', () => {
    // 120 m across Asker is worth knowing about; twelve is a router measuring
    // the same platform, and printing it is noise on a scannable row.
    const step = walk(hm(9, 2), hm(9, 3));
    step.distanceM = 12;
    const journey = commuteJourney(
      trip(
        ride({
          line: '270',
          from: 'Engelsrud Terrasse',
          to: 'Asker stasjon',
          aimedStartMs: hm(8, 36),
          aimedEndMs: hm(9, 2),
        }),
        step,
        ride({
          line: 'L1',
          from: 'Asker stasjon',
          to: 'Nationaltheatret',
          aimedStartMs: hm(9, 11),
          aimedEndMs: hm(9, 24),
        }),
      ),
      NOW,
    );
    expect(journey.connections[0]!.walk).toBeNull();
    expect(journey.connections[0]!.summary).toBe('9 min connection');
  });

  it('flags a connection with no slack rather than presenting it as ordinary', () => {
    const tight = trip(
      ride({ line: '270', from: 'A', to: 'B', aimedStartMs: hm(8, 36), aimedEndMs: hm(9, 2) }),
      ride({ line: 'L1', from: 'B', to: 'C', aimedStartMs: hm(9, 4), aimedEndMs: hm(9, 24) }),
    );
    expect(commuteJourney(tight, NOW).connections[0]).toMatchObject({
      label: '2 min',
      tight: true,
    });
  });

  /**
   * The warning has to follow the morning, not the timetable: a nine-minute
   * change is ordinary until the bus into it runs seven late, and then it is the
   * one thing on the card worth reading.
   */
  it('flags a connection that live times have cut short, keeping the planned wait', () => {
    const late = trip(
      ride({
        line: '270',
        from: 'A',
        to: 'Asker stasjon',
        aimedStartMs: hm(8, 36),
        aimedEndMs: hm(9, 2),
        expectedStartMs: hm(8, 43),
        expectedEndMs: hm(9, 9),
        realtime: true,
      }),
      ride({
        line: 'L1',
        from: 'Asker stasjon',
        to: 'C',
        aimedStartMs: hm(9, 11),
        aimedEndMs: hm(9, 24),
      }),
    );
    const change = commuteJourney(late, NOW).connections[0]!;
    expect(change).toMatchObject({
      label: '9 min',
      liveWaitMs: 2 * 60_000,
      liveLabel: '2 min est.',
      tight: true,
      warn: true,
    });
    // The detail the tap opens says the two times and why it is flagged.
    expect(change.details).toContain('Arrive 09:02 · 09:09 est.');
    expect(change.details).toContain('Live: 2 min to change');
    // The ribbon's gap turns with it, while its label stays the planned minutes.
    const gap = commuteRibbon(commuteJourney(late, NOW)).find((part) => part.kind === 'change');
    expect(gap).toMatchObject({ label: '9m', tight: true });
  });

  it('calls a shortened but still workable connection uncertain, not tight', () => {
    const late = trip(
      ride({
        line: '270',
        from: 'A',
        to: 'B',
        aimedStartMs: hm(8, 36),
        aimedEndMs: hm(9, 2),
        expectedEndMs: hm(9, 7),
        realtime: true,
      }),
      ride({ line: 'L1', from: 'B', to: 'C', aimedStartMs: hm(9, 13), aimedEndMs: hm(9, 24) }),
    );
    expect(commuteJourney(late, NOW).connections[0]).toMatchObject({
      label: '11 min',
      liveLabel: '6 min est.',
      tight: false,
      uncertain: true,
      warn: true,
    });
  });

  it('leaves an ordinary connection neutral, live feed or not', () => {
    const onTime = trip(
      ride({
        line: '270',
        from: 'A',
        to: 'B',
        aimedStartMs: hm(8, 36),
        aimedEndMs: hm(9, 2),
        realtime: true,
      }),
      ride({ line: 'L1', from: 'B', to: 'C', aimedStartMs: hm(9, 12), aimedEndMs: hm(9, 24) }),
    );
    expect(commuteJourney(onTime, NOW).connections[0]).toMatchObject({
      liveWaitMs: 10 * 60_000,
      liveLabel: null,
      warn: false,
    });
  });

  it('opens and closes the itinerary with the walks to and from the vehicles', () => {
    const door = walk(hm(8, 31), hm(8, 36));
    door.distanceM = 340;
    const home = walk(hm(9, 24), hm(9, 27));
    home.distanceM = 210;
    const journey = commuteJourney(
      trip(
        door,
        ride({ line: '270', from: 'A', to: 'B', aimedStartMs: hm(8, 36), aimedEndMs: hm(9, 24) }),
        home,
      ),
      NOW,
    );
    expect(journey.walkIn).toEqual({ aimed: '08:31', label: '5 min walk · 340 m' });
    expect(journey.walkOut).toEqual({ aimed: '09:24', label: '3 min walk · 210 m' });
    expect(commuteJourney(specJourney(), NOW).walkIn).toBeNull();
  });

  it('keeps the scheduled time primary when a live feed corrects it (§3)', () => {
    const late = trip(
      ride({
        line: '270',
        from: 'Engelsrud Terrasse',
        to: 'Asker stasjon',
        aimedStartMs: hm(8, 41),
        aimedEndMs: hm(9, 2),
        expectedStartMs: hm(8, 43),
        expectedEndMs: hm(9, 4),
        realtime: true,
      }),
    );
    const journey = commuteJourney(late, NOW);
    // The number the departure board at the stop shows.
    expect(journey.departure.aimed).toBe('08:41');
    // The correction, kept beside it rather than in place of it.
    expect(journey.departure.expected).toBe('08:43');
    expect(journey.departure.delay).toBe('+2 min');
    expect(journey.scan.startsWith('08:41')).toBe(true);
    expect(journey.state).toBe('delayed');
  });

  it('states a delay once — in the state and the estimate, not as a notice too', () => {
    // A measured delay is already said three ways (the row's state colour, the
    // estimate label, the leg's own "est." line). Restating it as a warning box
    // was four, and the box was the one that pushed the next journey's scan
    // line off the panel.
    const late = trip(
      ride({
        line: '270',
        from: 'A',
        to: 'B',
        aimedStartMs: hm(8, 41),
        aimedEndMs: hm(9, 2),
        expectedStartMs: hm(8, 49),
        expectedEndMs: hm(9, 10),
        realtime: true,
      }),
    );
    const journey = commuteJourney(late, NOW);
    expect(journey.disruptions).toEqual([]);
    expect(journey.state).toBe('delayed');
    expect(journey.departure.delay).toBe('+8 min');
  });

  it('tells a planned closure apart from an incident and a cancellation (§4)', () => {
    const situation = (extra: Partial<TransitSituation>): TransitSituation => ({
      id: `S${extra.summary ?? ''}`,
      summary: 'Signalfeil mellom Asker og Sandvika',
      severity: 'warning',
      ...extra,
    });
    const kind = (leg: Partial<TransitLeg>, s: Partial<TransitSituation>) =>
      commuteJourney(
        trip(
          ride({
            line: 'L1',
            from: 'A',
            to: 'B',
            aimedStartMs: hm(8, 41),
            aimedEndMs: hm(9, 2),
            situations: [situation(s)],
            ...leg,
          }),
        ),
        NOW,
      ).disruptions[0]?.kind;

    expect(kind({}, {})).toBe('incident');
    expect(kind({}, { planned: true })).toBe('planned');
    expect(kind({ replacement: true }, {})).toBe('replacement');
    // Leg facts beat prose: an operator publishing a cancellation as a `general`
    // report is still a cancellation.
    expect(kind({ cancelled: true }, { planned: true })).toBe('cancellation');
  });

  /**
   * Engineering work announced weeks ago and a cancelled train are both notices
   * on the leg; only one of them may compete with the departure time.
   */
  it('draws what is happening to this departure louder than a general notice', () => {
    const journey = commuteJourney(
      trip(
        ride({
          line: 'L1',
          from: 'A',
          to: 'B',
          aimedStartMs: hm(8, 41),
          aimedEndMs: hm(9, 2),
          situations: [
            { id: 'plan', summary: 'Sporarbeid i november', severity: 'warning', planned: true },
            { id: 'info', summary: 'Ny rutetabell', severity: 'info' },
            { id: 'now', summary: 'Signalfeil ved Sandvika', severity: 'warning' },
            { id: 'bus', summary: 'Buss for tog i helgen', severity: 'severe', planned: true },
          ],
        }),
      ),
      NOW,
    );
    expect(journey.disruptions.map((item) => `${item.key}:${item.prominence}`)).toEqual([
      'now:active',
      'bus:active',
      'plan:notice',
      'info:notice',
    ]);
  });

  it('warns once about a situation attached to two legs of the same line', () => {
    const shared: TransitSituation = { id: 'SIT-1', summary: 'Delays on L1', severity: 'warning' };
    const twice = trip(
      ride({
        line: 'L1',
        from: 'A',
        to: 'B',
        aimedStartMs: hm(8, 36),
        aimedEndMs: hm(9, 2),
        situations: [shared],
      }),
      ride({
        line: 'L1',
        from: 'B',
        to: 'C',
        aimedStartMs: hm(9, 11),
        aimedEndMs: hm(9, 24),
        situations: [shared],
      }),
    );
    expect(commuteJourney(twice, NOW).disruptions).toHaveLength(1);
  });

  /**
   * The question this answers, asked of a real board: "is the 48 minutes with
   * the delay in it or not?" It is not — both ends of the scheduled window are
   * timetable numbers — and until the live line existed nothing on the row said
   * so either way.
   */
  it('states the live window separately, so the travel time says which it is', () => {
    const delayed = trip(
      ride({
        line: '270',
        from: 'Engelsrud Terrasse',
        to: 'Asker stasjon',
        aimedStartMs: hm(8, 36),
        aimedEndMs: hm(9, 2),
        expectedStartMs: hm(8, 39),
        expectedEndMs: hm(9, 5),
        realtime: true,
      }),
    );
    const journey = commuteJourney(delayed, NOW);
    // §3 holds: the printed line is still the timetable's.
    expect(journey.scan).toBe('08:36 → 09:02 · 26 min');
    expect(journey.live).toMatchObject({
      departure: '08:39',
      arrival: '09:05',
      duration: '26 min',
      scan: '08:39 → 09:05 est. · 26 min',
      slower: false,
    });
  });

  it('says so when the delay makes the journey longer, not just later', () => {
    // Three minutes late off the stop and eight minutes late in: the vehicle
    // lost five minutes on the way, and the timetable's 26 is now 31.
    const journey = commuteJourney(
      trip(
        ride({
          line: '270',
          from: 'A',
          to: 'B',
          aimedStartMs: hm(8, 36),
          aimedEndMs: hm(9, 2),
          expectedStartMs: hm(8, 39),
          expectedEndMs: hm(9, 10),
          realtime: true,
        }),
      ),
      NOW,
    );
    expect(journey.live).toMatchObject({ duration: '31 min', slower: true });
  });

  it('says nothing about live times when nothing has moved', () => {
    // The commonest row on the board. A "live" line here would print an
    // estimate identical to the timetable and push the next departure down.
    expect(commuteJourney(specJourney(), NOW).live).toBeNull();
  });

  it('names the day only when the departure is not today', () => {
    expect(commuteJourney(specJourney(), NOW).dayNote).toBeNull();
    const tomorrow = trip(
      ride({
        line: '270',
        from: 'A',
        to: 'B',
        aimedStartMs: at(24 * 60 + 6 * 60),
        aimedEndMs: at(24 * 60 + 6 * 60 + 20),
      }),
    );
    expect(commuteJourney(tomorrow, NOW).dayNote).toBe('Tomorrow');
  });
});

describe('commuteSegments', () => {
  it('generates the four directed hops from three stops (§8)', () => {
    expect(commuteSegments(commuteQuery()).map((segment) => segment.label)).toEqual([
      'Engelsrud Terrasse → Asker stasjon',
      'Asker stasjon → Nationaltheatret',
      'Nationaltheatret → Asker stasjon',
      'Asker stasjon → Engelsrud Terrasse',
    ]);
  });

  it('generates none without an interchange — the journey list is already that board', () => {
    expect(commuteSegments(commuteQuery(false))).toEqual([]);
  });
});

describe('commuteOrigins', () => {
  it('offers the interchange as a starting point, in both directions (§13)', () => {
    expect(
      commuteOrigins(commuteQuery(), 'outbound').map((origin) => [
        origin.id,
        origin.from.name,
        origin.segmentId,
      ]),
    ).toEqual([
      ['door', 'Engelsrud Terrasse', null],
      ['interchange', 'Asker stasjon', 'outbound-1'],
    ]);
    expect(
      commuteOrigins(commuteQuery(), 'inbound').map((origin) => [
        origin.id,
        origin.from.name,
        origin.segmentId,
      ]),
    ).toEqual([
      ['door', 'Nationaltheatret', null],
      ['interchange', 'Asker stasjon', 'inbound-1'],
    ]);
  });

  /**
   * The segment id is the whole point of the middle mode costing nothing: it
   * names an answer the dashboard has already asked for, so it must be one
   * `commuteSegments` actually produces.
   */
  it('names a hop the corridor really has', () => {
    const hops = new Set(commuteSegments(commuteQuery()).map((segment) => segment.id));
    for (const direction of ['outbound', 'inbound'] as const) {
      const interchange = commuteOrigins(commuteQuery(), direction)[1]!;
      expect(hops.has(interchange.segmentId!)).toBe(true);
    }
  });

  it('offers one origin without an interchange — a choice of one is no choice', () => {
    expect(commuteOrigins(commuteQuery(false), 'outbound')).toHaveLength(1);
  });

  it('carries the door’s vias, so the whole-commute question is unchanged', () => {
    const [door, interchange] = commuteOrigins(commuteQuery(), 'outbound');
    expect(door!.via.map((place) => place.name)).toEqual(['Asker stasjon']);
    expect(interchange!.via).toEqual([]);
  });
});

describe('commuteListing', () => {
  it('offers three modes with an interchange and two without (§13)', () => {
    expect(commuteModes(commuteQuery())).toEqual(['outbound', 'interchange', 'inbound']);
    expect(commuteModes(commuteQuery(false))).toEqual(['outbound', 'inbound']);
    expect(commuteModes(commuteQuery()).map(commuteModeChip)).toEqual([
      'Outbound',
      'Interchange',
      'Return',
    ]);
  });

  it('draws a door mode as the one journey list it has always been', () => {
    const listing = commuteListing(commuteQuery(), 'outbound')!;
    expect([listing.key, listing.direction, listing.label, listing.leadLabel]).toEqual([
      'outbound',
      'outbound',
      'Engelsrud Terrasse → Nationaltheatret',
      'If I leave now',
    ]);
    expect(commuteModeTitle(commuteQuery(), 'inbound')).toBe(
      'Nationaltheatret → Engelsrud Terrasse',
    );
  });

  /**
   * The middle mode is not a third direction and not a third journey list: it
   * is the *stop*, and what a stop has is departures.
   */
  it('has no journey list at the change — that mode draws boards', () => {
    expect(commuteListing(commuteQuery(), 'interchange')).toBeNull();
  });
});

describe('commuteInterchangeHops', () => {
  it('draws both directions *out of* the change, off the hops in hand (§13)', () => {
    expect(
      commuteInterchangeHops(commuteQuery(), 'outbound').map((hop) => [hop.id, hop.label]),
    ).toEqual([
      ['outbound-1', 'Asker stasjon → Nationaltheatret'],
      ['inbound-1', 'Asker stasjon → Engelsrud Terrasse'],
    ]);
    // The header is the stop you are standing at — two boards cannot be summed
    // into a route, and each carries its own from → to anyway.
    expect(commuteModeTitle(commuteQuery(), 'interchange')).toBe('From Asker stasjon');
  });

  /**
   * Every hop leaves the change. The two *into* it are the half of the corridor
   * you are standing at the far end of — a board of departures from your own
   * front door has no business under a mode about the station.
   */
  it('never lists a hop arriving at the change', () => {
    for (const primary of ['outbound', 'inbound'] as const) {
      for (const hop of commuteInterchangeHops(commuteQuery(), primary)) {
        expect(hop.from.name).toBe('Asker stasjon');
      }
    }
  });

  it('reads the way home first once the clock says so', () => {
    expect(commuteInterchangeHops(commuteQuery(), 'inbound').map((hop) => hop.id)).toEqual([
      'inbound-1',
      'outbound-1',
    ]);
  });

  it('has no interchange to draw without one saved', () => {
    expect(commuteInterchangeHops(commuteQuery(false), 'outbound')).toEqual([]);
    expect(commuteModeTitle(commuteQuery(false), 'interchange')).toBe('Commute');
  });
});

describe('commuteInterchange', () => {
  const answer = (...trips: TransitTrip[]): TransitResult => ({ trips, problems: [] });
  const both = (...trips: TransitTrip[]) => ({ outbound: answer(...trips), inbound: answer() });

  /** The corridor's own change, read off the answer rather than off the config. */
  it('names the stop every journey changes at', () => {
    expect(commuteInterchange(both(specJourney(), specJourney()))).toEqual({
      name: 'Asker stasjon',
      lat: 59.9,
      lng: 10.6,
    });
  });

  it('reads both directions, so an evening board suggests the same stop', () => {
    expect(commuteInterchange({ outbound: answer(), inbound: answer(specJourney()) })?.name).toBe(
      'Asker stasjon',
    );
  });

  /**
   * The whole reason this is unanimous-or-nothing: saving a `via` *constrains*
   * the planner, so a suggestion drawn from a majority would delete the journeys
   * that disagreed with it — the direct one first.
   */
  it('refuses when one journey runs direct', () => {
    const direct = trip(
      ride({
        line: 'R11',
        mode: 'rail',
        from: 'Engelsrud Terrasse',
        to: 'Nationaltheatret',
        aimedStartMs: hm(8, 40),
        aimedEndMs: hm(9, 20),
      }),
    );
    expect(commuteInterchange(both(specJourney(), direct))).toBeNull();
  });

  it('refuses when the journeys change at different stops', () => {
    const elsewhere = trip(
      ride({
        line: '270',
        from: 'Engelsrud Terrasse',
        to: 'Sandvika',
        aimedStartMs: hm(8, 36),
        aimedEndMs: hm(9, 2),
      }),
      ride({
        line: 'L1',
        mode: 'rail',
        from: 'Sandvika',
        to: 'Nationaltheatret',
        aimedStartMs: hm(9, 11),
        aimedEndMs: hm(9, 24),
      }),
    );
    expect(commuteInterchange(both(specJourney(), elsewhere))).toBeNull();
  });

  it('refuses a journey with two changes — a commute saves one via', () => {
    const twice = trip(
      ride({
        line: '270',
        from: 'Engelsrud Terrasse',
        to: 'Asker stasjon',
        aimedStartMs: hm(8, 36),
        aimedEndMs: hm(9, 2),
      }),
      ride({
        line: 'L1',
        mode: 'rail',
        from: 'Asker stasjon',
        to: 'Sandvika',
        aimedStartMs: hm(9, 11),
        aimedEndMs: hm(9, 18),
      }),
      ride({
        line: '160',
        from: 'Sandvika',
        to: 'Nationaltheatret',
        aimedStartMs: hm(9, 22),
        aimedEndMs: hm(9, 40),
      }),
    );
    expect(commuteInterchange(both(twice))).toBeNull();
  });

  /** A change whose halves are at different stops is a walk, not a place to stand. */
  it('refuses a change that walks between two stops', () => {
    const walkBetween = trip(
      ride({
        line: '270',
        from: 'Engelsrud Terrasse',
        to: 'Asker bussterminal',
        aimedStartMs: hm(8, 36),
        aimedEndMs: hm(9, 2),
      }),
      walk(hm(9, 2), hm(9, 8)),
      ride({
        line: 'L1',
        mode: 'rail',
        from: 'Asker stasjon',
        to: 'Nationaltheatret',
        aimedStartMs: hm(9, 11),
        aimedEndMs: hm(9, 24),
      }),
    );
    expect(commuteInterchange(both(walkBetween))).toBeNull();
  });

  it('has nothing to say about an answer with no journeys', () => {
    expect(commuteInterchange(both())).toBeNull();
    expect(commuteInterchange(null)).toBeNull();
  });
});

describe('commuteBoardRows', () => {
  const result = (...trips: TransitTrip[]): TransitResult => ({ trips, problems: [] });

  it('puts the board in time order, whatever order the planner ranked it in', () => {
    // Measured shape: Entur answered 08:49, 08:59, 09:09, 09:04, 09:19 for
    // Asker → Nationaltheatret on 2026-08-25.
    const rows = commuteBoardRows(
      result(
        ...[
          [8, 49],
          [8, 59],
          [9, 9],
          [9, 4],
          [9, 19],
        ].map(([h, m]) =>
          trip(
            ride({
              line: 'R13',
              from: 'Asker stasjon',
              to: 'Nationaltheatret',
              aimedStartMs: hm(h!, m!),
              aimedEndMs: hm(h!, m!) + 18 * 60_000,
            }),
          ),
        ),
      ),
      NOW,
    );
    expect(rows.map((row) => row.aimed)).toEqual(['08:49', '08:59', '09:04', '09:09', '09:19']);
  });

  it('carries the arrival a stop board could never know', () => {
    const [row] = commuteBoardRows(
      result(
        trip(
          ride({
            line: '270',
            from: 'Engelsrud Terrasse',
            to: 'Asker stasjon',
            aimedStartMs: hm(8, 36),
            aimedEndMs: hm(9, 2),
          }),
        ),
      ),
      NOW,
    );
    expect(row).toMatchObject({
      aimed: '08:36',
      arrival: '09:02',
      duration: '26 min',
      countdown: 'in 4 min',
    });
  });

  /**
   * The same reordering the journey list had, one level down — and the reason a
   * countdown is not a clock face. "08:41 · 08:44 est. · in 2 min" is one
   * coherent row; the same row counting to 08:41 sends someone out of the door
   * for a bus that is three minutes from arriving.
   */
  it('orders and counts down on the live departure, printing the timetabled one', () => {
    const departure = (h: number, m: number, delayMinutes: number) =>
      trip(
        ride({
          line: 'R13',
          from: 'Asker stasjon',
          to: 'Nationaltheatret',
          aimedStartMs: hm(h, m),
          aimedEndMs: hm(h, m) + 18 * 60_000,
          expectedStartMs: hm(h, m) + delayMinutes * 60_000,
          expectedEndMs: hm(h, m) + (18 + delayMinutes) * 60_000,
          realtime: true,
        }),
      );
    const rows = commuteBoardRows(result(departure(8, 36, 9), departure(8, 40, 0)), NOW);
    expect(rows.map((row) => [row.aimed, row.estimate, row.countdown])).toEqual([
      ['08:40', 'On time', 'in 8 min'],
      ['08:36', '08:45 est.', 'in 13 min'],
    ]);
  });

  it('drops an all-walk answer: a true journey, but not a departure', () => {
    expect(commuteBoardRows(result(trip(walk(hm(8, 40), hm(8, 55)))), NOW)).toEqual([]);
  });
});

describe('commuteEstimateLabel', () => {
  const parts = (aimed: number, expected: number, realtime: boolean) =>
    legTimeParts({ aimedMs: aimed, expectedMs: expected, realtime });

  it('labels the estimate rather than replacing the scheduled time', () => {
    expect(commuteEstimateLabel(parts(hm(8, 41), hm(8, 43), true), false)).toBe('08:43 est.');
  });

  it('says a live service is on time, and a timetabled one is only timetabled', () => {
    expect(commuteEstimateLabel(parts(hm(8, 41), hm(8, 41), true), false)).toBe('On time');
    expect(commuteEstimateLabel(parts(hm(8, 41), hm(8, 41), false), false)).toBe('Timetable');
  });

  it('says cancelled above everything else', () => {
    expect(commuteEstimateLabel(parts(hm(8, 41), hm(8, 43), true), true)).toBe('Cancelled');
  });
});

describe('commuteJourneyList', () => {
  /** One journey: a bus at `depart`, a train from Asker, arriving at `arrive`. */
  const option = (depart: [number, number], arrive: [number, number], bus = '270') =>
    commuteJourney(
      trip(
        ride({
          line: bus,
          from: 'Engelsrud terrasse',
          to: 'Asker stasjon',
          aimedStartMs: hm(...depart),
          aimedEndMs: hm(...depart) + 11 * 60_000,
        }),
        ride({
          line: 'L1',
          mode: 'rail',
          from: 'Asker stasjon',
          to: 'Nationaltheatret',
          aimedStartMs: hm(...arrive) - 18 * 60_000,
          aimedEndMs: hm(...arrive),
        }),
      ),
      NOW,
    );

  it('puts the planner’s ranking back into time order', () => {
    // Measured shape of a live answer: options ranked, not sorted. A list whose
    // second row leaves before its first is not a timetable.
    const list = commuteJourneyList([
      option([20, 42], [21, 17]),
      option([20, 29], [21, 17], '71'),
      option([20, 59], [21, 37], '71'),
    ]);
    expect(list.map((journey) => journey.departure.aimed)).toEqual(['20:29', '20:42', '20:59']);
  });

  it('shows one row per departure, keeping the one that gets there first', () => {
    // The same 20:42 bus twice, differing only in which train it catches at
    // Asker. That is not a choice anyone makes at Engelsrud.
    const list = commuteJourneyList([
      option([20, 42], [21, 35]),
      option([20, 42], [21, 17]),
      option([20, 59], [21, 37]),
    ]);
    expect(list.map((journey) => journey.scan)).toEqual([
      '20:42 → 21:17 · 35 min',
      '20:59 → 21:37 · 38 min',
    ]);
  });

  /**
   * The reordering a reader met as "the next departure changed and I cannot see
   * why". The board sorted by the timetable and picked its headline off the
   * expected departure, so a delayed bus kept a slot it had physically lost and
   * the headline named a journey listed second.
   */
  it('orders by the departure that actually happens, not the one printed', () => {
    const late = (depart: [number, number], delayMinutes: number) =>
      commuteJourney(
        trip(
          ride({
            line: '270',
            from: 'Engelsrud terrasse',
            to: 'Asker stasjon',
            aimedStartMs: hm(...depart),
            aimedEndMs: hm(...depart) + 11 * 60_000,
            expectedStartMs: hm(...depart) + delayMinutes * 60_000,
            expectedEndMs: hm(...depart) + (11 + delayMinutes) * 60_000,
            realtime: true,
          }),
        ),
        NOW,
      );
    // The 08:36 is nine minutes down and will leave at 08:45; the 08:40 is on
    // time. The list is what leaves first, and the delayed row explains its own
    // position through its live line.
    const list = commuteJourneyList([late([8, 36], 9), late([8, 40], 0)]);
    expect(list.map((journey) => journey.departure.aimed)).toEqual(['08:40', '08:36']);
    expect(list[1]!.live?.scan).toBe('08:45 → 08:56 est. · 11 min');
  });

  it('keeps a different vehicle leaving the same minute — that one is a real choice', () => {
    const list = commuteJourneyList([
      option([20, 42], [21, 35], '280'),
      option([20, 42], [21, 17]),
    ]);
    expect(list).toHaveLength(2);
  });
});

describe('commuteLeaveNow', () => {
  const journeyAt = (h: number, m: number, expectedOffsetMs = 0) =>
    commuteJourney(
      trip(
        ride({
          line: '270',
          from: 'A',
          to: 'B',
          aimedStartMs: hm(h, m),
          aimedEndMs: hm(h, m) + 20 * 60_000,
          expectedStartMs: hm(h, m) + expectedOffsetMs,
          expectedEndMs: hm(h, m) + 20 * 60_000 + expectedOffsetMs,
          realtime: expectedOffsetMs !== 0,
        }),
      ),
      NOW,
    );

  it('splits the headline off the list, so neither says the other twice', () => {
    const { next, later } = commuteLeaveNow(
      [journeyAt(8, 36), journeyAt(8, 44), journeyAt(8, 51)],
      NOW,
    );
    expect(next?.departure.aimed).toBe('08:36');
    expect(later.map((journey) => journey.departure.aimed)).toEqual(['08:44', '08:51']);
  });

  it('drops a departure already gone from the list as well as from the headline', () => {
    // 08:15 at 08:32 is not an option, and a "next journeys" list that opens
    // with it is a timetable of the past.
    const { next, later } = commuteLeaveNow([journeyAt(8, 15), journeyAt(8, 44)], NOW);
    expect(next?.departure.aimed).toBe('08:44');
    expect(later).toEqual([]);
  });

  it('still offers a bus running late enough to still be catchable', () => {
    // Scheduled 08:30 (gone), running four minutes late, so it leaves at 08:34
    // — which is two minutes ago at 08:32 by the schedule and reachable by the
    // clock. Judged on the expected time, it is still the next departure.
    const { next } = commuteLeaveNow([journeyAt(8, 30, 4 * 60_000), journeyAt(8, 44)], NOW);
    expect(next?.departure.aimed).toBe('08:30');
  });
});

describe('labels', () => {
  it('formats durations the way a timetable prints them', () => {
    expect(commuteDurationLabel(48 * 60_000)).toBe('48 min');
    expect(commuteDurationLabel(60 * 60_000)).toBe('1 h');
    expect(commuteDurationLabel(72 * 60_000)).toBe('1 h 12 min');
  });

  it('says when it is, in Norwegian wall-clock terms', () => {
    expect(commuteNowLabel(NOW)).toBe('Tuesday 25 August · 08:32');
  });

  it('explains a weekday the commute is not saved for instead of blaming the timetable', () => {
    // Saturday, on a Mon–Fri commute.
    expect(commuteOffDayNote([1, 2, 3, 4, 5], 6)).toContain('not saved for today');
    expect(commuteOffDayNote([1, 2, 3, 4, 5], 2)).toBeNull();
    expect(commuteOffDayNote([], 6)).toBeNull();
  });
});

describe('commuteLineBadge', () => {
  it('uses the operator’s published pair when there is one', () => {
    expect(
      commuteLineBadge({ publicCode: '280', colour: '#E60000', textColour: '#FFFFFF' }),
    ).toEqual({ fill: '#E60000', text: '#FFFFFF' });
  });

  it('falls back to one neutral rather than inventing a colour per mode', () => {
    const badge = commuteLineBadge({ publicCode: '280' });
    expect(badge.fill).toBe(commuteLineBadge(undefined).fill);
    expect(badge.text).toBe('#ffffff');
  });

  it('chooses a legible foreground when the operator published only a fill', () => {
    // Ruter's own yellow: white on it is unreadable at 11 px, which is the
    // whole reason this is computed rather than defaulted.
    expect(commuteLineBadge({ publicCode: '1', colour: '#FFD520' }).text).toBe('#101418');
    expect(commuteLineBadge({ publicCode: '1', colour: '#00685E' }).text).toBe('#ffffff');
  });

  it('ignores a colour that is not a hex triple', () => {
    expect(commuteLineBadge({ publicCode: '1', colour: 'red' })).toEqual(
      commuteLineBadge(undefined),
    );
  });
});

describe('commuteRibbon', () => {
  const journey = () => commuteJourney(specJourney(), NOW);

  it('lays the journey out as vehicle, change, vehicle', () => {
    expect(commuteRibbon(journey()).map((part) => part.kind)).toEqual(['ride', 'change', 'ride']);
  });

  it('weights every part by its own minutes', () => {
    const [bus, change, train] = commuteRibbon(journey());
    // 08:36→09:02, 09:02→09:11, 09:11→09:24.
    expect(bus?.weight).toBe(26);
    expect(change?.weight).toBe(9);
    expect(train?.weight).toBe(13);
  });

  it('gives a short change a floor, so a change is always visible', () => {
    const tight = trip(
      ride({
        line: '270',
        from: 'Engelsrud Terrasse',
        to: 'Asker stasjon',
        aimedStartMs: hm(8, 36),
        aimedEndMs: hm(9, 2),
      }),
      ride({
        line: 'L1',
        mode: 'rail',
        from: 'Asker stasjon',
        to: 'Nationaltheatret',
        aimedStartMs: hm(9, 3),
        aimedEndMs: hm(9, 24),
      }),
    );
    const change = commuteRibbon(commuteJourney(tight, NOW))[1];
    expect(change?.kind).toBe('change');
    // One minute of wall clock, four of ribbon: below the floor a change rounds
    // to nothing and two vehicles appear to touch.
    expect(change?.weight).toBe(4);
    expect(change?.kind === 'change' && change.label).toBe('1m');
  });

  it('puts the correction on the leg carrying it, not on the journey', () => {
    const late = trip(
      ride({
        line: '270',
        from: 'Engelsrud Terrasse',
        to: 'Asker stasjon',
        aimedStartMs: hm(8, 36),
        aimedEndMs: hm(9, 2),
        expectedStartMs: hm(8, 39),
        expectedEndMs: hm(9, 5),
        realtime: true,
      }),
      ride({
        line: 'L1',
        mode: 'rail',
        from: 'Asker stasjon',
        to: 'Nationaltheatret',
        aimedStartMs: hm(9, 11),
        aimedEndMs: hm(9, 24),
      }),
    );
    const parts = commuteRibbon(commuteJourney(late, NOW));
    expect(parts[0]?.kind === 'ride' && parts[0].delay).toBe('+3');
    expect(parts[2]?.kind === 'ride' && parts[2].delay).toBeNull();
  });

  it('marks the change the caller says is broken, and only that one', () => {
    const parts = commuteRibbon(journey(), { brokenIndex: 1 });
    expect(parts[1]?.kind === 'change' && parts[1].broken).toBe(true);
    expect(commuteRibbon(journey())[1]?.kind === 'change' && commuteRibbon(journey())[1]).toEqual(
      expect.objectContaining({ broken: false }),
    );
  });
});

describe('commuteRibbonProgress', () => {
  const parts = () => commuteRibbon(commuteJourney(specJourney(), NOW));

  it('is null before the journey starts', () => {
    expect(commuteRibbonProgress(parts(), hm(8, 30))).toBeNull();
  });

  it('is 100 once it has finished', () => {
    expect(commuteRibbonProgress(parts(), hm(9, 40))).toBe(100);
  });

  it('is measured on the ribbon’s weights, not on elapsed minutes', () => {
    // Half way through the 26-minute bus: 13 of the bar's 48 weight units.
    const half = commuteRibbonProgress(parts(), hm(8, 49));
    expect(half).toBeCloseTo((13 / 48) * 100, 5);
  });

  it('lands inside the change while the traveller is standing at it', () => {
    const at904 = commuteRibbonProgress(parts(), hm(9, 4))!;
    const busShare = (26 / 48) * 100;
    const changeShare = (9 / 48) * 100;
    expect(at904).toBeGreaterThan(busShare);
    expect(at904).toBeLessThan(busShare + changeShare);
  });
});

describe('commuteSharedDisruptions', () => {
  const withNotice = (id: string, aimedStartMs: number) =>
    commuteJourney(
      trip(
        ride({
          line: '270',
          from: 'Engelsrud Terrasse',
          to: 'Asker stasjon',
          aimedStartMs,
          aimedEndMs: aimedStartMs + 20 * 60_000,
          situations: [
            {
              id,
              severity: 'warning',
              summary: 'Signal problems',
              planned: false,
            } as TransitSituation,
          ],
        }),
      ),
      NOW,
    );

  it('lifts a notice every listed journey carries', () => {
    const shared = commuteSharedDisruptions([
      withNotice('S1', hm(8, 36)),
      withNotice('S1', hm(8, 48)),
    ]);
    expect(shared.map((item) => item.key)).toEqual(['S1']);
  });

  it('leaves a notice that only some journeys carry where it is', () => {
    const clean = commuteJourney(specJourney(), NOW);
    expect(commuteSharedDisruptions([withNotice('S1', hm(8, 36)), clean])).toEqual([]);
  });

  it('lifts nothing out of a single journey, which has no “every” to speak of', () => {
    expect(commuteSharedDisruptions([withNotice('S1', hm(8, 36))])).toEqual([]);
  });
});

describe('commuteFreshnessLabel', () => {
  it('says how old the live times are, and never lets a failed refresh look current', () => {
    const checked = hm(8, 32);
    expect(commuteFreshnessLabel({ updatedMs: null, loading: true, failed: false })).toBe(
      'Checking live times…',
    );
    expect(commuteFreshnessLabel({ updatedMs: checked, loading: false, failed: false })).toBe(
      'Live times checked 08:32',
    );
    expect(commuteFreshnessLabel({ updatedMs: checked, loading: true, failed: false })).toBe(
      'Updating · last checked 08:32',
    );
    expect(commuteFreshnessLabel({ updatedMs: checked, loading: false, failed: true })).toBe(
      'Couldn’t update · last checked 08:32',
    );
  });
});
