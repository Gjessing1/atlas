import { describe, expect, it } from 'vitest';
import {
  ancestorFolderIds,
  buildCollectionTree,
  flattenCollectionTree,
  folderContentsLine,
  promoteParentId,
  tracksForList,
  type TreeFolder,
} from './useCollectionTree.js';

const folder = (id: string, parentId: string | null = null, visible = true): TreeFolder => ({
  id,
  parentId,
  visible,
});
const item = (collectionId: string | null, visible = true) => ({ collectionId, visible });

describe('buildCollectionTree', () => {
  it('nests folders and files items at the level that names them', () => {
    const tree = buildCollectionTree({
      collections: [folder('a'), folder('a1', 'a'), folder('b')],
      places: [item('a1'), item(null)],
      tracks: [item('a')],
    });

    expect(tree.roots.map((n) => n.folder.id)).toEqual(['a', 'b']);
    expect(tree.roots[0]?.children.map((n) => n.folder.id)).toEqual(['a1']);
    expect(tree.roots[0]?.children[0]?.depth).toBe(1);
    expect(tree.byId.get('a1')?.places).toHaveLength(1);
    expect(tree.byId.get('a')?.tracks).toHaveLength(1);
    expect(tree.places).toHaveLength(1);
    expect(tree.byParent.get(null)?.map((n) => n.folder.id)).toEqual(['a', 'b']);
  });

  it('shows a folder whose parent is missing at the root, with its subtree', () => {
    // The web sidebar used to drop these entirely — a sync-only case that looks
    // exactly like data loss (device A nests under a folder device B deleted).
    const tree = buildCollectionTree({
      collections: [folder('orphan', 'gone'), folder('child', 'orphan')],
      places: [item('child')],
    });

    expect(tree.roots.map((n) => n.folder.id)).toEqual(['orphan']);
    expect(tree.roots[0]?.children.map((n) => n.folder.id)).toEqual(['child']);
    expect(tree.byId.get('child')?.places).toHaveLength(1);
  });

  it('files an item whose folder is missing at the root rather than losing it', () => {
    const tree = buildCollectionTree({ collections: [], places: [item('gone')] });
    expect(tree.places).toHaveLength(1);
  });

  it('still lists folders stranded by a cyclic parent chain', () => {
    const tree = buildCollectionTree({
      collections: [folder('x', 'y'), folder('y', 'x')],
    });

    // The cycle is broken at the first repeat: one of the pair anchors the tree,
    // the other renders under it once. Both stay reachable, nothing recurses.
    expect(tree.roots.map((n) => n.folder.id)).toEqual(['x']);
    expect(tree.roots[0]?.children.map((n) => n.folder.id)).toEqual(['y']);
    expect(tree.byId.size).toBe(2);
  });

  it('rolls folder visibility down the chain without touching the own flag', () => {
    const tree = buildCollectionTree({
      collections: [folder('a', null, false), folder('a1', 'a', true)],
    });

    expect(tree.byId.get('a1')?.visible).toBe(false);
    expect(tree.byId.get('a1')?.folder.visible).toBe(true);
  });

  it('reports empty only when there is nothing at all', () => {
    expect(buildCollectionTree({ collections: [] }).empty).toBe(true);
    expect(buildCollectionTree({ collections: [], places: [item(null)] }).empty).toBe(false);
  });
});

describe('flattenCollectionTree', () => {
  it('walks depth-first with nesting depth', () => {
    const tree = buildCollectionTree({
      collections: [folder('a'), folder('a1', 'a'), folder('a1x', 'a1'), folder('b')],
    });

    expect(flattenCollectionTree(tree)).toEqual([
      { folder: tree.byId.get('a')?.folder, depth: 0 },
      { folder: tree.byId.get('a1')?.folder, depth: 1 },
      { folder: tree.byId.get('a1x')?.folder, depth: 2 },
      { folder: tree.byId.get('b')?.folder, depth: 0 },
    ]);
  });
});

describe('promoteParentId', () => {
  const collections = [folder('a'), folder('a1', 'a'), folder('a1x', 'a1')];

  it('moves a folder to its grandparent, and a depth-one folder to the root', () => {
    expect(promoteParentId(collections, folder('a1x', 'a1'))).toBe('a');
    expect(promoteParentId(collections, folder('a1', 'a'))).toBeNull();
  });

  it('repairs an orphan by promoting it to the root', () => {
    expect(promoteParentId(collections, folder('orphan', 'gone'))).toBeNull();
  });
});

describe('ancestorFolderIds', () => {
  it('lists the folder chain innermost first, so a nested row can be revealed', () => {
    const tree = buildCollectionTree({
      collections: [folder('a'), folder('a1', 'a'), folder('a1x', 'a1')],
    });

    expect(ancestorFolderIds(tree, 'a1x')).toEqual(['a1x', 'a1', 'a']);
    expect(ancestorFolderIds(tree, 'a')).toEqual(['a']);
  });

  it('needs nothing expanded for an item that already renders at the root', () => {
    const tree = buildCollectionTree({ collections: [folder('a')] });

    expect(ancestorFolderIds(tree, null)).toEqual([]);
    // Names a folder that no longer exists: the tree files it at the root.
    expect(ancestorFolderIds(tree, 'gone')).toEqual([]);
  });

  it('stops at the orphan the tree promoted to the root instead of chasing the pointer', () => {
    const tree = buildCollectionTree({
      collections: [folder('orphan', 'gone'), folder('child', 'orphan')],
    });

    expect(ancestorFolderIds(tree, 'child')).toEqual(['child', 'orphan']);
  });

  it('terminates on a cyclic parent chain', () => {
    // Both folders point at each other; the tree renders one of them as a root,
    // which is where the walk has to stop — following parentId never would.
    const tree = buildCollectionTree({
      collections: [folder('x', 'y'), folder('y', 'x')],
    });

    const ids = ancestorFolderIds(tree, 'x');
    expect(ids[0]).toBe('x');
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('folder browsing helpers', () => {
  it('lists recorded tracks newest first, then the untimed ones in stored order', () => {
    const tracks = [
      { name: 'A drawn route', stats: {} },
      { name: 'Oslo Running', stats: { startTime: 100 } },
      { name: 'Oslo Running', stats: { startTime: 300 } },
      { name: 'B import', stats: {} },
    ];
    expect(tracksForList(tracks).map((track) => [track.name, track.stats.startTime])).toEqual([
      ['Oslo Running', 300],
      ['Oslo Running', 100],
      ['A drawn route', undefined],
      ['B import', undefined],
    ]);
  });

  it('says what a folder holds, singular and plural', () => {
    expect(folderContentsLine({ children: [1, 2], places: [1], tracks: [] })).toBe(
      '2 folders · 1 place',
    );
    expect(folderContentsLine({ children: [], places: [], tracks: [1] })).toBe('1 track');
    expect(folderContentsLine({ children: [], places: [], tracks: [] })).toBe('Empty');
  });
});
