import {
  ancestorFolderIds,
  collectionTagSuggestions,
  filterCollectionRecords,
  promoteParentId,
  tagQuery,
  useCollectionTree,
} from '@atlas/app-hooks';
import { trackSummary } from '@atlas/core';
import type { ImportSummary, PlaceRecord, TrackRecord } from '@atlas/storage';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EyeIcon, FolderIcon } from './icons.js';
import type { ConfirmRequest } from './sidebar/ConfirmDialog.js';
import { ConfirmDialog } from './sidebar/ConfirmDialog.js';
import { ItemEditor } from './sidebar/ItemEditor.js';
import { useSidebarDnd } from './sidebar/useSidebarDnd.js';
import type { ImportOptions, ImportResult, UserData } from './storage/useUserData.js';

interface SidebarProps {
  data: UserData;
  selectedTrackId: string | null;
  /** Commutes that use each saved place as an end. */
  placeCommutes?: ReadonlyMap<string, readonly string[]>;
  /**
   * A place to bring into view as the sidebar opens: its folders are expanded
   * and the row is scrolled to and highlighted. Null when nothing asked.
   */
  revealPlaceId?: string | null;
  /** The reveal has been carried out; the caller can drop its request. */
  onRevealed?: () => void;
  onShowPlace: (place: PlaceRecord) => void;
  onShowTrack: (track: TrackRecord) => void;
  /** Convert a stored/imported track into an editable snapped route. */
  onPlanTrack: (track: TrackRecord) => void;
  /** Plan a trip to this place — the row's Go button (Android parity). */
  onGoToPlace: (place: PlaceRecord) => void;
  onImported: (result: ImportResult) => void;
  /** Resolve and persist an iNatur permit as a filled area overlay. */
  onSavePermit: (input: string, options?: ImportOptions) => Promise<TrackRecord | null>;
  onClose: () => void;
}

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

/**
 * A row's tags, as buttons that filter the tree to them.
 *
 * They were already written on every saved stand (`spotPlaceDraft` tags them
 * `hunt`/`spot`/`stand`) and rendered as inert text: a vocabulary the app kept
 * and the user could not use. Tapping one writes `#tag` into the filter box —
 * visibly, so it can be edited or cleared like anything else typed there.
 */
function TagChips({ tags, onPick }: { tags: readonly string[]; onPick: (query: string) => void }) {
  if (tags.length === 0) return null;
  return (
    <div className="item-tags">
      {tags.map((tag) => (
        <button
          key={tag}
          type="button"
          className="tag-chip"
          // The word alone is the label a screen reader would otherwise read,
          // and "stand" says nothing about what pressing it does.
          aria-label={`Filter by ${tag}`}
          title={`Filter by ${tag}`}
          onClick={() => onPick(tagQuery(tag))}
        >
          {tag}
        </button>
      ))}
    </div>
  );
}

export function Sidebar({
  data,
  selectedTrackId,
  placeCommutes = new Map(),
  revealPlaceId = null,
  onRevealed,
  onShowPlace,
  onShowTrack,
  onPlanTrack,
  onGoToPlace,
  onImported,
  onSavePermit,
  onClose,
}: SidebarProps) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [importErrors, setImportErrors] = useState<string[]>([]);
  const [importing, setImporting] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importTarget, setImportTarget] = useState('root');
  const [importFolderName, setImportFolderName] = useState('');
  // iNatur permit-boundary tool: paste an offer link/id, get its area as a
  // track. Its own toggle so the hunting workflow doesn't crowd the GPX import.
  const [inaturOpen, setInaturOpen] = useState(false);
  const [inaturInput, setInaturInput] = useState('');
  const [inaturBusy, setInaturBusy] = useState(false);
  const [inaturError, setInaturError] = useState<string | null>(null);
  // Folders whose contents are showing. Empty by default: a collection with a
  // dozen folders opened as one long wall of every place at once, and the list
  // the user came for was somewhere in the middle of it. Session-only — which
  // folders are open is a view preference, not user data.
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() => new Set());
  // Totals from a restored backup — merges by id, so nothing new shows up in
  // the lists to tell the user it worked. Reported explicitly instead.
  const [restored, setRestored] = useState<ImportSummary | null>(null);
  // Folder id being renamed, and where a new folder is being named
  // ({ parentId } — null parent means the root level).
  const [renaming, setRenaming] = useState<string | null>(null);
  const [creating, setCreating] = useState<{ parentId: string | null } | null>(null);
  // Pending destructive action, awaiting the confirmation dialog.
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  // What the tree is narrowed to — name, tag, notes or address, with a
  // leading `#` meaning tags alone. Session-only, like the expansion state: a
  // filter is a way of looking at the list, not a property of it.
  const [filter, setFilter] = useState('');
  const { drag, dropClass, dragProps, dropOnPlace, dropOnFolder } = useSidebarDnd(data);
  const filtered = useMemo(
    () =>
      filterCollectionRecords(
        { collections: data.collections, places: data.places, tracks: data.tracks },
        filter,
      ),
    [data.collections, data.places, data.tracks, filter],
  );
  // The whole vocabulary, not the filtered one: a filter narrows what is on
  // screen, never which tags an editor may offer.
  const tagSuggestions = useMemo(
    () => collectionTagSuggestions([...data.places, ...data.tracks]),
    [data.places, data.tracks],
  );
  // The shared tree derivation: one orphan policy for both apps (a folder whose
  // parent is gone shows at the root instead of vanishing with its subtree).
  const tree = useCollectionTree({
    collections: filtered.collections,
    places: filtered.places,
    tracks: filtered.tracks,
  });
  const fileInputRef = useRef<HTMLInputElement>(null);
  const revealRowRef = useRef<HTMLLIElement>(null);
  // The just-revealed row, marked for a couple of seconds after the scroll.
  const [highlighted, setHighlighted] = useState<string | null>(null);

  /**
   * Bring a requested place into view. Opening the sidebar on a place is not
   * the same as showing it: folders start collapsed, so a place filed two deep
   * used to be nowhere on the screen that had just appeared.
   *
   * Two passes on purpose — expanding the ancestors is a state change, so the
   * row does not exist to scroll to until the render after it. The second pass
   * (once `revealRowRef` is attached) does the scrolling and reports back.
   */
  useEffect(() => {
    if (!revealPlaceId) return;
    const place = data.places.find((p) => p.id === revealPlaceId);
    if (!place) {
      onRevealed?.();
      return;
    }
    // A filter left over from a moment ago can hide the very row we were asked
    // to show, so revealing clears it — the request is more specific than it is.
    setFilter('');
    const ancestors = ancestorFolderIds(tree, place.collectionId);
    setExpandedFolders((current) => {
      if (ancestors.every((id) => current.has(id))) return current;
      const next = new Set(current);
      for (const id of ancestors) next.add(id);
      return next;
    });
    const row = revealRowRef.current;
    if (!row) return;
    row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    // Scrolling a row into a list of near-identical rows does not say *which*
    // one was meant; the highlight does, and then gets out of the way.
    setHighlighted(revealPlaceId);
    onRevealed?.();
  }, [revealPlaceId, data.places, tree, expandedFolders, onRevealed]);

  useEffect(() => {
    if (!highlighted) return;
    const t = setTimeout(() => setHighlighted(null), 2500);
    return () => clearTimeout(t);
  }, [highlighted]);

  const toggleExpanded = (key: string) => setExpanded((cur) => (cur === key ? null : key));
  const toggleFolder = (id: string) =>
    setExpandedFolders((current) => {
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
      setExpandedFolders((current) => {
        if (current.has(parentId)) return current;
        return new Set(current).add(parentId);
      });
    }
    setCreating({ parentId });
  };

  const closeConfirm = useCallback(() => setConfirm(null), []);

  /** Move a nested collection to its parent's parent (root from depth one). */
  const moveCollectionUp = (folder: (typeof data.collections)[number]) => {
    if (folder.parentId === null) return;
    void data.moveCollection(folder.id, promoteParentId(data.collections, folder));
  };

  // "Show all" appears once anything is hidden; otherwise the button hides all.
  // Tracks count: they are in this list, and setAllVisible now flips them too.
  const anyHidden =
    data.places.some((p) => !p.visible) ||
    data.tracks.some((t) => !t.visible) ||
    data.collections.some((c) => !c.visible);
  const hasItems = data.places.length + data.tracks.length + data.collections.length > 0;

  // Where an import lands, shared by the file import and the iNatur tool.
  const importOptions = (): ImportOptions =>
    importTarget === 'new'
      ? { newCollection: { name: importFolderName.trim() } }
      : { collectionId: importTarget === 'root' ? null : importTarget };

  const onImportFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setImporting(true);
    try {
      const result = await data.importFiles([...files], importOptions());
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

  // Resolve an iNatur offer and persist the polygon topology as a real filled
  // overlay. The record still carries GPX underneath for export and sync.
  const onResolveInatur = async () => {
    const raw = inaturInput.trim();
    if (!raw) return;
    setInaturBusy(true);
    setInaturError(null);
    try {
      const track = await onSavePermit(raw, importOptions());
      if (!track) return;
      onShowTrack(track);
      setInaturInput('');
      setInaturOpen(false);
    } catch (err) {
      setInaturError(err instanceof Error ? err.message : String(err));
    } finally {
      setInaturBusy(false);
    }
  };

  const placeRow = (place: PlaceRecord) => {
    const key = `place:${place.id}`;
    return (
      <li
        key={key}
        // Only the row being revealed takes the ref; the effect scrolls to
        // whatever it finds attached.
        ref={place.id === revealPlaceId ? revealRowRef : undefined}
        className={`item-row${place.visible ? '' : ' hidden'}${place.id === highlighted ? ' revealed' : ''}`}
      >
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
          {placeCommutes.has(place.id) && (
            <span
              className="place-commute-badge"
              title={`Used by ${placeCommutes.get(place.id)!.join(', ')}`}
            >
              Commute
            </span>
          )}
          <span className="row-actions">
            {/* Straight into the planner, as on Android. Without it the same
                trip was row → card → Directions on this client alone. */}
            <button
              type="button"
              className="row-go"
              title={`Directions to ${place.name}`}
              aria-label={`Directions to ${place.name}`}
              onClick={() => onGoToPlace(place)}
            >
              Go
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
        <TagChips tags={place.tags} onPick={setFilter} />
        {expanded === key && (
          <ItemEditor
            name={place.name}
            address={place.address}
            notes={place.notes}
            tags={place.tags}
            collectionId={place.collectionId}
            collections={data.collections}
            tagSuggestions={tagSuggestions}
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
        <div className="item-tags">{trackSummary(track.stats)}</div>
        <TagChips tags={track.tags} onPick={setFilter} />
        {expanded === key && (
          <ItemEditor
            name={track.name}
            notes={track.notes}
            tags={track.tags}
            collectionId={track.collectionId}
            collections={data.collections}
            tagSuggestions={tagSuggestions}
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
                <button type="button" onClick={() => onPlanTrack(track)}>
                  Plan as route
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
    const node = parentId === null ? null : tree.byId.get(parentId);
    const folders = tree.byParent.get(parentId) ?? [];
    const places = parentId === null ? tree.places : (node?.places ?? []);
    const tracks = parentId === null ? tree.tracks : (node?.tracks ?? []);
    const creatingHere = creating?.parentId === parentId;
    if (
      parentId === null &&
      folders.length + places.length + tracks.length === 0 &&
      !creatingHere
    ) {
      // A filter that matched nothing is not an empty collection: saying "drop
      // a pin" to someone whose pins are all still there reads as data loss.
      return filtered.active ? (
        <p className="sidebar-empty">
          Nothing here matches <strong>{filter.trim()}</strong>.
        </p>
      ) : (
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
        {folders.map(({ folder }) => {
          // While a filter is up every folder left standing is part of the
          // answer, so it opens: the whole point is to see the matches, not to
          // be told which folders they are in.
          const open = expandedFolders.has(folder.id) || filtered.active;
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
                  // The name is the obvious thing to click to open a folder;
                  // making the 16 px chevron the only target was the complaint.
                  <button
                    type="button"
                    className="folder-name"
                    aria-expanded={open}
                    onClick={() => toggleFolder(folder.id)}
                  >
                    {folder.name}
                  </button>
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
            onClick={() => {
              setInaturOpen((open) => !open);
              setInaturError(null);
            }}
            disabled={data.status !== 'ready'}
            title="Turn an iNatur hunting/fishing permit into a saved area (paste its offer link)"
            aria-expanded={inaturOpen}
          >
            iNatur permit
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
            title={anyHidden ? 'Show everything on the map' : 'Hide everything from the map'}
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
        <div className="sidebar-filter">
          <input
            type="search"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                setFilter('');
              }
            }}
            placeholder="Filter by name, #tag or notes"
            aria-label="Filter collections"
          />
          {filtered.active && (
            <button
              type="button"
              className="icon-button"
              aria-label="Clear filter"
              onClick={() => setFilter('')}
            >
              ✕
            </button>
          )}
        </div>
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
      {inaturOpen && (
        <div className="sidebar-import">
          <label>
            iNatur offer link or id
            <input
              value={inaturInput}
              onChange={(event) => {
                setInaturInput(event.target.value);
                setInaturError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void onResolveInatur();
              }}
              placeholder="https://www.inatur.no/jakt/…"
              aria-label="iNatur offer link or id"
              autoFocus
            />
          </label>
          <label>
            Save into
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
              aria-label="New folder name"
            />
          )}
          <button
            type="button"
            disabled={
              inaturBusy ||
              !inaturInput.trim() ||
              (importTarget === 'new' && !importFolderName.trim())
            }
            onClick={() => void onResolveInatur()}
          >
            {inaturBusy ? 'Resolving…' : 'Add permit area'}
          </button>
          {inaturError && <small className="sidebar-import-error">{inaturError}</small>}
          <small>
            Paste the link (or id) of an iNatur hunting or fishing offer to save its exact boundary
            as a track you can see on the map.
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
      </div>
      {confirm && <ConfirmDialog request={confirm} onCancel={closeConfirm} />}
    </aside>
  );
}
