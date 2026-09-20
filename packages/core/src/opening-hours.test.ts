import { describe, expect, it } from 'vitest';

import { openingHoursComment, parseOpeningHours, websiteDisplayName } from './opening-hours.js';

const at = (day: number, hour: number, minute = 0) =>
  new Date(2026, 8, 21 + day, hour, minute).getTime(); // Monday 21 September

/**
 * A systematic sample of the real values in the local Europe POI database
 * (`/mnt/data/atlas/poi/europe.sqlite`), drawn 2026-09-20 as every nth row of
 * each city's whole population. The grammar answered the full populations at
 * 97.1% of Oslo's 2889 values, 97.3% of Bergen's 1209 and 96.5% of Berlin's
 * 23 681; the floors below are what these samples score today. They are a
 * ratchet: a grammar change that reads more is welcome, one that reads less
 * fails here rather than quietly showing fewer people an opening status.
 */
const OSLO_SAMPLE = `Mo 11:00-22:30; Tu-Sa 11:00-23:30; Su 13:00-22:30
Mo-Sa 07:00-23:00
Mo-Fr 08:00-22:00, Sa 09:00-20:00
Mo-Fr 10:00-18:00; Sa 10:00-16:00; Su closed
Mo-Fr 07:00-23:00; Sa-Su 08:00-23:00
Mo-Fr 07:00-14:00
Mo-Fr 06:00-22:00, Sa-Su 08:00-22:00
Mo-Fr 10:00-18:00; Sa 10:00-16:00; Su closed
Mo-Sa 07:00-23:00
Mo-Sa 15:00-23:00; Su 15:00-22:00
Tu-Fr 11:00-19:00; Sa-Su 12:00-20:00
Mo-Fr 09:00-17:00; Sa 10:00-16:00
Mo-Sa 09:00-21:00, Su 10:00-20:00
24/7
24/7
24/7
Mo-Th 10:00-00:30; Fr-Sa 10:00-03:30; Su 12:00-19:30
24/7
Mo-Sa 10:00-21:30; Su 14:30-21:30
Mo-Th 12:00-23:00; Fr 12:00-24:00; Sa 13:00-24:00; Su 13:00-23:00
Mo-Th 10:00-23:30; Fr-Sa 10:00-01:30; Su 11:00-23:00
Mo-We 10:00-01:00, Th-Sa 10:00-04:00, Su 10:00-01:00
Mo-Fr 09:00-21:00; Sa-Su 10:00-20:00
Mo-Sa 16:30-24:00
Mo-Su 10:00-20:00
Mo-Sa 07:00-23:00
Mo-Fr 10:00-17:00; Sa 10:00-14:00
Mo-Th 05:45-22:00; Fr 05:45-23:00; Sa 08:00-23:00; Su 09:00-21:00
Mo-Sa 10:00-17:00
Mo-Su 11:00-05:00
Mo-Sa 07:00-23:00
Mo-Sa 15:00-20:00
Mo-Su 15:00-22:00
Mo-Fr 09:00-20:00; Sa 10:00-18:00
Mo-Fr 10:00-19:00; Sa 10:00-18:00
Mo-Sa 10:00-19:00
Mo-Fr 11:00-22:00; Sa,Su 12:00-22:00
Mo 15:00-21:00, Tu-Fr 10:00-15:00
Mo-Fr 10:00-18:00; Sa 10:00-16:00; Su closed
Mo-Fr 10:00-20:00; Sa 10:00-18:00
Mo-Sa 07:00-23:00
24/7
24/7
24/7
24/7
Mo-Fr 07:00-23:00, Sa 09:00-21:00
Mo-Fr 08:00-22:00, Sa 09:00-20:00
Mo-Fr 06:30-20:30; Sa 08:30-20:30; Su 10:00-20:30
Mo-Fr 09:00-20:00, Sa 10:00-18:00
Mo-Fr 10:00-21:00, Sa 10:00-19:00
Tu 17:00-20:00; Th 17:00-20:00
Mo,Tu 07:30-17:00; We-Fr 07:30-21:00; Sa 08:00-21:00; Su 09:00-18:00
Mo-Fr 08:00-21:00, Sa 09:00-20:00
Mo-Fr 10:00-21:00; Sa 10:00-20:00
Mo-Sa 07:00-23:00
Mo-Fr 10:00-22:00; Sa 10:00-20:00
Mo-Fr 07:00-16:00
Mo-Fr 10:00-19:00; Sa 10:00-17:00
24/7
Mo-Su 11:00-22:00
Mo-Fr 09:00-19:00; Sa 10:00-17:00
Mo-Fr 09:00-19:00; S:09:00-16
Mo-Fr 10:00-17:00; Sa 10:00-16:00; Su 12:00-16:00
Mo-Fr 06:00-02:00, Sa 00:00-24:00, Su 00:00-02:00
Mo-Fr 10:00-20:00; Sa 10:00-18:00
Mo-Sa 12:00-18:00; Su 13:00-16:00
Mo-Fr 10:00-19:00; Sa 10:00-18:00
Mo-We 11:00-22:00; Th 11:00-23:00; Fr-Sa 11:00-01:00; Su 12:00-22:00
Mo-Fr 09:00-20:00; Sa 09:00-18:00; Su 12:00-17:00
Mo-Su 15:00-22:30
Mo-Sa 07:00-23:00
Mo-Su 12:00-21:00
Mo-Th 11:00-20:00; Fr 11:00-22:00; Sa 12:00-22:00; Su 12:00-20:00
Mo-Fr 06:00-00:00, Sa-Su 09:00-00:00
Mo-Sa 07:00-23:00
Mo-Fr 10:00-18:00; Sa 10:00-16:00
Tu-We 18:00-21:00; Th-Sa 17:00-23:00
Mo-Fr 10:00-18:00; Sa 10:00-17:00
Mo-Fr 09:00-19:00; Sa 09:00-18:00
Mo-Fr 10:00-19:00; Sa 09:00-17:00
Mo-Su 06:00-23:00
Su-Tu, Th-Fr 11:00-22:00; We 09:00-22:00; Sa 13:00-22:00
Mo-Fr 10:00-21:00; Sa 10:00-19:00
Mo-Fr 10:00-21:00; Sa 09:00-19:00
24/7
Mo-Fr 09:00-19:00; Sa 09:00-18:00
Mo-Fr 10:00-21:00; Sa 10:00-19:00
Mo-sat 10:00-20:00
24/7
24/7`;

const BERGEN_SAMPLE = `Mo-Su 06:00-24:00
Mo 11:30-23:30; Tu-Th 11:30-00:30; Fr-Sa 11:30-01:30; Su 12:00-01:30
Mo-Fr 09:00-20:00, Sa 09:00-18:00
Mo-Sa 07:00-23:00
Mo-Sa 07:00-23:00
Mo-Fr 10:00-20:00; Sa 10:00-18:00
Mo, Fr 08:30-16:00; Tu, Th 08:30-17:00; We 08:30-18:00
24/7
24/7
Mo-We 11:00-22:00; Th-Sa 11:00-00:00; Su 12:00-22:00
Mo-Fr 08:00-18:00; Sa 09:00-18:00
Mo-Fr 10:00-18:00; Sa 11:00-16:00
Mo-Fr 08:00-22:00, Sa 08:00-20:00, Su 09:00-22:00
Mo-Fr 07:00-22:00, Sa 08:00-21:00, Su 09:00-22:00
Mo-Sa 18:00-21:00
Mo-Su 10:00-22:00
Mo 09:00-15:00; Tu,Th 09:00-19:00; We,Fr 09:00-17:00; Sa,Su off
Mo-Fr 09:30-18:00
Mo-Su 13:00-23:00
Mo-Fr 09:00-21:00, Sa 09:00-18:00
Mo-Fr 10:00-18:00; Sa 09:30-17:00
Mo-Sa 07:00-23:00
Mo-Fr 10:00-17:00; Sa 10:00-15:00
Mo-We,Fr 09:00-17:00; Th 09:00-20:00; Sa 09:00-14:00
Mo-Fr 06:00-23:00, Sa 07:00-21:00
Mo-We,Fr 08:30-16:30; Sa 09:00-13:00; Th 09:00-17:00
Mo-Fr 08:00-17:00; Sa 09:00-17:00; Su 10:00-17:00
Mo-Fr 07:00-17:00
Sa-Su 12:00-17:00
Mo-Su 15:00-22:00
Mo-Fr 10:00-21:00; Sa 10:00-18:00
10:00-18:00
Su-We 10:00-24:00, Th-Sa 10:00-04:00
Mo-Th 11:00-22:00; Fr,Sa 11:00-23:00; Su 11:00-22:00
Mo 09:00-15:00; Th 09:00-17:00; We-Th 09:00-20:00; Fr 10:00-18:00; Sa 09:00-16:00
Mo-Fr 11:00-24:00; Sa 00:00-01:00,11:00-24:00; Su 00:00-01:00,12:00-23:00
Mo-Fr 11:00-20:00
Mo-We 10:00-17:00; Th 10:00-19:00; Fr 10:00-17:00; Sa 10:00-16:00
Mo-Sa 07:00-23:00
24/7
Mo-Sa 09:00-24:00
24/7
Mo-We,Fr 10:00-17:00; Th 10:00-18:00; Sa 10:00-16:00; Su off
Mo-Fr 10:00-20:00, Sa 10:00-18:00
Mo-Fr 08:00-16:00
Mo-Th 11:00-21:00; Fr,Sa 11:00-22:00; Su 12:00-21:00
Mo-Fr 08:00-16:00, Sa 10:00-14:00
Mo-fri 10:00-22:00 Sa 10:00-18:00
Mo-Fr 10:00-21:00; Sa 10:00-18:00
Mo-Fr 08:00-18:00, Sa 09:00-18:00, Su 11:00-17:00
Mo-Sa 09:00-21:00; Su 10:00-21:00
24/7
Mo-Tu,Su off; We-Sa 12:00-18:00
Mo-Th 14:00-22:00; Fr,Sa 14:00-23:00; Su 13:00-21:00
Mo-Su 13:00-22:00
Mo-Fr 10:00-21:00; Sa 10:00-18:00
24/7
Mo-Fr 08:30-19:00; Sa-Su 12:30-19:00
Mo-Sa 07:00-23:00
Mo-Fr 06:45-19:15; Sa-Su 07:30-16:00`;

const BERLIN_SAMPLE = `24/7
Mo-Fr 08:00-18:30; Sa 09:00-13:00; Su,PH off
Mo-Fr 09:00-19:00; Sa 09:00-18:00
Mo-Fr 08:30-20:00; Sa 09:00-20:00
Mo-Sa 10:00-21:00; Su,PH 10:00-21:00
Tu,Th 10:00-13:00,14:00-18:00; We,Fr 10:00-13:00; Mo 10:00-13:00,14:00-16:00
Mo-Sa 08:00-21:00; PH off
Mo-Sa 10:00-20:00
Mo-Fr 13:00-18:00; Sa 10:00-14:00
Mo,Tu,Th 13:00-18:00
24/7
Mo-Fr 09:00-20:00, Sa 08:00-18:00
Mo-Su 09:00-24:00
Tu-Fr 10:00-18:00
Mo-Su,PH 12:00-23:00
Mo-Sa 09:00-18:00
Mo-Fr 06:00-18:00; Sa 07:00-17:00; Su,PH 08:00-15:00
Sa 08:30-13:30; Mo 08:30-12:00; Tu-Fr 08:30-16:00
Mo-Sa 10:00-20:00
Mo-Su 10:00-18:00
Su, We-Th 18:00-00:00; Fr 12:00-14:00, 18:00-00:00; Sa 18:00-00:00
Mo-We 09:00-17:00; Th-Su 09:00-18:00
Su-Th,PH 11:00-24:00, Fr,Sa 11:00-02:00
Tu-Fr 09:00-18:00; Sa 09:00-16:00; Mo,PH off
Mo-Fr 10:00-18:00; Sa 10:00-16:00
Mo-Th 09:00-00:30, Fr-Su 09:00-02:00
Mo-Su 10:00-19:00
Mo-Sa 10:00-21:00
Mo-Fr 10:00-18:00; Sa 10:00-14:00
Mo-Fr 09:00-19:00, Sa 09:00-16:00
Tu-Su 11:30-22:00
Mo-Fr 09:00-18:00; Sa 10:00-18:00
Mo-Sa 08:00-20:00
Mo-Th 14:00-22:00; Fr 14:00-24:00; Sa 10:00-24:00; Su 10:00-20:15
Mo,Tu 15:00-23:00; We-Su 11:30-23:00
Mo-Fr 08:00-18:00; Sa 10:00-18:00; Su,PH off
Tu-Sa 09:00-18:00; Su 09:00-21:00
Mo-Fr 10:30-19:00; Sa 10:30-18:00
Mo-Tu,Su,PH off; We-Sa 12:00-18:00
Mo-Fr 08:00-17:00
"nach Terminvereinbarung"
Mo-Fr 10:00-18:00
Tu-Fr 11:00-19:00; Sa 11:00-15:00; Mo off
We-Mo 12:00-22:00
12:00-24:00
"nur nach Terminvereinbarung"
Mo-Su,PH 08:00-19:00; Dec 25 off
Tu-Fr 09:30-18:00; Sa 09:30-17:00
Mo-Fr 09:00-01:00; Sa, Su 10:00+
Mo-Fr 08:00-18:00; Sa 08:00-14:00
Mo-Su 11:30-23:00
Mo-Fr 12:00-15:00, 18:00-22:00; Sa 18:00-22:00
Mo-Fr 06:15-19:00; Sa 08:00-14:00
Mo-Sa 10:00-20:00
Mo-Fr 09:00-19:30, Sa 09:00-16:00; PH off
Mo-Sa 11:00-21:00; Su,PH off
Mo-Fr 11:00-21:00; Su,PH 12:00-21:00; Sa off
Mo-Fr 11:00-19:00; Sa 10:00-19:00
Mo-Sa 09:00-19:00
Mo-Fr 09:00-19:00; Sa 09:00-17:00
Mo-Fr 09:30-19:00; Sa 09:30-16:00
Mo-Fr 10:00-19:00; Sa 10:00-16:00
Mo-Sa 07:00-20:00
Mo-Fr 09:00-15:30; Sa 09:00-11:00
Mo-Fr 12:00-17:00
Su-Th 11:45-23:00, Fr,Sa 11:45-01:00
Mo-Fr 09:00-18:00; Sa 10:00-13:00
Mo-Fr 09:00-18:30, Sa 09:00-14:00
Mo-Sa 07:00-20:00
Mo-Sa 09:00-20:00
Mo-Su 12:00-01:00
24/7
Mo,Tu 11:00-17:00; We 09:00-15:30; Th-Sa 09:00-17:00
06:30-22:00
Mo-Th 12:00-23:00; Fr,Sa 12:00-24:00
Tu-Fr 07:30-16:00; Sa 08:30-16:30; Su,Mo off
Mo-Fr 08:00-19:00; Sa 08:00-18:00; Su,PH 09:00-13:00
Mo-Sa 11:30-19:30
Mo-Sa 15:00-22:00
Mo-Fr 13:00-19:00, Sa 11:00-16:00
Mo-Su 11:30-22:30
Mo-Sa 10:00-20:00
Mo-Fr 09:00-20:00, Sa 09:00-20:00
Mo-Th 10:00-20:00; Fr,Sa 09:00-20:00; Su,PH off
Mo-Fr 09:30-18:00; Sa 09:30-15:00
Mo-Fr 09:00-20:00; Sa 09:00-18:00
24/7
24/7
Mo-Sa 06:00-22:00
Mo-Sa 09:00-21:00`;

const SAMPLE_FLOORS = [
  { city: 'Oslo', sample: OSLO_SAMPLE, floor: 88 },
  { city: 'Bergen', sample: BERGEN_SAMPLE, floor: 59 },
  { city: 'Berlin', sample: BERLIN_SAMPLE, floor: 88 },
] as const;

describe('parseOpeningHours', () => {
  it('recognises 24/7 without inventing a closing event', () => {
    expect(parseOpeningHours('24/7', at(0, 3))).toMatchObject({
      isOpen: true,
      statusText: 'Open 24 hours',
      nextOpenOrClose: null,
      todayHours: 'Open 24 hours',
    });
  });

  it('evaluates weekday ranges and gives a metric 24-hour next event', () => {
    const open = parseOpeningHours('Mo-Fr 08:00-22:00; Sa 09:00-20:00; Su off', at(0, 12));
    expect(open).toMatchObject({
      isOpen: true,
      statusText: 'Open',
      nextOpenOrClose: 'Closes 22:00',
      todayHours: '08:00–22:00',
    });
    const closed = parseOpeningHours('Mo-Fr 08:00-22:00; Sa 09:00-20:00; Su off', at(6, 12));
    expect(closed?.nextOpenOrClose).toBe('Opens tomorrow 08:00');
  });

  it('disambiguates commas joining spans from commas joining whole rules', () => {
    const value = 'Mo-Fr 08:00-12:00,13:00-22:00, Sa 08:00-20:00, Su closed';
    expect(parseOpeningHours(value, at(0, 12, 30))).toMatchObject({
      isOpen: false,
      nextOpenOrClose: 'Opens 13:00',
      todayHours: '08:00–12:00, 13:00–22:00',
    });
    expect(parseOpeningHours(value, at(5, 19))?.todayHours).toBe('08:00–20:00');
  });

  it('handles 24:00, overnight spans, and split intervals', () => {
    expect(parseOpeningHours('Mo 10:00-14:00,16:00-24:00', at(0, 23))?.nextOpenOrClose).toBe(
      'Closes 00:00',
    );
    expect(parseOpeningHours('Mo 18:00-02:00', at(1, 1))).toMatchObject({
      isOpen: true,
      nextOpenOrClose: 'Closes 02:00',
    });
  });

  it('reads a rule with no day selector as every day', () => {
    expect(parseOpeningHours('12:00-24:00', at(2, 13))).toMatchObject({
      isOpen: true,
      statusText: 'Open',
      todayHours: '12:00–24:00',
      nextOpenOrClose: 'Closes 00:00',
    });
    expect(parseOpeningHours('11:00-23:00', at(5, 2))?.isOpen).toBe(false);
  });

  it('accepts holiday selectors without pretending to know the holiday calendar', () => {
    expect(parseOpeningHours('Mo-Sa 09:00-18:00; Su,PH off', at(6, 12))).toMatchObject({
      isOpen: false,
      todayHours: 'Closed',
    });
  });

  it.each([
    'Apr-Oct 09:00-18:00',
    'week 01-20 Mo 09:00-18:00',
    'Su[-1] 09:00-18:00',
    '18:00+',
    'sunrise-sunset',
    'Mo-Fr 09:00-18:00 "appointment only"',
  ])('returns null for unsupported or ambiguous syntax: %s', (value) => {
    expect(parseOpeningHours(value, at(0, 12))).toBeNull();
  });

  it('keeps an exact quoted comment available as text, never as a status', () => {
    expect(parseOpeningHours('"Etter avtale"', at(0, 12))).toBeNull();
    expect(openingHoursComment(' "Etter avtale" ')).toBe('Etter avtale');
  });

  it('keeps its measured coverage of the real database samples', () => {
    for (const { city, sample, floor } of SAMPLE_FLOORS) {
      const values = sample.split('\n');
      // A quoted comment is answered too — as its own text, never as a status.
      const answered = values.filter(
        (value) => parseOpeningHours(value, at(0, 12)) || openingHoursComment(value),
      ).length;
      expect(
        answered,
        `${city}: ${answered}/${values.length} values answered`,
      ).toBeGreaterThanOrEqual(floor);
    }
  });

  it('covers the common database grammar without accepting unknown syntax', () => {
    // The 15 most frequent Oslo strings in the local Europe POI database on
    // 2026-09-20, verbatim. Keep this as a golden list: a grammar cleanup must
    // not silently lose the shapes responsible for most of the measured 94.9%.
    const sampled = [
      '24/7',
      'Mo-Sa 07:00-23:00',
      'Mo-Fr 10:00-19:00; Sa 10:00-18:00',
      'Mo-Fr 10:00-18:00; Sa 10:00-16:00; Su closed',
      'Mo-Fr 10:00-20:00; Sa 10:00-18:00',
      'Mo-Fr 10:00-21:00; Sa 10:00-19:00',
      'Mo-Fr 10:00-20:00; Sa 09:00-18:00',
      'Mo-Fr 08:00-22:00, Sa 08:00-20:00',
      'Mo-Sa 10:00-18:00',
      'Mo-Fr 08:00-16:00',
      'Mo-Fr 10:00-21:00, Sa 10:00-19:00',
      'Mo-Fr 10:00-18:00; Sa 10:00-17:00',
      'Mo-Fr 10:00-20:00, Sa 10:00-18:00',
      'Mo-Fr 09:00-20:00; Sa 10:00-18:00',
      'Mo-Fr 10:00-21:00; Sa 09:00-19:00',
    ];
    expect(sampled.filter((value) => parseOpeningHours(value, at(0, 12))).length).toBe(
      sampled.length,
    );
  });
});

describe('websiteDisplayName', () => {
  it('shows the recognisable host while retaining URL handling for the client', () => {
    expect(websiteDisplayName('https://www.sushisenter.no/menu/today/')).toBe('sushisenter.no');
    expect(websiteDisplayName('example.org/')).toBe('example.org');
  });
});
