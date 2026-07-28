import { describe, expect, it } from 'vitest';
import {
  collectionDropZone,
  resolveCollectionDrop,
  type CollectionDropFolder,
  type CollectionDropPlace,
} from './collectionDnd.js';

const folder = (id: string, parentId: string | null = null): CollectionDropFolder => ({
  id,
  parentId,
});
const place = (id: string, collectionId: string | null = null): CollectionDropPlace => ({
  id,
  collectionId,
});

describe('collectionDropZone', () => {
  it('uses edges or a 30/40/30 split according to the gesture adapter', () => {
    expect(collectionDropZone(0.49, 'edges')).toBe('before');
    expect(collectionDropZone(0.5, 'edges')).toBe('after');
    expect(collectionDropZone(0.29, 'all')).toBe('before');
    expect(collectionDropZone(0.3, 'all')).toBe('inside');
    expect(collectionDropZone(0.7, 'all')).toBe('inside');
    expect(collectionDropZone(0.71, 'all')).toBe('after');
    expect(collectionDropZone(-0.1, 'inside')).toBe('inside');
  });
});

describe('resolveCollectionDrop', () => {
  const collections = [folder('a'), folder('a1', 'a'), folder('b')];
  const places = [place('p1'), place('p2', 'a'), place('p3', 'b')];

  it('moves a place beside another place and persists their shared order', () => {
    expect(
      resolveCollectionDrop({
        collections,
        places,
        drag: { kind: 'place', id: 'p3' },
        target: { kind: 'place', id: 'p2' },
        zone: 'before',
      }),
    ).toEqual([
      { type: 'move-place', id: 'p3', collectionId: 'a' },
      { type: 'reorder-places', orderedIds: ['p1', 'p3', 'p2'] },
    ]);
  });

  it('moves a place into a folder only through its inside zone', () => {
    expect(
      resolveCollectionDrop({
        collections,
        places,
        drag: { kind: 'place', id: 'p1' },
        target: { kind: 'folder', id: 'b' },
        zone: 'inside',
      }),
    ).toEqual([{ type: 'move-place', id: 'p1', collectionId: 'b' }]);
    expect(
      resolveCollectionDrop({
        collections,
        places,
        drag: { kind: 'place', id: 'p1' },
        target: { kind: 'folder', id: 'b' },
        zone: 'before',
      }),
    ).toEqual([]);
  });

  it('nests folders in the middle and reparents edge drops before reordering', () => {
    expect(
      resolveCollectionDrop({
        collections,
        places,
        drag: { kind: 'folder', id: 'b' },
        target: { kind: 'folder', id: 'a' },
        zone: 'inside',
      }),
    ).toEqual([{ type: 'move-folder', id: 'b', parentId: 'a' }]);

    expect(
      resolveCollectionDrop({
        collections,
        places,
        drag: { kind: 'folder', id: 'a1' },
        target: { kind: 'folder', id: 'b' },
        zone: 'after',
      }),
    ).toEqual([
      { type: 'move-folder', id: 'a1', parentId: null },
      { type: 'reorder-folders', orderedIds: ['a', 'b', 'a1'] },
    ]);
  });

  it('rejects self drops, folder-to-place drops, stale ids, and subtree cycles', () => {
    const cases = [
      {
        drag: { kind: 'folder' as const, id: 'a' },
        target: { kind: 'folder' as const, id: 'a' },
        zone: 'inside' as const,
      },
      {
        drag: { kind: 'folder' as const, id: 'a' },
        target: { kind: 'place' as const, id: 'p1' },
        zone: 'before' as const,
      },
      {
        drag: { kind: 'place' as const, id: 'gone' },
        target: { kind: 'place' as const, id: 'p1' },
        zone: 'after' as const,
      },
      {
        drag: { kind: 'folder' as const, id: 'a' },
        target: { kind: 'folder' as const, id: 'a1' },
        zone: 'inside' as const,
      },
    ];
    for (const testCase of cases) {
      expect(resolveCollectionDrop({ collections, places, ...testCase })).toEqual([]);
    }
  });

  it('treats dangling target parents and collection ids as the rendered root', () => {
    expect(
      resolveCollectionDrop({
        collections: [folder('orphan', 'gone'), folder('b')],
        places: [place('p1'), place('p2', 'gone')],
        drag: { kind: 'folder', id: 'b' },
        target: { kind: 'folder', id: 'orphan' },
        zone: 'before',
      }),
    ).toEqual([{ type: 'reorder-folders', orderedIds: ['b', 'orphan'] }]);

    expect(
      resolveCollectionDrop({
        collections: [],
        places: [place('p1'), place('p2', 'gone')],
        drag: { kind: 'place', id: 'p1' },
        target: { kind: 'place', id: 'p2' },
        zone: 'after',
      }),
    ).toEqual([{ type: 'reorder-places', orderedIds: ['p2', 'p1'] }]);
  });
});
