import { describe, expect, it } from 'vitest';
import {
  collectionIsVisible,
  placeIsVisible,
  placeTargetTitle,
  poiCategoryLabel,
  savedPlaceAt,
  type PlaceTarget,
  visibleOnMap,
  type VisibilityFolder,
} from './index.js';

describe('place / folder visibility', () => {
  // root (visible) → sub (visible); away (hidden)
  const folders = new Map<string, VisibilityFolder>([
    ['root', { parentId: null, visible: true }],
    ['sub', { parentId: 'root', visible: true }],
    ['away', { parentId: null, visible: false }],
    ['under-away', { parentId: 'away', visible: true }],
  ]);

  it('shows a place whose own flag and folder chain are all visible', () => {
    expect(placeIsVisible({ visible: true, collectionId: 'sub' }, folders)).toBe(true);
    expect(placeIsVisible({ visible: true, collectionId: null }, folders)).toBe(true);
  });

  it('hides a place with its own flag off regardless of folder', () => {
    expect(placeIsVisible({ visible: false, collectionId: 'root' }, folders)).toBe(false);
  });

  it('hides a place when an ancestor folder is hidden', () => {
    expect(placeIsVisible({ visible: true, collectionId: 'away' }, folders)).toBe(false);
    expect(placeIsVisible({ visible: true, collectionId: 'under-away' }, folders)).toBe(false);
  });

  it('hides tracks under a hidden subfolder or a hidden parent, as it does pins', () => {
    const collections = [...folders].map(([id, folder]) => ({ id, ...folder }));
    const tracks = [
      { id: 'run', visible: true, collectionId: 'sub' },
      { id: 'ride', visible: true, collectionId: 'under-away' },
      { id: 'off', visible: false, collectionId: null },
      { id: 'loose', visible: true, collectionId: null },
    ];
    expect(visibleOnMap(tracks, collections).map((track) => track.id)).toEqual(['run', 'loose']);
    const subHidden = collections.map((c) => (c.id === 'sub' ? { ...c, visible: false } : c));
    expect(visibleOnMap(tracks, subHidden).map((track) => track.id)).toEqual(['loose']);
  });

  it('treats a dangling parent id as visible', () => {
    expect(collectionIsVisible('ghost', folders)).toBe(true);
  });

  it('does not loop on a cyclic parent chain', () => {
    const cyclic = new Map<string, VisibilityFolder>([
      ['a', { parentId: 'b', visible: true }],
      ['b', { parentId: 'a', visible: true }],
    ]);
    expect(collectionIsVisible('a', cyclic)).toBe(true);
  });
});

describe('place card model', () => {
  const oslo = { lat: 59.91, lng: 10.75 };
  it('builds a POI category from class/subclass', () => {
    expect(poiCategoryLabel({ class: 'restaurant', subclass: 'fast_food' })).toBe(
      'Restaurant · Fast food',
    );
    // A subclass that repeats the class or the name adds nothing.
    expect(poiCategoryLabel({ class: 'cafe', subclass: 'cafe' })).toBe('Cafe');
    expect(poiCategoryLabel({ class: 'shop', subclass: 'Rimi' }, 'Rimi')).toBe('Shop');
    expect(poiCategoryLabel({})).toBeUndefined();
  });

  it('titles a bare pin with its coordinates and a named target with its name', () => {
    const pin: PlaceTarget = { source: 'pin', position: oslo };
    expect(placeTargetTitle(pin)).toBe('59.91000, 10.75000');
    expect(placeTargetTitle({ ...pin, name: 'Home' })).toBe('Home');
    // A whitespace-only name is not a name.
    expect(placeTargetTitle({ ...pin, name: '  ' })).toBe('59.91000, 10.75000');
  });

  it('finds the nearest already-saved place within the match radius', () => {
    const places = [
      { id: 'far', lat: 59.92, lng: 10.75 },
      { id: 'near', lat: 59.910_1, lng: 10.75 },
      { id: 'nearer', lat: 59.910_05, lng: 10.75 },
    ];
    expect(savedPlaceAt(places, oslo)?.id).toBe('nearer');
    // The shop next door is a different place.
    expect(savedPlaceAt(places, { lat: 59.9105, lng: 10.75 })).toBeUndefined();
  });
});
