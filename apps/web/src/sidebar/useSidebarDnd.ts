import {
  collectionDropZone,
  type CollectionDragItem,
  type CollectionDropZone,
  type CollectionDropZoneMode,
} from '@atlas/app-hooks';
import type { CollectionRecord, PlaceRecord } from '@atlas/storage';
import { useState } from 'react';
import type { UserData } from '../storage/useUserData.js';

/**
 * Where in a row the pointer is: the edges reorder around the row, the middle
 * drops *into* it. Rows that can't be entered ("edges") only ever see
 * before/after; a place dragged onto a folder only ever sees "inside".
 */
interface DropAt {
  key: string;
  zone: CollectionDropZone;
}

const zoneFor = (e: React.DragEvent, mode: CollectionDropZoneMode): CollectionDropZone => {
  const rect = e.currentTarget.getBoundingClientRect();
  const ratio = rect.height > 0 ? (e.clientY - rect.top) / rect.height : 0.5;
  return collectionDropZone(ratio, mode);
};

/**
 * Drag-and-drop arranging for the Sidebar tree: drag state, the row handler
 * factory, and the drop rules (places reorder and change folder, folders
 * reorder on the edges and nest in the middle). Persistence goes through
 * UserData.
 */
export function useSidebarDnd(data: UserData) {
  // What's being dragged and which row/zone it currently hovers.
  const [drag, setDrag] = useState<CollectionDragItem | null>(null);
  const [dropAt, setDropAt] = useState<DropAt | null>(null);

  const endDrag = () => {
    setDrag(null);
    setDropAt(null);
  };

  /** The browser reports a gesture; the shared user-data model decides its outcome. */
  const dropOnPlace = (target: PlaceRecord, zone: CollectionDropZone) => {
    if (!drag) return;
    void data.arrangeCollectionItem(drag, { kind: 'place', id: target.id }, zone);
  };

  const dropOnFolder = (folder: CollectionRecord, zone: CollectionDropZone) => {
    if (!drag) return;
    void data.arrangeCollectionItem(drag, { kind: 'folder', id: folder.id }, zone);
  };

  /** Shared drag/drop handlers for one row. */
  const dragProps = (
    key: string,
    kind: 'place' | 'folder',
    id: string,
    accepts: (drag: CollectionDragItem) => boolean,
    onDrop: (zone: CollectionDropZone) => void,
    zoneMode: CollectionDropZoneMode = 'edges',
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
