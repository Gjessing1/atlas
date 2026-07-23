import { PLACE_COLORS, PLACE_ICONS } from '@atlas/core';
import type { CollectionRecord } from '@atlas/storage';

interface EditorProps {
  name: string;
  /** Present for places; tracks have no address field. */
  address?: string;
  notes: string;
  tags: string[];
  collectionId: string | null;
  collections: CollectionRecord[];
  onPatch: (patch: {
    name?: string;
    address?: string;
    notes?: string;
    tags?: string[];
    collectionId?: string | null;
    icon?: string;
    color?: string;
  }) => void;
  onDelete: () => void;
  /** Present for places: the current icon/colour, enabling the style picker. */
  style?: { icon: string; color: string };
  /** Extra actions rendered beside Delete (e.g. track downloads). */
  actions?: React.ReactNode;
}

/** Inline detail editor shared by places and tracks; every change auto-saves. */
export function ItemEditor({
  name,
  address,
  notes,
  tags,
  collectionId,
  collections,
  onPatch,
  onDelete,
  style,
  actions,
}: EditorProps) {
  return (
    <div className="item-editor">
      {style && (
        <div className="style-picker">
          <div className="icon-choices">
            {PLACE_ICONS.map((ic) => (
              <button
                key={ic}
                type="button"
                className={`icon-choice${ic === style.icon ? ' selected' : ''}`}
                aria-label={`Icon ${ic}`}
                aria-pressed={ic === style.icon}
                onClick={() => onPatch({ icon: ic })}
              >
                {ic}
              </button>
            ))}
          </div>
          <div className="color-choices">
            {PLACE_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                className={`color-choice${c === style.color ? ' selected' : ''}`}
                style={{ background: c }}
                aria-label={`Colour ${c}`}
                aria-pressed={c === style.color}
                onClick={() => onPatch({ color: c })}
              />
            ))}
          </div>
        </div>
      )}
      <label>
        Name
        <input
          defaultValue={name}
          onBlur={(e) => {
            const value = e.target.value.trim();
            if (value && value !== name) onPatch({ name: value });
          }}
        />
      </label>
      <label>
        Folder
        <select
          value={collectionId ?? ''}
          onChange={(e) => onPatch({ collectionId: e.target.value || null })}
        >
          <option value="">(none)</option>
          {collections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      {address !== undefined && (
        <label>
          Address
          <input
            defaultValue={address}
            placeholder="Street, postcode, city"
            onBlur={(e) => {
              if (e.target.value !== address) onPatch({ address: e.target.value });
            }}
          />
        </label>
      )}
      <label>
        Tags
        <input
          defaultValue={tags.join(', ')}
          placeholder="hike, family, todo"
          onBlur={(e) => {
            const next = e.target.value
              .split(',')
              .map((t) => t.trim())
              .filter(Boolean);
            if (next.join('\n') !== tags.join('\n')) onPatch({ tags: next });
          }}
        />
      </label>
      <label>
        Notes
        <textarea
          defaultValue={notes}
          rows={2}
          onBlur={(e) => {
            if (e.target.value !== notes) onPatch({ notes: e.target.value });
          }}
        />
      </label>
      <div className="editor-actions">
        {actions}
        <button type="button" className="danger" onClick={onDelete}>
          Delete
        </button>
      </div>
    </div>
  );
}
