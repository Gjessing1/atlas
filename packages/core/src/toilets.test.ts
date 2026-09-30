import { describe, expect, it } from 'vitest';
import { publicToiletIdentify, toiletFromNvdb, toiletFromOslo } from './toilets.js';

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
});
