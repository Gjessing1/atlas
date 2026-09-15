import type { CollectionRecord, PlaceRecord } from '@atlas/storage';
import { useEffect, useRef, useState } from 'react';
import { ConfirmDialog, type ConfirmRequest } from '../sidebar/ConfirmDialog.js';
import { ItemEditor, type ItemPatch } from '../sidebar/ItemEditor.js';

interface PlaceEditDialogProps {
  place: PlaceRecord;
  collections: CollectionRecord[];
  /** Tags already in use anywhere in the collection, offered as pills. */
  tagSuggestions: readonly string[];
  onPatch: (patch: ItemPatch) => void;
  onDelete: () => void;
  /** Show this place in the Collections tree, in its folder, instead. */
  onShowInCollections: () => void;
  onClose: () => void;
}

/**
 * The saved-place editor, opened straight from the place card.
 *
 * The same {@link ItemEditor} the sidebar uses, in a focused modal rather than a
 * panel: the card's Edit action is answered where the user is looking, instead
 * of sliding the whole Collections tree over the card they were reading and
 * leaving them to find the row. Android has taken this path since its map-pin
 * Edit action (`PlaceEditSheet`); this is the web half.
 *
 * Every field auto-saves on blur, so there is no Save button — closing is not a
 * discard. Escape and a backdrop click both close, and the name field takes
 * focus, because the commonest reason to arrive here is that a pin was saved
 * under its coordinates and wants a name.
 */
export function PlaceEditDialog({
  place,
  collections,
  tagSuggestions,
  onPatch,
  onDelete,
  onShowInCollections,
  onClose,
}: PlaceEditDialogProps) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);

  useEffect(() => {
    bodyRef.current?.querySelector('input')?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      // The delete confirmation is on top; Escape belongs to it first.
      if (confirm) setConfirm(null);
      else onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, confirm]);

  return (
    <>
      {/* Closing on the backdrop commits whatever field has focus: blur fires
          before the click lands, so a name typed and not tabbed out of is still
          saved. */}
      <div className="confirm-backdrop" onClick={onClose}>
        <div
          className="place-edit-dialog"
          role="dialog"
          aria-modal="true"
          aria-label={`Edit ${place.name}`}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="place-edit-head">
            <strong>Edit place</strong>
            <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
              ✕
            </button>
          </div>
          <div ref={bodyRef}>
            <ItemEditor
              // Remount on a different place so the uncontrolled fields reload.
              key={place.id}
              name={place.name}
              address={place.address}
              notes={place.notes}
              tags={place.tags}
              collectionId={place.collectionId}
              collections={collections}
              tagSuggestions={tagSuggestions}
              style={{ icon: place.icon, color: place.color }}
              onPatch={onPatch}
              onDelete={() =>
                setConfirm({
                  title: `Delete “${place.name}”?`,
                  confirmLabel: 'Delete place',
                  onConfirm: () => {
                    onDelete();
                    onClose();
                  },
                })
              }
              actions={
                <button type="button" onClick={onShowInCollections}>
                  Show in collections
                </button>
              }
            />
          </div>
        </div>
      </div>
      {confirm && <ConfirmDialog request={confirm} onCancel={() => setConfirm(null)} />}
    </>
  );
}
