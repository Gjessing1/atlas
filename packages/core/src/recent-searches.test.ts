import { describe, expect, it } from 'vitest';
import {
  MAX_RECENT_SEARCHES,
  parseRecentSearches,
  pushRecentSearch,
  serializeRecentSearches,
} from './recent-searches.js';
import type { SearchResult } from './search.js';

const hit = (name: string, lat = 59.91, lng = 10.75): SearchResult => ({
  name,
  label: 'Oslo',
  position: { lat, lng },
});

describe('recent searches', () => {
  it('is empty for absent or malformed storage', () => {
    expect(parseRecentSearches(null)).toEqual([]);
    expect(parseRecentSearches('')).toEqual([]);
    expect(parseRecentSearches('{ not json')).toEqual([]);
    expect(parseRecentSearches('{"name":"not an array"}')).toEqual([]);
  });

  it('drops rows an older or broken writer left unusable', () => {
    const raw = JSON.stringify([
      hit('Keep me'),
      { name: 'No position' },
      { position: { lat: 1, lng: 2 } },
      { name: 'Bad position', position: { lat: '59.9', lng: 10.75 } },
    ]);
    expect(parseRecentSearches(raw).map((r) => r.name)).toEqual(['Keep me']);
  });

  it('keeps address and kind, and defaults a missing label', () => {
    const raw = JSON.stringify([
      { name: 'Preikestolen', position: { lat: 58.98, lng: 6.19 }, kind: 'tourism/attraction' },
      { name: 'Home', position: { lat: 59.9, lng: 10.7 }, address: 'Karl Johans gate 1' },
    ]);
    expect(parseRecentSearches(raw)).toEqual([
      {
        name: 'Preikestolen',
        label: '',
        position: { lat: 58.98, lng: 6.19 },
        kind: 'tourism/attraction',
      },
      {
        name: 'Home',
        label: '',
        position: { lat: 59.9, lng: 10.7 },
        address: 'Karl Johans gate 1',
      },
    ]);
  });

  it('caps a long stored list at the maximum', () => {
    const stored = Array.from({ length: 40 }, (_, i) => hit(`Place ${i}`, 59 + i / 100));
    expect(parseRecentSearches(serializeRecentSearches(stored))).toHaveLength(MAX_RECENT_SEARCHES);
  });

  it('promotes the newest pick and never stacks the same one twice', () => {
    let list = pushRecentSearch([], hit('Oslo S'));
    list = pushRecentSearch(list, hit('Nationaltheatret', 59.914));
    list = pushRecentSearch(list, hit('Oslo S'));
    expect(list.map((r) => r.name)).toEqual(['Oslo S', 'Nationaltheatret']);
  });

  it('keeps two same-named places apart when their positions differ', () => {
    let list = pushRecentSearch([], hit('Kaffebrenneriet', 59.911));
    list = pushRecentSearch(list, hit('Kaffebrenneriet', 59.925));
    expect(list).toHaveLength(2);
  });

  it('drops the oldest once full', () => {
    let list: SearchResult[] = [];
    for (let i = 0; i < MAX_RECENT_SEARCHES + 3; i++) {
      list = pushRecentSearch(list, hit(`Place ${i}`, 59 + i / 100));
    }
    expect(list).toHaveLength(MAX_RECENT_SEARCHES);
    expect(list[0]!.name).toBe(`Place ${MAX_RECENT_SEARCHES + 2}`);
    expect(list.some((r) => r.name === 'Place 0')).toBe(false);
  });

  it('round-trips through storage', () => {
    const list = pushRecentSearch([hit('Bogdan og Ada')], hit('Semsvannet', 59.858, 10.42));
    expect(parseRecentSearches(serializeRecentSearches(list))).toEqual(list);
  });
});
