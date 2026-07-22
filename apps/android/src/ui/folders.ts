import { buildCollectionTree, flattenCollectionTree } from '@atlas/app-hooks';
import type { CollectionRecord } from '@atlas/storage';

/**
 * Folders flattened depth-first, with their nesting depth (for indented
 * pickers). A thin wrapper over the shared tree model, so a folder picker and
 * the collections list can never disagree about the hierarchy.
 */
export function flattenFolders(
  collections: CollectionRecord[],
): { folder: CollectionRecord; depth: number }[] {
  return flattenCollectionTree(buildCollectionTree({ collections }));
}
