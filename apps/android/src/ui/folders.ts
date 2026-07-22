import type { CollectionRecord } from '@atlas/storage';

/** Folders flattened depth-first, with their nesting depth (for indented lists). */
export function flattenFolders(
  collections: CollectionRecord[],
): { folder: CollectionRecord; depth: number }[] {
  const byParent = new Map<string | null, CollectionRecord[]>();
  for (const c of collections) {
    const key = c.parentId && collections.some((p) => p.id === c.parentId) ? c.parentId : null;
    const list = byParent.get(key) ?? [];
    list.push(c);
    byParent.set(key, list);
  }
  const out: { folder: CollectionRecord; depth: number }[] = [];
  const walk = (parentId: string | null, depth: number) => {
    for (const folder of byParent.get(parentId) ?? []) {
      out.push({ folder, depth });
      walk(folder.id, depth + 1);
    }
  };
  walk(null, 0);
  // Defensive: folders stranded by a cyclic parent chain still get listed.
  for (const c of collections) {
    if (!out.some((f) => f.folder.id === c.id)) out.push({ folder: c, depth: 0 });
  }
  return out;
}
