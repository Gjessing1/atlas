import { describe, expect, it } from 'vitest';
import {
  buildCollectionTree,
  flattenCollectionTree,
  promoteParentId,
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
