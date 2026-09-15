import { includesTag, parseTagList, toggleTag } from '@atlas/app-hooks';
import { PLACE_COLORS, PLACE_ICONS } from '@atlas/core';
import type { CollectionRecord } from '@atlas/storage';
import { useState } from 'react';

/** The fields the editor can change; every key is optional and auto-saved. */
export interface ItemPatch {
  name?: string;
  address?: string;
  notes?: string;
  tags?: string[];
  collectionId?: string | null;
  icon?: string;
  color?: string;
}

interface EditorProps {
  name: string;
  /** Present for places; tracks have no address field. */
  address?: string;
  notes: string;
  tags: string[];
  collectionId: string | null;
  collections: CollectionRecord[];
  onPatch: (patch: ItemPatch) => void;
  onDelete: () => void;
  /** Present for places: the current icon/colour, enabling the style picker. */
  style?: { icon: string; color: string };
  /** Extra actions rendered beside Delete (e.g. track downloads). */
  actions?: React.ReactNode;
  /**
   * Every tag already in use across saved places and tracks, offered as pills
   * so filing into a group is a tap instead of retyping its exact spelling.
   */
  tagSuggestions?: readonly string[];
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
  tagSuggestions = [],
}: EditorProps) {
  const [tagText, setTagText] = useState(tags.join(', '));
  const typedTags = parseTagList(tagText);
  // Auto-saved like every other field, but only when the list really changed:
  // blur fires on every tab through the editor.
  const commitTags = (next: string[]) => {
    if (next.join('\n') !== tags.join('\n')) onPatch({ tags: next });
  };
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
          value={tagText}
          placeholder="hike, family, todo"
          onChange={(e) => setTagText(e.target.value)}
          onBlur={() => commitTags(typedTags)}
        />
      </label>
      {tagSuggestions.length > 0 && (
        <div className="tag-suggestions">
          {tagSuggestions.map((tag) => {
            const on = includesTag(typedTags, tag);
            return (
              <button
                key={tag}
                type="button"
                className={`tag-pill${on ? ' selected' : ''}`}
                aria-pressed={on}
                onClick={() => {
                  const next = toggleTag(typedTags, tag);
                  setTagText(next.join(', '));
                  commitTags(next);
                }}
              >
                {tag}
              </button>
            );
          })}
        </div>
      )}
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
