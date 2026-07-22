import type { ImportSummary, PlaceRecord, TrackRecord } from '@atlas/storage';
import { useCallback, useRef, useState } from 'react';
import { EyeIcon, FolderIcon } from './icons.js';
import { LayersPanel } from './layers/LayersPanel.js';
import type { LayerCatalog } from './layers/useLayerCatalog.js';
import type { ConfirmRequest } from './sidebar/ConfirmDialog.js';
import { ConfirmDialog } from './sidebar/ConfirmDialog.js';
import { ItemEditor } from './sidebar/ItemEditor.js';
import { useSidebarDnd } from './sidebar/useSidebarDnd.js';
import type { ImportOptions, ImportResult, UserData } from './storage/useUserData.js';

interface SidebarProps {
  data: UserData;
  layers: LayerCatalog;
  mapZoom: number;
  selectedTrackId: string | null;
  onShowPlace: (place: PlaceRecord) => void;
  onShowTrack: (track: TrackRecord) => void;
  onImported: (result: ImportResult) => void;
  onClose: () => void;
}

const fmtKm = (m: number): string =>
  m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;

/**
 * Plain-language result of a backup restore. "Skipped" is worth saying out
 * loud: a merge that writes nothing looks broken otherwise, when in fact it
 * means the device already had newer copies of everything.
 */
function describeRestore(s: ImportSummary): string {
  const parts: string[] = [];
  const say = (n: number, one: string, many: string) =>
    n > 0 ? parts.push(`${n} ${n === 1 ? one : many}`) : undefined;
  say(s.places.imported, 'place', 'places');
  say(s.tracks.imported, 'track', 'tracks');
  say(s.collections.imported, 'folder', 'folders');
  say(s.settings.imported, 'setting', 'settings');
  const skipped = s.places.skipped + s.tracks.skipped + s.collections.skipped + s.settings.skipped;
  const tail = skipped > 0 ? ` ${skipped} already up to date.` : '';
  if (parts.length === 0) return `Backup restored — everything here was already up to date.`;
  return `Restored ${parts.join(', ')}.${tail}`;
}

/**
 * Inline name field for creating/renaming a folder — Enter or blur commits,
 * Escape abandons. Replaces window.prompt, which blocks the page, cannot be
 * styled, and is outright hostile on mobile.
 */
function FolderNameInput({
  initial,
  placeholder,
  onCommit,
  onCancel,
}: {
  initial: string;
  placeholder: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const commit = () => {
    const name = value.trim();
    if (name && name !== initial) onCommit(name);
    else onCancel();
  };
  return (
    <input
      className="folder-name-input"
      autoFocus
      value={value}
      placeholder={placeholder}
      aria-label={placeholder}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          onCancel();
        }
      }}
    />
  );
}

export function Sidebar({
  data,
  layers,
  mapZoom,
  selectedTrackId,
  onShowPlace,
  onShowTrack,
  onImported,
  onClose,
}: SidebarProps) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [importErrors, setImportErrors] = useState<string[]>([]);
  const [importing, setImporting] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importTarget, setImportTarget] = useState('root');
  const [importFolderName, setImportFolderName] = useState('');
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(() => new Set());
  // Totals from a restored backup — merges by id, so nothing new shows up in
  // the lists to tell the user it worked. Reported explicitly instead.
  const [restored, setRestored] = useState<ImportSummary | null>(null);
  // Folder id being renamed, and where a new folder is being named
  // ({ parentId } — null parent means the root level).
  const [renaming, setRenaming] = useState<string | null>(null);
  const [creating, setCreating] = useState<{ parentId: string | null } | null>(null);
  // Pending destructive action, awaiting the confirmation dialog.
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const { drag, dropClass, dragProps, dropOnPlace, dropOnFolder } = useSidebarDnd(data);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const toggleExpanded = (key: string) => setExpanded((cur) => (cur === key ? null : key));
  const toggleFolder = (id: string) =>
    setCollapsedFolders((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  /**
   * Start naming a new folder. Creating inside a collapsed folder has to expand
   * it first, or the name field renders into a hidden subtree and the button
   * looks dead.
   */
  const startCreating = (parentId: string | null) => {
    if (parentId !== null) {
      setCollapsedFolders((current) => {
        if (!current.has(parentId)) return current;
        const next = new Set(current);
        next.delete(parentId);
        return next;
      });
    }
    setCreating({ parentId });
  };

  const closeConfirm = useCallback(() => setConfirm(null), []);

  /** Move a nested collection to its parent's parent (root from depth one). */
  const moveCollectionUp = (folder: (typeof data.collections)[number]) => {
    if (folder.parentId === null) return;
    const parent = data.collections.find((candidate) => candidate.id === folder.parentId);
    void data.moveCollection(folder.id, parent?.parentId ?? null);
  };

  // "Show all" appears once anything is hidden; otherwise the button hides all.
  const anyHidden = data.places.some((p) => !p.visible) || data.collections.some((c) => !c.visible);
  const hasItems = data.places.length + data.collections.length > 0;

  const onImportFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setImporting(true);
    try {
      const options: ImportOptions =
        importTarget === 'new'
          ? { newCollection: { name: importFolderName.trim() } }
          : { collectionId: importTarget === 'root' ? null : importTarget };
      const result = await data.importFiles([...files], options);
      setImportErrors(result.errors);
      setRestored(result.restored);
      onImported(result);
    } finally {
      setImporting(false);
      setImportOpen(false);
      setImportFolderName('');
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const placeRow = (place: PlaceRecord) => {
    const key = `place:${place.id}`;
    return (
      <li key={key} className={`item-row${place.visible ? '' : ' hidden'}`}>
        <div
          className={`item-line${dropClass(key)}${drag?.id === place.id ? ' dragging' : ''}`}
          {...dragProps(
            key,
            'place',
            place.id,
            (d) => d.kind === 'place' && d.id !== place.id,
            (zone) => dropOnPlace(place, zone),
          )}
        >
          <span className="row-indent" aria-hidden="true" />
          <span className="item-icon place-icon" style={{ color: place.color }} title={place.name}>
            {place.icon}
          </span>
          <button type="button" className="item-name" onClick={() => onShowPlace(place)}>
            {place.name}
          </button>
          <span className="row-actions">
            <button
              type="button"
              className="icon-button"
              aria-label={`Edit ${place.name}`}
              aria-expanded={expanded === key}
              onClick={() => toggleExpanded(key)}
            >
              ✎
            </button>
          </span>
          <button
            type="button"
            className="icon-button visibility-toggle"
            title={place.visible ? 'Hide from map' : 'Show on map'}
            aria-label={`${place.visible ? 'Hide' : 'Show'} ${place.name} ${place.visible ? 'from' : 'on'} map`}
            aria-pressed={place.visible}
            onClick={() => void data.updatePlace(place.id, { visible: !place.visible })}
          >
            <EyeIcon off={!place.visible} size={18} />
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
            onDelete={() =>
              setConfirm({
                title: `Delete “${place.name}”?`,
                confirmLabel: 'Delete place',
                onConfirm: () => void data.deletePlace(place.id),
              })
            }
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
          <span className="row-indent" aria-hidden="true" />
          <span className="item-icon track-icon" aria-hidden="true">
            〰
          </span>
          <button type="button" className="item-name" onClick={() => onShowTrack(track)}>
            {track.name}
          </button>
          <span className="row-actions">
            <button
              type="button"
              className="icon-button"
              aria-label={`Edit ${track.name}`}
              aria-expanded={expanded === key}
              onClick={() => toggleExpanded(key)}
            >
              ✎
            </button>
          </span>
          <button
            type="button"
            className="icon-button visibility-toggle"
            title={track.visible ? 'Hide from map' : 'Show on map'}
            aria-label={`${track.visible ? 'Hide' : 'Show'} ${track.name} ${track.visible ? 'from' : 'on'} map`}
            aria-pressed={track.visible}
            onClick={() => void data.updateTrack(track.id, { visible: !track.visible })}
          >
            <EyeIcon off={!track.visible} size={18} />
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
            onDelete={() =>
              setConfirm({
                title: `Delete “${track.name}”?`,
                confirmLabel: 'Delete track',
                onConfirm: () => void data.deleteTrack(track.id),
              })
            }
            actions={
              <>
                <button type="button" onClick={() => void data.exportTrack(track.id, 'gpx')}>
                  Download GPX
                </button>
                <button type="button" onClick={() => void data.exportTrack(track.id, 'kml')}>
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
    const creatingHere = creating?.parentId === parentId;
    if (
      parentId === null &&
      folders.length + places.length + tracks.length === 0 &&
      !creatingHere
    ) {
      return (
        <p className="sidebar-empty">
          Nothing saved yet. Drop a pin and save it, import a GPX/KML/KMZ file, or restore an Atlas
          backup.
        </p>
      );
    }
    return (
      <ul className={`item-list${depth > 0 ? ' nested' : ''}`}>
        {creatingHere && (
          <li className="folder-row">
            <div className="item-line">
              <span className="row-indent" aria-hidden="true" />
              <span className="item-icon folder-icon">
                <FolderIcon size={16} />
              </span>
              <FolderNameInput
                initial=""
                placeholder="New folder name"
                onCommit={(name) => {
                  void data.createCollection(name, parentId);
                  setCreating(null);
                }}
                onCancel={() => setCreating(null)}
              />
            </div>
          </li>
        )}
        {folders.map((folder) => {
          const open = !collapsedFolders.has(folder.id);
          return (
            <li key={folder.id} className={`folder-row${folder.visible ? '' : ' hidden'}`}>
              <div
                className={`item-line${dropClass(`folder:${folder.id}`)}${drag?.id === folder.id ? ' dragging' : ''}`}
                {...dragProps(
                  `folder:${folder.id}`,
                  'folder',
                  folder.id,
                  (d) => d.id !== folder.id,
                  (zone) => void dropOnFolder(folder, zone),
                  drag?.kind === 'place' ? 'inside' : 'all',
                )}
              >
                <button
                  type="button"
                  className="icon-button folder-toggle"
                  aria-label={`${open ? 'Collapse' : 'Expand'} ${folder.name}`}
                  aria-expanded={open}
                  onClick={() => toggleFolder(folder.id)}
                >
                  {open ? '▾' : '▸'}
                </button>
                <span className="item-icon folder-icon">
                  <FolderIcon open={open} size={16} />
                </span>
                {renaming === folder.id ? (
                  <FolderNameInput
                    initial={folder.name}
                    placeholder="Folder name"
                    onCommit={(name) => {
                      void data.renameCollection(folder.id, name);
                      setRenaming(null);
                    }}
                    onCancel={() => setRenaming(null)}
                  />
                ) : (
                  <span className="folder-name">{folder.name}</span>
                )}
                <span className="row-actions">
                  {folder.parentId !== null && (
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`Move ${folder.name} up one level`}
                      title="Move up one level"
                      onClick={() => moveCollectionUp(folder)}
                    >
                      ↑
                    </button>
                  )}
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`New folder inside ${folder.name}`}
                    title="New subfolder"
                    onClick={() => startCreating(folder.id)}
                  >
                    +
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`Rename ${folder.name}`}
                    onClick={() => setRenaming(folder.id)}
                  >
                    ✎
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`Delete ${folder.name}`}
                    title="Delete folder (contents move up a level)"
                    onClick={() =>
                      setConfirm({
                        title: `Delete folder “${folder.name}”?`,
                        body: 'Places, tracks and subfolders inside it move up one level.',
                        confirmLabel: 'Delete folder',
                        onConfirm: () => void data.deleteCollection(folder.id),
                      })
                    }
                  >
                    ✕
                  </button>
                </span>
                <button
                  type="button"
                  className="icon-button visibility-toggle"
                  title={folder.visible ? 'Hide collection from map' : 'Show collection on map'}
                  aria-label={`${folder.visible ? 'Hide' : 'Show'} collection ${folder.name} ${folder.visible ? 'from' : 'on'} map`}
                  aria-pressed={folder.visible}
                  onClick={() => void data.setCollectionVisible(folder.id, !folder.visible)}
                >
                  <EyeIcon off={!folder.visible} size={18} />
                </button>
              </div>
              {open && branch(folder.id, depth + 1)}
            </li>
          );
        })}
        {places.map(placeRow)}
        {tracks.map(trackRow)}
      </ul>
    );
  };

  return (
    <aside className="sidebar" aria-label="Collections">
      <div className="sidebar-header">
        <strong>Collections</strong>
        <div className="sidebar-actions">
          <button
            type="button"
            onClick={() => setImportOpen((open) => !open)}
            disabled={importing || data.status !== 'ready'}
            title="Import GPX/KML/KMZ into a folder, or restore an Atlas backup (.json/.zip)"
            aria-expanded={importOpen}
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
            onClick={() => startCreating(null)}
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
          accept=".gpx,.kml,.kmz,.json,.zip"
          multiple
          hidden
          onChange={(e) => void onImportFiles(e.target.files)}
        />
      </div>
      {importOpen && (
        <div className="sidebar-import">
          <label>
            Import into
            <select value={importTarget} onChange={(event) => setImportTarget(event.target.value)}>
              <option value="root">No folder</option>
              {data.collections.map((folder) => (
                <option key={folder.id} value={folder.id}>
                  {folder.name}
                </option>
              ))}
              <option value="new">Create new folder…</option>
            </select>
          </label>
          {importTarget === 'new' && (
            <input
              value={importFolderName}
              onChange={(event) => setImportFolderName(event.target.value)}
              placeholder="New folder name"
              aria-label="New import folder name"
            />
          )}
          <button
            type="button"
            disabled={importing || (importTarget === 'new' && !importFolderName.trim())}
            onClick={() => fileInputRef.current?.click()}
          >
            Choose files
          </button>
          <small>
            GPX, KML and KMZ tracks or waypoints use this folder. Atlas JSON/ZIP backups keep their
            original folders.
          </small>
        </div>
      )}
      {restored && (
        <div className="sidebar-notice">
          <p>{describeRestore(restored)}</p>
          <button type="button" className="icon-button" onClick={() => setRestored(null)}>
            ✕
          </button>
        </div>
      )}
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
        <LayersPanel layers={layers} mapZoom={mapZoom} />
      </div>
      {confirm && <ConfirmDialog request={confirm} onCancel={closeConfirm} />}
    </aside>
  );
}
