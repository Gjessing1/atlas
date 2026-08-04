import { describe, expect, it } from 'vitest';

import {
  filterCollectionRecords,
  parseCollectionQuery,
  recordMatchesQuery,
  tagQuery,
} from './collectionFilter.js';

const folder = (id: string, name: string, parentId: string | null = null) => ({
  id,
  name,
  parentId,
});
const place = (
  name: string,
  extra: {
    collectionId?: string | null;
    tags?: string[];
    notes?: string;
    address?: string;
  } = {},
) => ({
  name,
  collectionId: extra.collectionId ?? null,
  tags: extra.tags ?? [],
  notes: extra.notes ?? '',
  ...(extra.address !== undefined ? { address: extra.address } : {}),
});

describe('parseCollectionQuery', () => {
  it('reads a leading # as a tag query', () => {
    expect(parseCollectionQuery('  #Stand ')).toEqual({ text: 'stand', tagOnly: true });
    expect(parseCollectionQuery('Stand')).toEqual({ text: 'stand', tagOnly: false });
    expect(parseCollectionQuery('   ')).toEqual({ text: '', tagOnly: false });
  });

  it('round-trips what a tag chip writes', () => {
    expect(parseCollectionQuery(tagQuery('stand'))).toEqual({ text: 'stand', tagOnly: true });
  });
});

describe('recordMatchesQuery', () => {
  const record = {
    name: 'Elgpost nord',
    tags: ['hunt', 'spot', 'stand'],
    notes: 'Sitter fint i nordvind',
    address: 'Nordre Land',
  };

  it('matches name, tags, notes and address', () => {
    for (const q of ['elgpost', 'stand', 'nordvind', 'nordre land']) {
      expect(recordMatchesQuery(record, parseCollectionQuery(q)), q).toBe(true);
    }
  });

  it('matches nothing but tags in tag mode', () => {
    expect(recordMatchesQuery(record, parseCollectionQuery('#stand'))).toBe(true);
    // "Elgpost" is the name, not a tag — the whole point of the # form.
    expect(recordMatchesQuery(record, parseCollectionQuery('#elgpost'))).toBe(false);
  });

  it('keeps everything when the query is blank', () => {
    expect(recordMatchesQuery(record, parseCollectionQuery(''))).toBe(true);
  });
});

describe('filterCollectionRecords', () => {
  const collections = [
    folder('stands', 'Stands'),
    folder('north', 'North side', 'stands'),
    folder('fishing', 'Fishing'),
    folder('orphan', 'Stray', 'deleted-elsewhere'),
  ];
  const places = [
    place('Elgpost nord', { collectionId: 'north', tags: ['hunt', 'stand'] }),
    place('Gapahuk', { collectionId: 'fishing', tags: ['shelter'] }),
    place('Bogdan og Ada', { notes: 'stand by the lake' }),
  ];
  const tracks = [
    { name: 'Permit 2026', collectionId: 'fishing', tags: ['permit'], notes: '' },
    { name: 'Morning walk', collectionId: null, tags: [], notes: '' },
  ];
  const input = { collections, places, tracks };

  it('hands the inputs back untouched when the query is blank', () => {
    const result = filterCollectionRecords(input, '  ');
    expect(result.active).toBe(false);
    expect(result.places).toHaveLength(3);
    expect(result.collections).toHaveLength(4);
  });

  it('keeps the whole subtree of a folder matched by name', () => {
    const result = filterCollectionRecords(input, 'stands');
    expect(result.collections.map((c) => c.id)).toEqual(['stands', 'north']);
    // The place inside does not match "stands" itself; it is kept by its folder.
    expect(result.places.map((p) => p.name)).toEqual(['Elgpost nord']);
  });

  it('keeps the path down to a matched item', () => {
    const result = filterCollectionRecords(input, 'elgpost');
    expect(result.places.map((p) => p.name)).toEqual(['Elgpost nord']);
    // Both ancestors, so the row renders where it actually lives.
    expect(result.collections.map((c) => c.id)).toEqual(['stands', 'north']);
    expect(result.tracks).toEqual([]);
  });

  it('answers "show me my stands" from the tags the app writes', () => {
    const result = filterCollectionRecords(input, '#stand');
    expect(result.places.map((p) => p.name)).toEqual(['Elgpost nord']);
    // The unfiled place says "stand" in its *notes* — free text finds it, the
    // tag query does not, which is the difference the # is for.
    expect(filterCollectionRecords(input, 'stand').places.map((p) => p.name)).toEqual([
      'Elgpost nord',
      'Bogdan og Ada',
    ]);
  });

  it('filters tracks by the same rules as places', () => {
    const result = filterCollectionRecords(input, '#permit');
    expect(result.tracks.map((t) => t.name)).toEqual(['Permit 2026']);
    expect(result.places).toEqual([]);
    expect(result.collections.map((c) => c.id)).toEqual(['fishing']);
  });

  it('reports an empty result rather than an empty tree', () => {
    const result = filterCollectionRecords(input, 'nothing here');
    expect(result.active).toBe(true);
    expect(result.empty).toBe(true);
  });

  it('does not lose an orphaned folder’s contents to a broken parent chain', () => {
    const stray = place('Stray pin', { collectionId: 'orphan' });
    const result = filterCollectionRecords({ ...input, places: [...places, stray] }, 'stray');
    // The folder is kept by its own name and the pin by its; neither walk off
    // the end of the dangling parent id.
    expect(result.collections.map((c) => c.id)).toEqual(['orphan']);
    expect(result.places.map((p) => p.name)).toEqual(['Stray pin']);
  });
});
