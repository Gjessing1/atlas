import type { CollectionRecord, PlaceRecord } from '@atlas/storage';
import { useState } from 'react';
import type { UserData } from '../storage/useUserData.js';

interface DragItem {
  kind: 'place' | 'folder';
  id: string;
}

/**
 * Drag-and-drop arranging for the Sidebar tree: drag state, the row handler
 * factory, and the two drop rules (place→place reorders/moves, anything→folder
 * moves in / reorders folders). Persistence goes through UserData.
 */
export function useSidebarDnd(data: UserData) {
  // What's being dragged and which row it currently hovers.
  const [drag, setDrag] = useState<DragItem | null>(null);
  const [dropKey, setDropKey] = useState<string | null>(null);

  const endDrag = () => {
    setDrag(null);
    setDropKey(null);
  };

  /** Drop a dragged place onto another place: reorder, moving folders if needed. */
  const dropOnPlace = (target: PlaceRecord) => {
    if (!drag || drag.kind !== 'place' || drag.id === target.id) return;
    const dragged = data.places.find((p) => p.id === drag.id);
    if (!dragged) return;
    if (dragged.collectionId !== target.collectionId) {
      void data.updatePlace(drag.id, { collectionId: target.collectionId });
    }
    const ids = data.places.map((p) => p.id).filter((id) => id !== drag.id);
    ids.splice(ids.indexOf(target.id), 0, drag.id);
    void data.reorderPlaces(ids);
  };

  /** Drop onto a folder row: places move into the folder, folders reorder. */
  const dropOnFolder = (folder: CollectionRecord) => {
    if (!drag) return;
    if (drag.kind === 'place') {
      void data.updatePlace(drag.id, { collectionId: folder.id });
    } else if (drag.id !== folder.id) {
      const ids = data.collections.map((c) => c.id).filter((id) => id !== drag.id);
      ids.splice(ids.indexOf(folder.id), 0, drag.id);
      void data.reorderCollections(ids);
    }
  };

  /** Shared drag/drop handlers for one row. */
  const dragProps = (
    key: string,
    kind: 'place' | 'folder',
    id: string,
    accepts: (drag: DragItem) => boolean,
    onDrop: () => void,
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
        setDropKey(key);
      }
    },
    onDragLeave: () => setDropKey((k) => (k === key ? null : k)),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      onDrop();
      endDrag();
    },
  });

  return { drag, dropKey, dragProps, dropOnPlace, dropOnFolder };
}
