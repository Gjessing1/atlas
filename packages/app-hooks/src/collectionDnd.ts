/**
 * One collection drag-and-drop language for both apps.
 *
 * The web decides a zone from an HTML drag event; Android decides it from
 * measured native rows. Everything after that platform seam belongs here:
 * which parent changes, which ordered id list is persisted, and which drops
 * are invalid because they would create a folder cycle.
 */

export type CollectionDragKind = 'place' | 'folder';
export type CollectionDropZone = 'before' | 'after' | 'inside';
export type CollectionDropZoneMode = 'edges' | 'inside' | 'all';

export interface CollectionDragItem {
  kind: CollectionDragKind;
  id: string;
}

export interface CollectionDropFolder {
  id: string;
  parentId: string | null;
}

export interface CollectionDropPlace {
  id: string;
  collectionId: string | null;
}

export type CollectionDropOperation =
  | { type: 'move-place'; id: string; collectionId: string | null }
  | { type: 'move-folder'; id: string; parentId: string | null }
  | { type: 'reorder-places'; orderedIds: string[] }
  | { type: 'reorder-folders'; orderedIds: string[] };

export interface CollectionDropInput {
  /** Records are already in their persisted display order. */
  collections: readonly CollectionDropFolder[];
  places: readonly CollectionDropPlace[];
  drag: CollectionDragItem;
  target: CollectionDragItem;
  zone: CollectionDropZone;
}

/**
 * Turn a normalized vertical position into the row's drop zone. `position` is
 * normally 0 at the top and 1 at the bottom; values just outside a measured
 * row deliberately remain edge drops.
 */
export function collectionDropZone(
  position: number,
  mode: CollectionDropZoneMode,
): CollectionDropZone {
  if (mode === 'inside') return 'inside';
  if (mode === 'edges') return position < 0.5 ? 'before' : 'after';
  if (position < 0.3) return 'before';
  if (position > 0.7) return 'after';
  return 'inside';
}

function reordered(
  ids: string[],
  id: string,
  targetId: string,
  zone: Exclude<CollectionDropZone, 'inside'>,
): string[] | null {
  const rest = ids.filter((candidate) => candidate !== id);
  const at = rest.indexOf(targetId);
  if (at < 0) return null;
  rest.splice(zone === 'after' ? at + 1 : at, 0, id);
  return ids.every((candidate, index) => rest[index] === candidate) ? null : rest;
}

/** True when `parentId` is the folder itself or anywhere below it. */
function wouldCycle(
  collections: readonly CollectionDropFolder[],
  folderId: string,
  parentId: string | null,
): boolean {
  const parents = new Map(collections.map((folder) => [folder.id, folder.parentId]));
  const seen = new Set<string>();
  let current = parentId;
  while (current !== null && !seen.has(current)) {
    if (current === folderId) return true;
    seen.add(current);
    current = parents.get(current) ?? null;
  }
  return false;
}

/**
 * Resolve a drop to storage operations. An empty list means "ignore it": the
 * source/target is stale, the combination has no meaning, nothing changed, or
 * the requested folder move would make a cycle.
 *
 * Operations are ordered: a cross-folder edge drop changes the parent before
 * persisting the new global rank list.
 */
export function resolveCollectionDrop(input: CollectionDropInput): CollectionDropOperation[] {
  const { collections, places, drag, target, zone } = input;
  if (drag.id === target.id && drag.kind === target.kind) return [];

  const knownFolders = new Set(collections.map((folder) => folder.id));
  const renderedParent = (id: string | null): string | null =>
    id !== null && knownFolders.has(id) ? id : null;

  if (drag.kind === 'place') {
    const place = places.find((candidate) => candidate.id === drag.id);
    if (!place) return [];

    if (target.kind === 'folder') {
      const folder = collections.find((candidate) => candidate.id === target.id);
      if (!folder || zone !== 'inside' || place.collectionId === folder.id) return [];
      return [{ type: 'move-place', id: place.id, collectionId: folder.id }];
    }

    const targetPlace = places.find((candidate) => candidate.id === target.id);
    if (!targetPlace || zone === 'inside') return [];
    const operations: CollectionDropOperation[] = [];
    const collectionId = renderedParent(targetPlace.collectionId);
    if (place.collectionId !== collectionId) {
      operations.push({ type: 'move-place', id: place.id, collectionId });
    }
    const orderedIds = reordered(
      places.map((candidate) => candidate.id),
      place.id,
      targetPlace.id,
      zone,
    );
    if (orderedIds) operations.push({ type: 'reorder-places', orderedIds });
    return operations;
  }

  if (target.kind !== 'folder') return [];
  const folder = collections.find((candidate) => candidate.id === drag.id);
  const targetFolder = collections.find((candidate) => candidate.id === target.id);
  if (!folder || !targetFolder) return [];

  const parentId = zone === 'inside' ? targetFolder.id : renderedParent(targetFolder.parentId);
  if (wouldCycle(collections, folder.id, parentId)) return [];

  const operations: CollectionDropOperation[] = [];
  if (folder.parentId !== parentId) {
    operations.push({ type: 'move-folder', id: folder.id, parentId });
  }
  if (zone !== 'inside') {
    const orderedIds = reordered(
      collections.map((candidate) => candidate.id),
      folder.id,
      targetFolder.id,
      zone,
    );
    if (orderedIds) operations.push({ type: 'reorder-folders', orderedIds });
  }
  return operations;
}
