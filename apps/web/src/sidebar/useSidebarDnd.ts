import type { CollectionRecord, PlaceRecord } from '@atlas/storage';
import { useState } from 'react';
import type { UserData } from '../storage/useUserData.js';

interface DragItem {
  kind: 'place' | 'folder';
  id: string;
}

/**
 * Where in a row the pointer is: the edges reorder around the row, the middle
 * drops *into* it. Rows that can't be entered ("edges") only ever see
 * before/after; a place dragged onto a folder only ever sees "inside".
 */
export type DropZone = 'before' | 'after' | 'inside';
type ZoneMode = 'edges' | 'inside' | 'all';

interface DropAt {
  key: string;
  zone: DropZone;
}

const zoneFor = (e: React.DragEvent, mode: ZoneMode): DropZone => {
  if (mode === 'inside') return 'inside';
  const rect = e.currentTarget.getBoundingClientRect();
  const ratio = rect.height > 0 ? (e.clientY - rect.top) / rect.height : 0.5;
  if (mode === 'edges') return ratio < 0.5 ? 'before' : 'after';
  if (ratio < 0.3) return 'before';
  if (ratio > 0.7) return 'after';
  return 'inside';
};

/**
 * Drag-and-drop arranging for the Sidebar tree: drag state, the row handler
 * factory, and the drop rules (places reorder and change folder, folders
 * reorder on the edges and nest in the middle). Persistence goes through
 * UserData.
 */
export function useSidebarDnd(data: UserData) {
  // What's being dragged and which row/zone it currently hovers.
  const [drag, setDrag] = useState<DragItem | null>(null);
  const [dropAt, setDropAt] = useState<DropAt | null>(null);

  const endDrag = () => {
    setDrag(null);
    setDropAt(null);
  };

  /** True when `id` sits anywhere below `ancestorId` (or is it) — a move there would cycle. */
  const inSubtree = (id: string | null, ancestorId: string): boolean => {
    const seen = new Set<string>();
    let cur = id;
    while (cur !== null && !seen.has(cur)) {
      if (cur === ancestorId) return true;
      seen.add(cur);
      cur = data.collections.find((c) => c.id === cur)?.parentId ?? null;
    }
    return false;
  };

  /** Splice `id` before/after `targetId` in a flat id list and persist it. */
  const reordered = (ids: string[], id: string, targetId: string, zone: DropZone): string[] => {
    const rest = ids.filter((candidate) => candidate !== id);
    const at = rest.indexOf(targetId);
    rest.splice(zone === 'after' ? at + 1 : at, 0, id);
    return rest;
  };

  /** Drop a dragged place onto another place: reorder, moving folders if needed. */
  const dropOnPlace = (target: PlaceRecord, zone: DropZone) => {
    if (!drag || drag.kind !== 'place' || drag.id === target.id) return;
    const dragged = data.places.find((p) => p.id === drag.id);
    if (!dragged) return;
    if (dragged.collectionId !== target.collectionId) {
      void data.updatePlace(drag.id, { collectionId: target.collectionId });
    }
    void data.reorderPlaces(
      reordered(
        data.places.map((p) => p.id),
        drag.id,
        target.id,
        zone,
      ),
    );
  };

  /** Drop onto a folder row: places move in, folders nest or reorder by zone. */
  const dropOnFolder = async (folder: CollectionRecord, zone: DropZone) => {
    if (!drag) return;
    if (drag.kind === 'place') {
      await data.updatePlace(drag.id, { collectionId: folder.id });
      return;
    }
    if (drag.id === folder.id) return;
    if (zone === 'inside') {
      // Refuse to bury a folder inside its own subtree (storage would throw).
      if (inSubtree(folder.id, drag.id)) return;
      await data.moveCollection(drag.id, folder.id);
      return;
    }
    const dragged = data.collections.find((c) => c.id === drag.id);
    if (!dragged) return;
    if (dragged.parentId !== folder.parentId) {
      if (inSubtree(folder.parentId, drag.id)) return;
      await data.moveCollection(drag.id, folder.parentId);
    }
    await data.reorderCollections(
      reordered(
        data.collections.map((c) => c.id),
        drag.id,
        folder.id,
        zone,
      ),
    );
  };

  /** Shared drag/drop handlers for one row. */
  const dragProps = (
    key: string,
    kind: 'place' | 'folder',
    id: string,
    accepts: (drag: DragItem) => boolean,
    onDrop: (zone: DropZone) => void,
    zoneMode: ZoneMode = 'edges',
  ) => ({
    draggable: true,
    onDragStart: (e: React.DragEvent) => {
      e.dataTransfer.effectAllowed = 'move';
      setDrag({ kind, id });
    },
    onDragEnd: endDrag,
    onDragOver: (e: React.DragEvent) => {
      if (drag && accepts(drag)) {
        e.preventDefault();
        const zone = zoneFor(e, zoneMode);
        setDropAt((cur) => (cur?.key === key && cur.zone === zone ? cur : { key, zone }));
      }
    },
    onDragLeave: () => setDropAt((cur) => (cur?.key === key ? null : cur)),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      onDrop(zoneFor(e, zoneMode));
      endDrag();
    },
  });

  /** Class suffix for a row, so it can show where the drop will land. */
  const dropClass = (key: string): string =>
    dropAt?.key === key ? ` drop-target drop-${dropAt.zone}` : '';

  return { drag, dropClass, dragProps, dropOnPlace, dropOnFolder };
}
