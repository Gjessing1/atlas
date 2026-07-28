/**
 * The collections tree, derived once for both apps.
 *
 * Web's sidebar and Android's favorites sheet each used to walk `parentId`
 * themselves, and the rules had already drifted: Android treated a folder whose
 * parent id points at a missing collection as a root, web filtered strictly by
 * `parentId` — so on web that folder and everything under it silently vanished.
 * Local deletes reparent, so orphans only arrive via sync (device A adds a child
 * to a folder device B deleted), which makes the difference rare, silent and
 * indistinguishable from data loss.
 *
 * One derivation, one orphan policy: **nothing is ever dropped**. A folder with a
 * dangling parent is shown at the root, and so is one stranded by a cyclic parent
 * chain. Collapse state is deliberately *not* here — it is a view preference each
 * app keeps locally.
 */

import { useMemo } from 'react';
import { collectionIsVisible, type VisibilityFolder } from '@atlas/core';

/** The folder fields the tree needs; apps pass their full records through. */
export interface TreeFolder {
  id: string;
  parentId: string | null;
  visible: boolean;
}

/** The item fields the tree needs (places, tracks — anything filed in a folder). */
export interface TreeItem {
  collectionId: string | null;
  visible: boolean;
}

/** One folder in the tree, with the items filed directly in it. */
export interface CollectionNode<
  C extends TreeFolder = TreeFolder,
  P extends TreeItem = TreeItem,
  T extends TreeItem = TreeItem,
> {
  folder: C;
  /** 0 for a root folder; children are one deeper. */
  depth: number;
  /** Child folders, in `collections` order. */
  children: CollectionNode<C, P, T>[];
  /** Places filed directly in this folder, in `places` order. */
  places: P[];
  /** Tracks filed directly in this folder, in `tracks` order. */
  tracks: T[];
  /**
   * Effective visibility: false when this folder or any ancestor is hidden.
   * `folder.visible` remains the folder's own flag (what a toggle writes).
   */
  visible: boolean;
}

/** The whole tree: root folders plus the items that sit outside any folder. */
export interface CollectionTree<
  C extends TreeFolder = TreeFolder,
  P extends TreeItem = TreeItem,
  T extends TreeItem = TreeItem,
> {
  /** Root folders — real roots first, then orphans, in `collections` order. */
  roots: CollectionNode<C, P, T>[];
  /** Places with no collection. */
  places: P[];
  /** Tracks with no collection. */
  tracks: T[];
  /** Every node by folder id, for id-keyed lookups during render. */
  byId: Map<string, CollectionNode<C, P, T>>;
  /** Child nodes by parent id (`null` = root level), for level-at-a-time render. */
  byParent: Map<string | null, CollectionNode<C, P, T>[]>;
  /** True when there is nothing at all to show. */
  empty: boolean;
}

export interface CollectionTreeInput<C extends TreeFolder, P extends TreeItem, T extends TreeItem> {
  collections: readonly C[];
  places?: readonly P[];
  tracks?: readonly T[];
}

/**
 * Build the tree. Pure and order-preserving: siblings keep the order they have
 * in `collections` (which the apps already sort by the user's drag order), and
 * items keep the order they have in `places`/`tracks`.
 */
export function buildCollectionTree<
  C extends TreeFolder,
  P extends TreeItem = TreeItem,
  T extends TreeItem = TreeItem,
>(input: CollectionTreeInput<C, P, T>): CollectionTree<C, P, T> {
  const collections = input.collections;
  const places = input.places ?? [];
  const tracks = input.tracks ?? [];

  const known = new Set(collections.map((c) => c.id));
  const visibility = new Map<string, VisibilityFolder>(
    collections.map((c) => [c.id, { parentId: c.parentId, visible: c.visible }]),
  );

  // Items grouped by the folder they name. An item pointing at a missing folder
  // is treated like an unfiled one rather than disappearing with it.
  const placesByFolder = new Map<string | null, P[]>();
  for (const place of places) {
    const key =
      place.collectionId !== null && known.has(place.collectionId) ? place.collectionId : null;
    const list = placesByFolder.get(key);
    if (list) list.push(place);
    else placesByFolder.set(key, [place]);
  }
  const tracksByFolder = new Map<string | null, T[]>();
  for (const track of tracks) {
    const key =
      track.collectionId !== null && known.has(track.collectionId) ? track.collectionId : null;
    const list = tracksByFolder.get(key);
    if (list) list.push(track);
    else tracksByFolder.set(key, [track]);
  }

  // Folders grouped by parent. A dangling parent id makes the folder a root.
  const foldersByParent = new Map<string | null, C[]>();
  for (const folder of collections) {
    const key = folder.parentId !== null && known.has(folder.parentId) ? folder.parentId : null;
    const list = foldersByParent.get(key);
    if (list) list.push(folder);
    else foldersByParent.set(key, [folder]);
  }

  const byId = new Map<string, CollectionNode<C, P, T>>();
  const byParent = new Map<string | null, CollectionNode<C, P, T>[]>();

  const build = (folder: C, depth: number): CollectionNode<C, P, T> => {
    const node: CollectionNode<C, P, T> = {
      folder,
      depth,
      children: [],
      places: placesByFolder.get(folder.id) ?? [],
      tracks: tracksByFolder.get(folder.id) ?? [],
      visible: collectionIsVisible(folder.id, visibility),
    };
    byId.set(folder.id, node);
    node.children = (foldersByParent.get(folder.id) ?? [])
      // Defensive: a cyclic chain would otherwise recurse forever. Such a folder
      // is picked up as an orphan root below instead.
      .filter((child) => !byId.has(child.id))
      .map((child) => build(child, depth + 1));
    byParent.set(folder.id, node.children);
    return node;
  };

  const roots = (foldersByParent.get(null) ?? []).map((folder) => build(folder, 0));
  // Anything a cyclic parent chain kept out of the walk still gets shown.
  for (const folder of collections) {
    if (!byId.has(folder.id)) roots.push(build(folder, 0));
  }
  byParent.set(null, roots);

  const rootPlaces = placesByFolder.get(null) ?? [];
  const rootTracks = tracksByFolder.get(null) ?? [];
  return {
    roots,
    places: rootPlaces,
    tracks: rootTracks,
    byId,
    byParent,
    empty: collections.length === 0 && places.length === 0 && tracks.length === 0,
  };
}

/** The tree depth-first, as a flat list — for indented folder pickers. */
export function flattenCollectionTree<C extends TreeFolder, P extends TreeItem, T extends TreeItem>(
  tree: CollectionTree<C, P, T>,
): { folder: C; depth: number }[] {
  const out: { folder: C; depth: number }[] = [];
  const walk = (nodes: CollectionNode<C, P, T>[]) => {
    for (const node of nodes) {
      out.push({ folder: node.folder, depth: node.depth });
      walk(node.children);
    }
  };
  walk(tree.roots);
  return out;
}

/**
 * Where "move up one level" puts a folder: its parent's parent, or the root.
 * An orphan (dangling parent) also lands at the root, which repairs the pointer
 * — which is why both apps offer the action whenever `parentId` is set, not only
 * when the folder actually renders nested.
 */
export function promoteParentId(
  collections: readonly TreeFolder[],
  folder: TreeFolder,
): string | null {
  if (folder.parentId === null) return null;
  const parent = collections.find((candidate) => candidate.id === folder.parentId);
  return parent?.parentId ?? null;
}

/**
 * The folders that must be open for an item filed in `collectionId` to be on
 * screen — the item's own folder first, then outwards to the one that renders
 * at the root.
 *
 * Revealing a row is otherwise a walk of `parentId` at the call site, and that
 * walk has two ways to go wrong that the tree has already settled: a dangling
 * parent, and a cycle. Both render at the root here, so the walk stops at the
 * first node with `depth === 0` rather than following the pointer chain — which
 * for a cycle would never end.
 *
 * An unfiled item (or one naming a folder that no longer exists) is already
 * visible at the root and needs nothing expanded, so the list is empty.
 */
export function ancestorFolderIds<C extends TreeFolder, P extends TreeItem, T extends TreeItem>(
  tree: CollectionTree<C, P, T>,
  collectionId: string | null,
): string[] {
  const out: string[] = [];
  let id = collectionId;
  while (id !== null) {
    const node = tree.byId.get(id);
    if (!node) break;
    out.push(id);
    if (node.depth === 0) break;
    id = node.folder.parentId;
  }
  return out;
}

/** Memoized {@link buildCollectionTree} — rebuilds only when the arrays change. */
export function useCollectionTree<
  C extends TreeFolder,
  P extends TreeItem = TreeItem,
  T extends TreeItem = TreeItem,
>(input: CollectionTreeInput<C, P, T>): CollectionTree<C, P, T> {
  const { collections, places, tracks } = input;
  return useMemo(
    () => buildCollectionTree({ collections, places, tracks }),
    [collections, places, tracks],
  );
}
