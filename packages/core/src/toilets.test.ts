import { describe, expect, it } from 'vitest';
import {
  publicToiletIdentify,
  toiletFromBergen,
  toiletFromNvdb,
  toiletFromOslo,
  toiletFromStavanger,
} from './toilets.js';

describe('toiletFromNvdb', () => {
  it('normalises a rest-area toilet from its flattened egenskaper', () => {
    // The first record NVDB returned for type 243 on 2026-09-30, in Olden.
    expect(
      toiletFromNvdb({
        'Antall klosett': 2,
        'Universelt utformet': 'Ja',
        Vinterstengt: 'Ja',
        'Vinterstengt, fra dato': '10-15',
        'Vinterstengt, til dato': '03-15',
        Type: 'Vannklosett',
        Eier: 'Fylkeskommune',
        Vedlikeholdsansvarlig: 'Fylkeskommune',
        vegsystem: 'Fv5724',
        adresse: 'Oldedalsvegen',
      }),
    ).toEqual({
      source: 'nvdb',
      accessible: 'yes',
      winter: 'Closed 15 Oct – 15 Mar',
      kind: 'Flush toilet',
      count: 2,
      road: 'Fv5724 (Oldedalsvegen)',
      operator: 'County council',
    });
  });

  it('says only what the register says', () => {
    expect(toiletFromNvdb({})).toEqual({ source: 'nvdb' });
    // Winter-closed without dates is still worth saying; undated is not "open".
    expect(toiletFromNvdb({ Vinterstengt: 'Ja' }).winter).toBe('Closed in winter');
    expect(toiletFromNvdb({ Vinterstengt: 'Nei' }).winter).toBe('Open all year');
    expect(toiletFromNvdb({ Eier: 'Stat, Statens vegvesen' }).operator).toBe('Statens vegvesen');
    expect(toiletFromNvdb({ Eier: 'Uavklart' }).operator).toBeUndefined();
  });
});

describe('toiletFromOslo', () => {
  const now = Date.UTC(2026, 8, 30);

  it('reads the city’s own universal-design class before the assessment field', () => {
    expect(
      toiletFromOslo(
        {
          navn: 'Hovedøya UU-toalett',
          objekttype: 'Toalett',
          toalettype: 1,
          tilgjengelighetsvurdering: 4,
          forvalter: 'Bymiljøetaten',
          kommentar: 'Toalett koster 5kr.',
          startdato: 1262304000000,
          sluttdato: 2556057600000,
        },
        now,
      ),
    ).toEqual({
      source: 'oslo',
      name: 'Hovedøya UU-toalett',
      accessible: 'yes',
      operator: 'Bymiljøetaten',
      notes: 'Toalett koster 5kr.',
    });
    expect(toiletFromOslo({ toalettype: 0, tilgjengelighetsvurdering: 2 }, now)?.accessible).toBe(
      'partly',
    );
    expect(toiletFromOslo({ toalettype: 0, tilgjengelighetsvurdering: 4 }, now)?.accessible).toBe(
      undefined,
    );
    expect(toiletFromOslo({ objekttype: 'Pissoar', forvalter: 'Annet' }, now)).toEqual({
      source: 'oslo',
      kind: 'Urinal',
    });
  });

  it('drops a toilet the register has closed', () => {
    // Ulsrudvann: `sluttdato` 2024-11-28, still in the layer.
    expect(toiletFromOslo({ navn: 'Ulsrudvann', sluttdato: 1732752000000 }, now)).toBeNull();
    expect(toiletFromOslo({ startdato: now + 86_400_000 }, now)).toBeNull();
  });
});

describe('publicToiletIdentify', () => {
  it('leads with access and season, and fits the six-row card', () => {
    const group = publicToiletIdentify({
      source: 'nvdb',
      accessible: 'yes',
      winter: 'Closed 15 Oct – 15 Mar',
      kind: 'Flush toilet',
      count: 2,
      road: 'Fv5724 (Oldedalsvegen)',
      operator: 'County council',
      notes: 'Stengt ved flom',
    });
    expect(group).toEqual({
      title: 'Roadside toilet',
      properties: {
        'Wheelchair accessible': 'Yes',
        Season: 'Closed 15 Oct – 15 Mar',
        Facilities: '2 flush toilets',
        Road: 'Fv5724 (Oldedalsvegen)',
        Notes: 'Stengt ved flom',
        'Run by': 'County council',
      },
    });
    expect(Object.keys(group!.properties)).toHaveLength(6);
  });

  it('titles a city toilet by name and parses what the native bridge stringified', () => {
    expect(
      publicToiletIdentify({ source: 'oslo', name: 'Sognsvann', count: '1', kind: 'Urinal' }),
    ).toEqual({ title: 'Sognsvann', properties: { Facilities: 'Urinal' } });
    expect(publicToiletIdentify({ source: 'oslo', count: '3' })).toEqual({
      title: 'Public toilet',
      properties: { Facilities: '3 toilets' },
    });
  });

  it('answers nothing for a feature from some other layer', () => {
    expect(publicToiletIdentify(null)).toBeNull();
    expect(publicToiletIdentify({ name: 'Camera' })).toBeNull();
  });

  it('always keeps the list’s date, in the last row, whatever else is cut', () => {
    const group = publicToiletIdentify({
      source: 'bergen',
      name: 'Bergen Storsenter',
      accessible: 'yes',
      hours: 'Mon–Fri 07:30–21:30 · Sat 07:00–21:30 · Sun 09:00–21:00',
      price: '15 kr',
      babyChange: 'true',
      address: 'Strømgaten 8, 5015 Bergen',
      notes: 'Inside the centre',
      operator: 'Bergen kommune',
      asOf: '2026-09-30',
    });
    expect(group).toEqual({
      title: 'Bergen Storsenter',
      properties: {
        'Wheelchair accessible': 'Yes',
        Hours: 'Mon–Fri 07:30–21:30 · Sat 07:00–21:30 · Sun 09:00–21:00',
        Price: '15 kr',
        Facilities: 'Baby changing',
        Address: 'Strømgaten 8, 5015 Bergen',
        'Data as of': '30 Sep 2026',
      },
    });
    expect(Object.keys(group!.properties).at(-1)).toBe('Data as of');
  });
});

describe('toiletFromStavanger', () => {
  it('reads season and outhouse out of the place name', () => {
    // Verbatim from the 2024 list (opencom.no).
    expect(
      toiletFromStavanger({
        plassering: 'Vassøy - Peisaren badeplass. April- oktober. Utedo.',
        pris: '',
        aapningstider_hverdag: 'døgnåpent',
        aapningstider_loerdag: 'døgnåpent',
        aapningstider_soendag: 'døgnåpent',
        rullestol: 'Ja',
        stellerom: 'Nei',
      }),
    ).toEqual({
      source: 'stavanger',
      operator: 'Stavanger kommune',
      name: 'Vassøy - Peisaren badeplass',
      winter: 'Open Apr – Oct',
      kind: 'Outhouse',
      accessible: 'yes',
      hours: 'Open 24 hours',
    });
    const beach = toiletFromStavanger({
      plassering: 'Sørmarka Nord vest. Utedo 1.mai-30.september',
    });
    expect([beach.name, beach.winter, beach.kind]).toEqual([
      'Sørmarka Nord vest',
      'Open 1 May – 30 Sep',
      'Outhouse',
    ]);
    expect(toiletFromStavanger({ plassering: 'Sjøparken badeplass 1.mai-30september' }).name).toBe(
      'Sjøparken badeplass',
    );
  });

  it('folds weekday/Saturday/Sunday hours and tidies hand-typed times', () => {
    const hours = (w: string, sat: string, sun: string) =>
      toiletFromStavanger({
        aapningstider_hverdag: w,
        aapningstider_loerdag: sat,
        aapningstider_soendag: sun,
      }).hours;
    expect(hours('10:00-20:00', '10:00-18:00', 'Stengt')).toBe(
      'Mon–Fri 10:00–20:00 · Sat 10:00–18:00 · Sun closed',
    );
    expect(hours('05:00-24:00', '05:00-24:00', '05:00-24:00')).toBe('Daily 05:00–24:00');
    expect(
      hours(
        '09-21 vinter og 07-22 sommer',
        '09-21 vinter og 07-22 sommer',
        '09-21 vinter og 07-22 sommer',
      ),
    ).toBe('Daily 09:00–21:00 winter and 07:00–22:00 summer');
    expect(hours('Dagtid', 'Dagtid', 'Dagtid')).toBe('Daytime');
    expect(toiletFromStavanger({ pris: '0' }).price).toBe('Free');
  });
});

describe('toiletFromBergen', () => {
  it('prefers the per-day columns over the 2017 ones when both exist', () => {
    // Bergen Storsenter as the My Maps export carries it on 2026-09-30.
    expect(
      toiletFromBergen({
        placemark: 'Bergen Storsenter',
        folder: 'Public toilets',
        plassering: 'BERGEN STORSENTER',
        Address: 'Strømgaten 8, 5015 Bergen',
        'Price (NOK)': '15',
        tid_hverdag: '09.00 - 21.00',
        tid_lordag: '09.00 - 18.00',
        tid_sondag: 'NULL',
        HC: '1.0',
        stellerom: '1.0',
        dame: '1.0',
        herre: '1.0',
        pissoir: '0.0',
        Monday: '07.30-21-30',
        Tuesday: '07.30-21-30',
        Wednesday: '07.30-21-30',
        Thursday: '07.30-21-30',
        Friday: '07.30-21-30',
        Saturday: '07.00-21.30',
        Sunday: '09.00-21.00',
        Facilities: 'Female, male, disabled, baby-changing',
      }),
    ).toEqual({
      source: 'bergen',
      name: 'Bergen Storsenter',
      accessible: 'yes',
      babyChange: true,
      hours: 'Mon–Fri 07:30–21:30 · Sat 07:00–21:30 · Sun 09:00–21:00',
      price: '15 kr',
      address: 'Strømgaten 8, 5015 Bergen',
    });
  });

  it('reads the 2017 columns, urinals, and the friluftsråd layer', () => {
    expect(
      toiletFromBergen({
        placemark: 'C. Sundts gate',
        'Price (NOK)': 'Free',
        tid_hverdag: 'ALL',
        tid_lordag: 'ALL',
        tid_sondag: 'ALL',
        HC: '0.0',
        pissoir: '1.0',
        Facilities: 'Pissoir only',
      }),
    ).toEqual({
      source: 'bergen',
      name: 'C. Sundts gate',
      accessible: 'no',
      kind: 'Urinal',
      hours: 'Open 24 hours',
      price: 'Free',
    });
    // Sunday NULL is "not recorded", never "closed".
    expect(
      toiletFromBergen({ tid_hverdag: '08.00 - 15.00 ', tid_lordag: 'NULL', tid_sondag: 'NULL' })
        .hours,
    ).toBe('Mon–Fri 08:00–15:00');
    expect(toiletFromBergen({ placemark: 'Punkt 28', plassering: 'Øyrane torg' }).name).toBe(
      'Øyrane torg',
    );
    expect(toiletFromBergen({ 'Price (NOK)': '10,-' }).price).toBe('10 kr');
    expect(
      toiletFromBergen({ placemark: 'Kvarven', folder: 'BOF toilets', Facilities: 'Disabled' }),
    ).toEqual({
      source: 'bergen',
      name: 'Kvarven',
      accessible: 'yes',
      operator: 'Bergen og Omland friluftsråd',
    });
  });
});
