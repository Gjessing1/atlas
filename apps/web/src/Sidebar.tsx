import { PLACE_COLORS, PLACE_ICONS } from '@atlas/core';
import type { CollectionRecord, PlaceRecord, TrackRecord } from '@atlas/storage';
import { useRef, useState } from 'react';
import type { ImportResult, UserData } from './storage/useUserData.js';
import { AccountPanel } from './sync/AccountPanel.js';
import type { SyncState } from './sync/useSync.js';

interface SidebarProps {
  data: UserData;
  sync: SyncState;
  selectedTrackId: string | null;
  onShowPlace: (place: PlaceRecord) => void;
  onShowTrack: (track: TrackRecord) => void;
  onImported: (result: ImportResult) => void;
  onClose: () => void;
}

const fmtKm = (m: number): string =>
  m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;

interface EditorProps {
  name: string;
  notes: string;
  tags: string[];
  collectionId: string | null;
  collections: CollectionRecord[];
  onPatch: (patch: {
    name?: string;
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
function ItemEditor({
  name,
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

export function Sidebar({
  data,
  sync,
  selectedTrackId,
  onShowPlace,
  onShowTrack,
  onImported,
  onClose,
}: SidebarProps) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [importErrors, setImportErrors] = useState<string[]>([]);
  const [importing, setImporting] = useState(false);
  // Drag-and-drop arranging: what's being dragged and which row it hovers.
  const [drag, setDrag] = useState<{ kind: 'place' | 'folder'; id: string } | null>(null);
  const [dropKey, setDropKey] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const toggleExpanded = (key: string) => setExpanded((cur) => (cur === key ? null : key));

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
    accepts: (drag: { kind: 'place' | 'folder'; id: string }) => boolean,
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

  // "Show all" appears once anything is hidden; otherwise the button hides all.
  const anyHidden = data.places.some((p) => !p.visible) || data.collections.some((c) => !c.visible);
  const hasItems = data.places.length + data.collections.length > 0;

  const onImportFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setImporting(true);
    try {
      const result = await data.importFiles([...files]);
      setImportErrors(result.errors);
      onImported(result);
    } finally {
      setImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const placeRow = (place: PlaceRecord) => {
    const key = `place:${place.id}`;
    return (
      <li key={key} className={`item-row${place.visible ? '' : ' hidden'}`}>
        <div
          className={`item-line${dropKey === key ? ' drop-target' : ''}${drag?.id === place.id ? ' dragging' : ''}`}
          {...dragProps(
            key,
            'place',
            place.id,
            (d) => d.kind === 'place' && d.id !== place.id,
            () => dropOnPlace(place),
          )}
        >
          <input
            type="checkbox"
            checked={place.visible}
            title="Show on map"
            aria-label={`Show ${place.name} on map`}
            onChange={(e) => void data.updatePlace(place.id, { visible: e.target.checked })}
          />
          <span className="item-icon place-icon" style={{ color: place.color }} title={place.name}>
            {place.icon}
          </span>
          <button type="button" className="item-name" onClick={() => onShowPlace(place)}>
            {place.name}
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label={`Edit ${place.name}`}
            aria-expanded={expanded === key}
            onClick={() => toggleExpanded(key)}
          >
            ✎
          </button>
        </div>
        {place.tags.length > 0 && <div className="item-tags">{place.tags.join(' · ')}</div>}
        {expanded === key && (
          <ItemEditor
            name={place.name}
            notes={place.notes}
            tags={place.tags}
            collectionId={place.collectionId}
            collections={data.collections}
            style={{ icon: place.icon, color: place.color }}
            onPatch={(patch) => void data.updatePlace(place.id, patch)}
            onDelete={() => {
              if (confirm(`Delete place "${place.name}"?`)) void data.deletePlace(place.id);
            }}
          />
        )}
      </li>
    );
  };

  const trackRow = (track: TrackRecord) => {
    const key = `track:${track.id}`;
    const stats = track.stats;
    const meta = [
      stats['distanceM'] !== undefined ? fmtKm(stats['distanceM']) : null,
      stats['ascentM'] ? `↗ ${Math.round(stats['ascentM'])} m` : null,
    ].filter(Boolean);
    return (
      <li key={key} className={`item-row${selectedTrackId === track.id ? ' selected' : ''}`}>
        <div className="item-line">
          <input
            type="checkbox"
            checked={track.visible}
            title="Show on map"
            aria-label={`Show ${track.name} on map`}
            onChange={(e) => void data.updateTrack(track.id, { visible: e.target.checked })}
          />
          <button type="button" className="item-name" onClick={() => onShowTrack(track)}>
            {track.name}
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label={`Edit ${track.name}`}
            aria-expanded={expanded === key}
            onClick={() => toggleExpanded(key)}
          >
            ✎
          </button>
        </div>
        {meta.length > 0 && <div className="item-tags">{meta.join(' · ')}</div>}
        {expanded === key && (
          <ItemEditor
            name={track.name}
            notes={track.notes}
            tags={track.tags}
            collectionId={track.collectionId}
            collections={data.collections}
            onPatch={(patch) => void data.updateTrack(track.id, patch)}
            onDelete={() => {
              if (confirm(`Delete track "${track.name}"?`)) void data.deleteTrack(track.id);
            }}
            actions={
              <>
                <button type="button" onClick={() => void data.downloadTrack(track.id, 'gpx')}>
                  Download GPX
                </button>
                <button type="button" onClick={() => void data.downloadTrack(track.id, 'kml')}>
                  Download KML
                </button>
              </>
            }
          />
        )}
      </li>
    );
  };

  /** One collection level: its child folders, then its places and tracks. */
  const branch = (parentId: string | null, depth: number): React.ReactNode => {
    const folders = data.collections.filter((c) => c.parentId === parentId);
    const places = data.places.filter((p) => p.collectionId === parentId);
    const tracks = data.tracks.filter((t) => t.collectionId === parentId);
    if (parentId === null && folders.length + places.length + tracks.length === 0) {
      return (
        <p className="sidebar-empty">
          Nothing saved yet. Drop a pin and save it, or import a GPX/KML/KMZ file.
        </p>
      );
    }
    return (
      <ul className="item-list" style={depth > 0 ? { paddingLeft: 14 } : undefined}>
        {folders.map((folder) => (
          <li key={folder.id} className={`folder-row${folder.visible ? '' : ' hidden'}`}>
            <div
              className={`item-line${dropKey === `folder:${folder.id}` ? ' drop-target' : ''}${drag?.id === folder.id ? ' dragging' : ''}`}
              {...dragProps(
                `folder:${folder.id}`,
                'folder',
                folder.id,
                (d) => d.id !== folder.id,
                () => dropOnFolder(folder),
              )}
            >
              <input
                type="checkbox"
                checked={folder.visible}
                title="Show folder on map"
                aria-label={`Show folder ${folder.name} on map`}
                onChange={(e) => void data.setCollectionVisible(folder.id, e.target.checked)}
              />
              <span className="item-icon">📁</span>
              <span className="folder-name">{folder.name}</span>
              <button
                type="button"
                className="icon-button"
                aria-label={`New folder inside ${folder.name}`}
                title="New subfolder"
                onClick={() => {
                  const name = prompt('Subfolder name');
                  if (name?.trim()) void data.createCollection(name.trim(), folder.id);
                }}
              >
                +
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label={`Rename ${folder.name}`}
                onClick={() => {
                  const name = prompt('Folder name', folder.name);
                  if (name?.trim()) void data.renameCollection(folder.id, name.trim());
                }}
              >
                ✎
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label={`Delete ${folder.name}`}
                onClick={() => {
                  if (confirm(`Delete folder "${folder.name}"? Its contents move up a level.`))
                    void data.deleteCollection(folder.id);
                }}
              >
                ✕
              </button>
            </div>
            {branch(folder.id, depth + 1)}
          </li>
        ))}
        {places.map(placeRow)}
        {tracks.map(trackRow)}
      </ul>
    );
  };

  return (
    <aside className="sidebar" aria-label="Saved places and tracks">
      <div className="sidebar-header">
        <strong>Saved</strong>
        <div className="sidebar-actions">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={importing || data.status !== 'ready'}
          >
            {importing ? 'Importing…' : 'Import'}
          </button>
          <button
            type="button"
            onClick={() => void data.exportAll()}
            disabled={data.status !== 'ready'}
          >
            Export all
          </button>
          <button
            type="button"
            onClick={() => void data.setAllVisible(anyHidden)}
            disabled={data.status !== 'ready' || !hasItems}
            title={anyHidden ? 'Show all places and folders' : 'Hide all places and folders'}
          >
            {anyHidden ? 'Show all' : 'Hide all'}
          </button>
          <button
            type="button"
            onClick={() => {
              const name = prompt('Folder name');
              if (name?.trim()) void data.createCollection(name.trim());
            }}
            disabled={data.status !== 'ready'}
          >
            New folder
          </button>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close panel">
            ✕
          </button>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".gpx,.kml,.kmz"
          multiple
          hidden
          onChange={(e) => void onImportFiles(e.target.files)}
        />
      </div>
      {importErrors.length > 0 && (
        <div className="sidebar-errors">
          {importErrors.map((err) => (
            <p key={err}>{err}</p>
          ))}
        </div>
      )}
      <div className="sidebar-body">
        {data.status === 'loading' && <p className="sidebar-empty">Opening your data…</p>}
        {data.status === 'error' && (
          <p className="sidebar-empty">
            Persistent storage is unavailable in this browser (it needs OPFS + WebAssembly), so
            saving is disabled.
          </p>
        )}
        {data.status === 'ready' && branch(null, 0)}
      </div>
      {data.status === 'ready' && <AccountPanel sync={sync} />}
    </aside>
  );
}
