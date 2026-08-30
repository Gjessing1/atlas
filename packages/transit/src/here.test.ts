import { describe, expect, it } from 'vitest';

import { norwayInstant } from './clock.js';
import { commuteBoardRows, commuteJourney } from './dashboard.js';
import { commuteHere } from './here.js';
import type { TransitLeg, TransitResult, TransitTrip } from './model.js';

/** Tuesday 25 August 2026 — the same clock the dashboard spec is written on. */
const hm = (hours: number, minutes: number) => norwayInstant(2026, 7, 25, hours * 60 + minutes);

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
    realtime: true,
    from: place(from),
    to: place(to),
    line: { id: `X:Line:${line}`, publicCode: line, headsign: to },
    intermediateStops: [],
    points: [],
    situations: [],
    ...rest,
  };
}

const trip = (...legs: TransitLeg[]): TransitTrip => ({
  startMs: legs[0]!.expectedStartMs,
  endMs: legs[legs.length - 1]!.expectedEndMs,
  durationMs: legs[legs.length - 1]!.expectedEndMs - legs[0]!.expectedStartMs,
  walkDistanceM: 0,
  legs,
});

/** 08:36 bus → 09:02 Asker, 09:11 train → 09:24. */
const corridor = (overrides: { bus?: Partial<TransitLeg>; train?: Partial<TransitLeg> } = {}) =>
  trip(
    ride({
      line: '280',
      from: 'Engelsrud terrasse',
      to: 'Asker stasjon',
      aimedStartMs: hm(8, 36),
      aimedEndMs: hm(9, 2),
      ...overrides.bus,
    }),
    ride({
      line: 'R14',
      mode: 'rail',
      from: 'Asker stasjon',
      to: 'Nationaltheatret',
      aimedStartMs: hm(9, 11),
      aimedEndMs: hm(9, 24),
      ...overrides.train,
    }),
  );

/** A hop board offering the trains after the one the journey names. */
const trainBoard = (...minutes: number[]): TransitResult => ({
  trips: minutes.map((minute) =>
    trip(
      ride({
        line: 'R14',
        mode: 'rail',
        from: 'Asker stasjon',
        to: 'Nationaltheatret',
        aimedStartMs: hm(9, minute),
        aimedEndMs: hm(9, minute + 13),
      }),
    ),
  ),
  problems: [],
});

describe('commuteHere', () => {
  it('says the journey is only being followed until it starts', () => {
    const here = commuteHere(commuteJourney(corridor(), hm(8, 10)), hm(8, 10))!;
    expect(here.phase).toBe('upcoming');
    expect(here.heading).toBe('Tracking');
    // "You are here" is a claim, and before the first vehicle has left it is
    // not a true one.
    expect(here.lead).toBe('Leaves Engelsrud terrasse 08:36');
  });

  it('says where you are once you are on the vehicle', () => {
    const here = commuteHere(commuteJourney(corridor(), hm(8, 50)), hm(8, 50))!;
    expect(here.phase).toBe('riding');
    expect(here.heading).toBe('You are here');
    expect(here.title).toBe('280 to Asker stasjon');
    expect(here.lead).toBe('Arrives Asker stasjon 09:02');
    expect(here.rideIndex).toBe(0);
  });

  it('names the vehicle to board while standing at the change', () => {
    const here = commuteHere(commuteJourney(corridor(), hm(9, 6)), hm(9, 6))!;
    expect(here.phase).toBe('interchange');
    expect(here.ride.line).toBe('R14');
    expect(here.lead).toBe('Leaves Asker stasjon 09:11');
  });

  it('offers no connection once the last vehicle has arrived', () => {
    const here = commuteHere(commuteJourney(corridor(), hm(9, 30)), hm(9, 30))!;
    expect(here.phase).toBe('arrived');
    expect(here.connections).toEqual([]);
    expect(here.connectionRideIndex).toBeNull();
  });

  it('states the change ahead while still on the first vehicle', () => {
    const here = commuteHere(commuteJourney(corridor(), hm(8, 50)), hm(8, 50))!;
    // The change ahead is out of the bus, not into it.
    expect(here.connectionRideIndex).toBe(1);
    expect(here.connections[0]).toMatchObject({
      aimed: '09:11',
      line: 'R14',
      booked: true,
      missed: false,
      note: '9 min change',
    });
  });

  it('keeps the booked connection on the list once the numbers have broken it', () => {
    // The bus is now expected at 09:11, and the change needs a minute — so the
    // 09:11 train leaves before the traveller can be standing on its platform.
    const broken = corridor({
      bus: { expectedStartMs: hm(8, 45), expectedEndMs: hm(9, 11) },
    });
    const here = commuteHere(commuteJourney(broken, hm(8, 50)), hm(8, 50), [])!;
    expect(here.broken?.at).toBe('Asker stasjon');
    expect(here.connections[0]).toMatchObject({ aimed: '09:11', booked: true, missed: true });
    expect(here.connections[0]?.note).toBe('missed by 1 min');
  });

  it('offers the next departure of the same hop beside the booked one', () => {
    const journey = commuteJourney(corridor(), hm(8, 50));
    const alternatives = commuteBoardRows(trainBoard(11, 26, 41), hm(8, 50));
    const here = commuteHere(journey, hm(8, 50), alternatives)!;
    // The booked 09:11 is in that board too and must not be listed twice.
    expect(here.connections.map((row) => row.aimed)).toEqual(['09:11', '09:26']);
    // Measured the same way the booked row is — the wait at the change, not the
    // time from now, so the two rows are comparable.
    expect(here.connections[1]).toMatchObject({
      booked: false,
      missed: false,
      note: '24 min change',
    });
  });

  it('places "now" on the ribbon rather than leaving it to the client', () => {
    const journey = commuteJourney(corridor(), hm(8, 49));
    const here = commuteHere(journey, hm(8, 49))!;
    expect(here.parts.map((part) => part.kind)).toEqual(['ride', 'change', 'ride']);
    expect(here.progress).toBeGreaterThan(0);
    expect(here.progress).toBeLessThan(100);
  });

  it('reports the operator’s record as the source when there is one', () => {
    const onRecord = corridor({ bus: { actualStartMs: hm(8, 37) } });
    expect(commuteHere(commuteJourney(onRecord, hm(8, 50)), hm(8, 50))?.source).toBe('record');
    expect(commuteHere(commuteJourney(corridor(), hm(8, 50)), hm(8, 50))?.source).toBe('clock');
  });
});
