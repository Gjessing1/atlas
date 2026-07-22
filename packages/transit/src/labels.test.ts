import { describe, expect, it } from 'vitest';

import {
  bookingDeadlineLabel,
  bookingHowLabel,
  bookingSummaryLabel,
  delayLabel,
  DELAY_THRESHOLD_MS,
  legStopsLabel,
  legTimeParts,
  quayLabel,
  severityFlagLabel,
  severityMark,
  transfersLabel,
  tripSummary,
  walkLegLabel,
} from './labels.js';
import type { TransitLeg, TransitMode, TransitPlace, TransitTrip } from './model.js';

const at = (h: number, m: number) => new Date(2026, 6, 21, h, m).getTime();

const place = (name: string, quay?: string): TransitPlace => ({
  name,
  position: { lat: 59.9, lng: 10.7 },
  ...(quay ? { quay: { publicCode: quay } } : {}),
});

function leg(over: Partial<TransitLeg> = {}): TransitLeg {
  return {
    mode: 'bus' as TransitMode,
    distanceM: 4200,
    durationMs: 12 * 60_000,
    aimedStartMs: at(8, 0),
    expectedStartMs: at(8, 0),
    aimedEndMs: at(8, 12),
    expectedEndMs: at(8, 12),
    realtime: false,
    from: place('Asker'),
    to: place('Sandvika'),
    intermediateStops: [],
    points: [],
    situations: [],
    ...over,
  };
}

function trip(over: Partial<TransitTrip> = {}): TransitTrip {
  return {
    startMs: at(8, 0),
    endMs: at(8, 52),
    durationMs: 52 * 60_000,
    walkDistanceM: 1200,
    legs: [leg()],
    ...over,
  };
}

describe('legTimeParts', () => {
  it('shows only the expected time when nothing is off schedule', () => {
    const parts = legTimeParts({ aimedMs: at(8, 0), expectedMs: at(8, 0), realtime: true });
    expect(parts).toEqual({ aimed: '08:00', expected: '08:00', delay: null, tone: 'ontime' });
  });

  it('ignores sub-minute drift — that is timetable noise, not news', () => {
    const parts = legTimeParts({
      aimedMs: at(8, 0),
      expectedMs: at(8, 0) + DELAY_THRESHOLD_MS - 1,
      realtime: true,
    });
    expect(parts.delay).toBeNull();
    expect(parts.tone).toBe('ontime');
  });

  it('corrects a late departure and keeps the timetabled time', () => {
    const parts = legTimeParts({ aimedMs: at(8, 0), expectedMs: at(8, 4), realtime: true });
    expect(parts).toEqual({ aimed: '08:00', expected: '08:04', delay: '+4 min', tone: 'late' });
  });

  it('marks an early departure as early, signed', () => {
    const parts = legTimeParts({ aimedMs: at(8, 5), expectedMs: at(8, 3), realtime: true });
    expect(parts).toEqual({ aimed: '08:05', expected: '08:03', delay: '-2 min', tone: 'early' });
  });

  it('never corrects a time no live feed vouched for', () => {
    // Some planners pre-fill `expected` from a projection; without `realtime`
    // that is still a timetable, and painting it as a delay invents news.
    const parts = legTimeParts({ aimedMs: at(8, 0), expectedMs: at(8, 9), realtime: false });
    expect(parts.delay).toBeNull();
    expect(parts.tone).toBe('ontime');
  });
});

describe('quayLabel', () => {
  it('names the platform as the sign does', () => {
    expect(quayLabel(place('Oslo S', '3'))).toBe('plat. 3');
  });

  it('is absent rather than empty when the stop has no quay', () => {
    expect(quayLabel(place('Oslo S'))).toBeNull();
    expect(quayLabel({ ...place('Oslo S'), quay: {} })).toBeNull();
  });
});

describe('booking labels', () => {
  it('prefers the phone number, which is the fastest way to actually book', () => {
    expect(bookingHowLabel({ methods: ['online'], phone: '177', url: 'https://x' })).toBe(
      'Book by phone: 177',
    );
  });

  it('only offers online booking when there is a link to follow', () => {
    expect(bookingHowLabel({ methods: ['online'], url: 'https://x' })).toBe(
      'Book online before travelling',
    );
    expect(bookingHowLabel({ methods: ['online'] })).toBe('This service must be booked in advance');
  });

  it('falls through the remaining methods in the order a traveller would try them', () => {
    expect(bookingHowLabel({ methods: ['callDriver'] })).toBe('Call the driver to book');
    expect(bookingHowLabel({ methods: ['callOffice'] })).toBe('Call the operator to book');
    expect(bookingHowLabel({ methods: ['text'] })).toBe('Book by text message');
  });

  it('phrases the deadline the way the operator means it', () => {
    expect(bookingDeadlineLabel({ methods: [], latestTime: '14:00' })).toBe(
      'by 14:00 the same day',
    );
    expect(bookingDeadlineLabel({ methods: [], latestTime: '14:00', latestDayOffset: 1 })).toBe(
      'by 14:00 the day before',
    );
    expect(bookingDeadlineLabel({ methods: [], latestTime: '14:00', latestDayOffset: 3 })).toBe(
      'by 14:00, 3 days ahead',
    );
    expect(bookingDeadlineLabel({ methods: [] })).toBeNull();
  });

  it('states the requirement with the deadline when there is one, without when there is not', () => {
    expect(bookingSummaryLabel({ methods: [], latestTime: '14:00' })).toBe(
      'Must be booked ahead — by 14:00 the same day',
    );
    expect(bookingSummaryLabel({ methods: [] })).toBe('Must be booked ahead');
  });
});

describe('leg labels', () => {
  it('counts stops with their duration, singular and plural', () => {
    expect(legStopsLabel(leg({ intermediateStops: [place('Slependen')] }))).toBe('1 stop · 12 min');
    expect(legStopsLabel(leg({ intermediateStops: [place('Slependen'), place('Høvik')] }))).toBe(
      '2 stops · 12 min',
    );
  });

  it('tells a walk leg by duration, distance and where it leads', () => {
    expect(walkLegLabel(leg({ mode: 'foot', durationMs: 5 * 60_000, distanceM: 400 }))).toBe(
      'Walk 5 min · 400 m to Sandvika',
    );
  });

  it('drops the destination clause when the walk ends at a bare coordinate', () => {
    const anonymous = leg({ mode: 'foot', durationMs: 60_000, distanceM: 80, to: place('') });
    expect(walkLegLabel(anonymous)).toBe('Walk 1 min · 80 m');
  });
});

describe('severity and transfer wording', () => {
  it('leads info with a letter and anything worse with a bang', () => {
    expect(severityMark('info')).toBe('i');
    expect(severityMark('warning')).toBe('!');
    expect(severityMark('severe')).toBe('!');
  });

  it('names only what the traveller must act on differently', () => {
    expect(severityFlagLabel('severe')).toBe('Disruption');
    expect(severityFlagLabel('warning')).toBe('Notice');
    expect(severityFlagLabel('info')).toBe('Notice');
  });

  it('calls no changes direct, and pluralises the rest', () => {
    expect(transfersLabel(0)).toBe('direct');
    expect(transfersLabel(1)).toBe('1 change');
    expect(transfersLabel(2)).toBe('2 changes');
  });

  it('signs a delay the way a departure board does', () => {
    expect(delayLabel(4 * 60_000)).toBe('+4 min');
    expect(delayLabel(-2 * 60_000)).toBe('-2 min');
  });
});

describe('tripSummary', () => {
  it('describes a plain direct journey', () => {
    const summary = tripSummary(trip());
    expect(summary.times).toBe('08:00 – 08:52');
    expect(summary.meta).toBe('52 min · direct');
    expect(summary.walk).toBe('1.2 km');
    expect(summary.delay).toBeNull();
    expect(summary.severity).toBeNull();
    expect(summary.needsBooking).toBe(false);
  });

  it('quotes the delay of the first vehicle boarded, not of the walk to it', () => {
    // The walk cannot be late; the bus you have to catch can, and that is the
    // number that decides whether the journey happens at all.
    const summary = tripSummary(
      trip({
        legs: [
          leg({ mode: 'foot', aimedStartMs: at(7, 55), expectedStartMs: at(7, 55) }),
          leg({ expectedStartMs: at(8, 6), realtime: true }),
        ],
      }),
    );
    expect(summary.delay).toBe('+6 min');
  });

  it('stays silent about a delay the planner never confirmed', () => {
    const summary = tripSummary(trip({ legs: [leg({ expectedStartMs: at(8, 6) })] }));
    expect(summary.delay).toBeNull();
  });

  it('surfaces the worst disruption inside, so a collapsed card cannot look clean', () => {
    const summary = tripSummary(
      trip({
        legs: [
          leg({ situations: [{ summary: 'Lift out of order', severity: 'info' }] }),
          leg({ situations: [{ summary: 'Train cancelled', severity: 'severe' }] }),
        ],
      }),
    );
    expect(summary.severity).toBe('severe');
    expect(summary.severityLabel).toBe('Disruption');
  });

  it('flags a journey with a leg that only runs if it is booked', () => {
    const summary = tripSummary(trip({ legs: [leg({ booking: { methods: ['callOffice'] } })] }));
    expect(summary.needsBooking).toBe(true);
  });

  it('counts changes and lists the lines in boarding order', () => {
    const summary = tripSummary(
      trip({
        legs: [
          leg({ mode: 'foot' }),
          leg({ line: { publicCode: '280' } }),
          leg({ mode: 'rail', line: { publicCode: 'R14' } }),
        ],
      }),
    );
    expect(summary.transfers).toBe(1);
    expect(summary.meta).toBe('52 min · 1 change');
    expect(summary.lineCodes).toEqual(['280', 'R14']);
  });
});
