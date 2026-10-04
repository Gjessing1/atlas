import {
  ancestorFolderIds,
  collectionDropZone,
  collectionTagSuggestions,
  filterCollectionRecords,
  flattenCollectionTree,
  folderContentsLine,
  importedCount,
  parseCollectionQuery,
  promoteParentId,
  tagQuery,
  tracksForList,
  type PinLabelsController,
  useCollectionTree,
  type CollectionDragItem,
  type CollectionDropZone,
} from '@atlas/app-hooks';
import {
  folderHasPinLabels,
  tagHasPinLabels,
  trackListLine,
  userTags,
  type CollectionRevealTarget,
} from '@atlas/core';
import type {
  CollectionRecord,
  PlacePatch,
  PlaceRecord,
  TrackPatch,
  TrackRecord,
} from '@atlas/storage';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import type { ImportOptions, ImportResult } from '../useUserData';
import { BottomSheet } from './BottomSheet';
import { flattenFolders } from './folders';
import { confirmDelete, ItemEditor } from './ItemEditor';
import { ReorderableList } from './ReorderableList';
import { PinLabelIcon } from './icons';
import { theme } from './theme';

/** Tracks a folder level draws before its "Show more" button. */
const TRACK_PAGE = 30;

export type EditablePlacePatch = Pick<
  PlacePatch,
  'name' | 'address' | 'icon' | 'color' | 'notes' | 'tags' | 'visible' | 'collectionId'
>;

export type EditableTrackPatch = Pick<
  TrackPatch,
  'name' | 'notes' | 'tags' | 'visible' | 'collectionId'
>;

/** Focused editor opened from a map pin; the collections browser stays closed. */
export function PlaceEditSheet({
  visible,
  place,
  collections,
  places,
  tracks,
  onPatch,
  onDelete,
  onClose,
  bottomInset = 0,
}: {
  visible: boolean;
  place: PlaceRecord | null;
  collections: CollectionRecord[];
  /** Every saved place and track: the editor's tag suggestions come from all of them. */
  places: PlaceRecord[];
  tracks: TrackRecord[];
  onPatch: (id: string, patch: EditablePlacePatch) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
  bottomInset?: number;
}) {
  const folders = useMemo(() => flattenFolders(collections), [collections]);
  const tagSuggestions = useMemo(
    () => collectionTagSuggestions([...places, ...tracks]),
    [places, tracks],
  );
  if (!place) return null;
  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      initialSnap="half"
      bottomInset={bottomInset}
      testID="place-edit-sheet"
    >
      <View style={styles.headerRow}>
        <Text style={styles.heading}>Edit place</Text>
        <Pressable onPress={onClose} hitSlop={10} testID="place-edit-close">
          <Text style={styles.close}>✕</Text>
        </Pressable>
      </View>
      <ScrollView style={styles.scroll} keyboardShouldPersistTaps="handled">
        <ItemEditor
          key={place.id}
          id={place.id}
          noun="place"
          testPrefix="favorite"
          name={place.name}
          address={place.address}
          style={{ icon: place.icon, color: place.color }}
          collectionId={place.collectionId}
          notes={place.notes}
          tags={place.tags}
          folders={folders}
          tagSuggestions={tagSuggestions}
          onSave={(patch) => onPatch(place.id, patch)}
          onDelete={() => onDelete(place.id)}
          onClose={onClose}
        />
      </ScrollView>
    </BottomSheet>
  );
}

/**
 * A drawn eye / crossed-out eye for the visibility toggles (an emoji eye reads
 * as alarming and renders inconsistently across Android skins).
 */
export function EyeIcon({ off = false }: { off?: boolean }) {
  const color = off ? '#b0bac4' : theme.icon;
  return (
    <View style={eyeStyles.box}>
      <View style={[eyeStyles.outline, { borderColor: color }]}>
        <View style={[eyeStyles.pupil, { backgroundColor: color }]} />
      </View>
      {off ? <View style={eyeStyles.slash} /> : null}
    </View>
  );
}

const eyeStyles = StyleSheet.create({
  box: { width: 24, height: 20, alignItems: 'center', justifyContent: 'center' },
  outline: {
    width: 22,
    height: 14,
    borderRadius: 7,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pupil: { width: 6, height: 6, borderRadius: 3 },
  slash: {
    position: 'absolute',
    width: 24,
    height: 2,
    borderRadius: 1,
    backgroundColor: theme.handle,
    transform: [{ rotate: '45deg' }],
  },
});

/**
 * The "names on the map" switch, on a folder row and beside a `#tag` filter:
 * faint while off like the eye's off state, accent-coloured while on so a
 * labelled folder can be told apart at a glance.
 */
function PinLabelToggle({
  on,
  what,
  onToggle,
  testID,
}: {
  on: boolean;
  what: string;
  onToggle: () => void;
  testID: string;
}) {
  return (
    <Pressable
      style={styles.eyeButton}
      onPress={onToggle}
      accessibilityRole="switch"
      accessibilityState={{ checked: on }}
      accessibilityLabel={`Names of ${what} on the map`}
      testID={testID}
    >
      <PinLabelIcon color={on ? theme.accent : '#b0bac4'} />
    </Pressable>
  );
}

/**
 * A row's tags, as chips that filter the list to them.
 *
 * They were already written on every saved stand (`spotPlaceDraft` tags them
 * `hunt`/`spot`/`stand`) and shown nowhere on this client: a vocabulary the app
 * kept and the user could not use. Tapping one writes `#tag` into the filter
 * box — visibly, so it can be edited or cleared like anything else typed there.
 */
function TagChips({ tags, onPick }: { tags: readonly string[]; onPick: (query: string) => void }) {
  if (tags.length === 0) return null;
  return (
    <View style={styles.tagRow}>
      {tags.map((tag) => (
        <Pressable
          key={tag}
          style={styles.tagChip}
          onPress={() => onPick(tagQuery(tag))}
          accessibilityLabel={`Filter by ${tag}`}
          testID={`tag-chip-${tag}`}
        >
          <Text style={styles.tagChipText}>{tag}</Text>
        </Pressable>
      ))}
    </View>
  );
}

/**
 * Where saved data comes *in*: GPX/KML/KMZ files, whole Atlas backups, and the
 * iNatur permit boundary — which is the same act with a link instead of a file,
 * and shares the destination folder for exactly that reason.
 *
 * This lived in a second sheet of its own until the Collections merge. Import is not another
 * kind of saved data, it is how saved data arrives, so it belongs in the header
 * of the list it fills — which is where web has always kept it.
 */
function ImportControls({
  folders,
  onImport,
  onImportInatur,
}: {
  folders: { folder: CollectionRecord; depth: number }[];
  onImport: (options?: ImportOptions) => Promise<ImportResult | null>;
  onImportInatur: (input: string, options?: ImportOptions) => Promise<ImportResult | null>;
}) {
  const [importing, setImporting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // Import destination: a folder id, 'root' for no folder, or 'new' (named below).
  const [target, setTarget] = useState('root');
  const [newFolder, setNewFolder] = useState('');
  const [inaturInput, setInaturInput] = useState('');
  const [inaturBusy, setInaturBusy] = useState(false);

  const importDisabled = importing || (target === 'new' && !newFolder.trim());
  // The new-folder guard also blocks the iNatur add, which shares the folder row.
  const inaturDisabled =
    inaturBusy || !inaturInput.trim() || (target === 'new' && !newFolder.trim());

  const importOptions = (): ImportOptions =>
    target === 'new'
      ? { newCollection: { name: newFolder.trim() } }
      : { collectionId: target === 'root' ? null : target };

  // After a folder-creating import the folder is now a normal chip — drop back
  // to the default so a second import doesn't make a duplicate of the same name.
  const resetTargetAfterImport = () => {
    setNewFolder('');
    if (target === 'new') setTarget('root');
  };

  // Turn an import summary into the one-line status shown under the controls.
  const summarize = (result: ImportResult): string => {
    const bits: string[] = [];
    if (result.tracks.length) bits.push(`${result.tracks.length} track(s)`);
    if (result.places.length) bits.push(`${result.places.length} place(s)`);
    // A restored backup merges by id, so it adds nothing to tracks/places —
    // without this a successful restore would report "nothing importable".
    const restored = result.restored;
    if (restored) {
      const n = importedCount(restored);
      bits.push(n > 0 ? `${n} record(s) from backup` : 'a backup (already up to date)');
    }
    let text = bits.length ? `Imported ${bits.join(', ')}.` : 'Nothing importable found.';
    if (result.errors.length) text = `${text} ${result.errors[0]}`.trim();
    return text;
  };

  const runImport = async () => {
    setImporting(true);
    setMessage(null);
    try {
      const result = await onImport(importOptions());
      if (result) {
        resetTargetAfterImport();
        setMessage(summarize(result));
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setImporting(false);
    }
  };

  const runInatur = async () => {
    setInaturBusy(true);
    setMessage(null);
    try {
      const result = await onImportInatur(inaturInput.trim(), importOptions());
      if (result) {
        setInaturInput('');
        resetTargetAfterImport();
        setMessage(summarize(result));
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setInaturBusy(false);
    }
  };

  return (
    <View style={styles.importBlock}>
      {/* Destination for GPX/KML/KMZ imports; backups keep their own folders. */}
      <Text style={styles.fieldLabel}>Import into</Text>
      <View style={styles.choiceRow}>
        <Pressable
          style={[styles.folderChip, target === 'root' && styles.folderChipSelected]}
          onPress={() => setTarget('root')}
          testID="import-folder-none"
        >
          <Text style={styles.folderChipText}>No folder</Text>
        </Pressable>
        {folders.map(({ folder, depth }) => (
          <Pressable
            key={folder.id}
            style={[styles.folderChip, target === folder.id && styles.folderChipSelected]}
            onPress={() => setTarget(folder.id)}
            testID={`import-folder-${folder.id}`}
          >
            <Text style={styles.folderChipText}>
              {depth > 0 ? '└ ' : ''}📁 {folder.name}
            </Text>
          </Pressable>
        ))}
        <Pressable
          style={[styles.folderChip, target === 'new' && styles.folderChipSelected]}
          onPress={() => setTarget('new')}
          testID="import-folder-new"
        >
          <Text style={styles.folderChipText}>＋ New folder</Text>
        </Pressable>
      </View>
      {target === 'new' ? (
        <TextInput
          style={styles.textField}
          value={newFolder}
          onChangeText={setNewFolder}
          placeholder="New folder name"
          returnKeyType="done"
          accessibilityLabel="New import folder name"
          testID="import-folder-name"
        />
      ) : null}
      <Pressable
        style={[styles.button, styles.importButton, importDisabled ? styles.buttonDisabled : null]}
        disabled={importDisabled}
        onPress={() => void runImport()}
        testID="tracks-import"
      >
        {importing ? (
          <ActivityIndicator color={theme.onAccent} />
        ) : (
          <Text style={styles.buttonText}>Choose files</Text>
        )}
      </Pressable>
      <Text style={styles.muted}>
        GPX, KML and KMZ tracks or waypoints use this folder. Atlas backups keep their original
        folders.
      </Text>
      {/* iNatur permit → boundary: paste an offer link/id and save its exact
          area into the folder chosen above, as a track. */}
      <Text style={styles.fieldLabel}>iNatur permit</Text>
      <View style={styles.inaturRow}>
        <TextInput
          style={[styles.textField, styles.inaturInput]}
          value={inaturInput}
          onChangeText={setInaturInput}
          placeholder="Offer link or id"
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="go"
          onSubmitEditing={() => {
            if (!inaturDisabled) void runInatur();
          }}
          accessibilityLabel="iNatur offer link or id"
          testID="inatur-input"
        />
        <Pressable
          style={[styles.button, inaturDisabled ? styles.buttonDisabled : null]}
          disabled={inaturDisabled}
          onPress={() => void runInatur()}
          testID="inatur-add"
        >
          {inaturBusy ? (
            <ActivityIndicator color={theme.onAccent} />
          ) : (
            <Text style={styles.buttonText}>Add area</Text>
          )}
        </Pressable>
      </View>
      {message ? <Text style={styles.muted}>{message}</Text> : null}
    </View>
  );
}

/**
 * Saved (places, tracks & folders) — the mobile counterpart of the web Sidebar:
 * browse everything saved (synced records from other devices appear here too),
 * organise it into folders, and control what's drawn on the map.
 *
 * Folders open one level at a time, like a phone's file browser: a row is a
 * folder's name, what it holds, its eye and a chevron; the open folder's header
 * carries back, the path above it and its own actions (hide, names on map,
 * rename, move up, delete). A filter lists matches flat under their folder
 * paths instead. Places fly to / navigate / edit as before; a track row frames
 * the track and opens its profile, and a long folder of runs lists newest
 * first, a page at a time.
 *
 * Since the Collections merge this is the *only* saved-data surface: import (files and whole
 * backups) and the iNatur permit tool moved in from the Tracks sheet, which is
 * gone. Two lists of the same tracks, reached from two menu entries, was the
 * "I am not sure where to find things" complaint in its purest form.
 */
export function FavoritesSheet({
  visible,
  revealItem,
  onRevealed,
  onClose,
  places,
  placeCommutes = new Map(),
  tracks,
  collections,
  pinLabels,
  onFlyTo,
  onNavigate,
  onPatch,
  onDelete,
  onShowTrack,
  onPlanTrack,
  onPatchTrack,
  onDeleteTrack,
  onExportTrack,
  onCreateFolder,
  onRenameFolder,
  onMoveFolder,
  onSetFolderVisible,
  onDeleteFolder,
  onSetAllVisible,
  onExportAll,
  onImport,
  onImportInatur,
  onDrop,
  bottomInset = 0,
}: {
  visible: boolean;
  revealItem?: CollectionRevealTarget | null;
  onRevealed?: () => void;
  onClose: () => void;
  places: PlaceRecord[];
  /** Commutes that use each saved place as an end. */
  placeCommutes?: ReadonlyMap<string, readonly string[]>;
  tracks: TrackRecord[];
  collections: CollectionRecord[];
  /** Which folders and tags draw their pins' names on the map. */
  pinLabels: PinLabelsController;
  onFlyTo: (place: PlaceRecord) => void;
  onNavigate: (place: PlaceRecord) => void;
  /** Patch a place (the editor batches its fields behind an explicit Save). */
  onPatch: (id: string, patch: EditablePlacePatch) => void;
  onDelete: (id: string) => void;
  /** Frame a track on the map (the row's name, like web's track row). */
  onShowTrack: (track: TrackRecord) => void;
  onPlanTrack: (track: TrackRecord) => void;
  onPatchTrack: (id: string, patch: EditableTrackPatch) => void;
  onDeleteTrack: (id: string) => void;
  onExportTrack: (id: string, format: 'gpx' | 'kml') => void;
  /** Create a folder — at the root, or nested under `parentId` (subfolder). */
  onCreateFolder: (name: string, parentId: string | null) => void;
  onRenameFolder: (id: string, name: string) => void;
  /** Re-parent a collection; the row action moves it up exactly one level. */
  onMoveFolder: (id: string, parentId: string | null) => void;
  onSetFolderVisible: (id: string, visible: boolean) => void;
  onDeleteFolder: (id: string) => void;
  /** Show or hide every place and folder at once (header toggle). */
  onSetAllVisible: (visible: boolean) => void;
  /** Export everything as a file — also in Settings → Account & data. */
  onExportAll: () => void;
  /** Pick files and import them; returns a per-run summary (null if cancelled). */
  onImport: (options?: ImportOptions) => Promise<ImportResult | null>;
  /** Resolve an iNatur permit link/id and import its boundary as a track. */
  onImportInatur: (input: string, options?: ImportOptions) => Promise<ImportResult | null>;
  /** Apply the shared place/folder drop spec after the native gesture is measured. */
  onDrop: (drag: CollectionDragItem, target: CollectionDragItem, zone: CollectionDropZone) => void;
  /** System nav-bar inset — keeps the Close button clear of it (edge-to-edge). */
  bottomInset?: number;
}) {
  // Which row's edit panel is currently open (the ✎ button or icon badge
  // toggles it). Keyed `place:<id>` / `track:<id>`, as on web — two record
  // kinds now share the list, and only one editor is ever open.
  const [editingKey, setEditingKey] = useState<string | null>(null);
  // The import block, folded away by default: it is four controls deep and the
  // list underneath is what the sheet is for.
  const [importOpen, setImportOpen] = useState(false);
  // What the list is narrowed to. Session-only: a filter is a way of looking
  // at the list, not a property of it.
  const [filter, setFilter] = useState('');
  // The folder being looked at; null is the top level. One level at a time:
  // the nested tree indented every level and gave each folder row seven
  // controls, so on a phone a subfolder's name had no room left, and opening
  // a folder of imported runs buried the rest of the list. Kept across
  // closes, like a file browser — tapping a run closes the sheet, and the
  // next one is picked from the same folder.
  const [folderId, setFolderId] = useState<string | null>(null);
  // How many tracks a level draws before "Show more": a folder of a few
  // hundred activities rendered every row up front.
  const [trackLimit, setTrackLimit] = useState(TRACK_PAGE);
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const scrollRef = useRef<ScrollView>(null);
  const revealRowRef = useRef<View>(null);
  const scrollY = useRef(0);
  useEffect(() => {
    if (!highlighted) return;
    const frame = requestAnimationFrame(() => {
      revealRowRef.current?.measureInWindow((_x, rowY) => {
        scrollRef.current?.getNativeScrollRef()?.measureInWindow((_sx, sheetY) => {
          scrollRef.current?.scrollTo({
            y: Math.max(0, scrollY.current + rowY - sheetY - 32),
            animated: true,
          });
        });
      });
    });
    const timer = setTimeout(() => setHighlighted(null), 2500);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, [highlighted]);
  const [newFolder, setNewFolder] = useState('');
  // The current folder's name is open for editing (its header's Rename).
  const [renaming, setRenaming] = useState(false);

  /** Go to a folder (null = top level), starting its list from the top. */
  const openFolder = (id: string | null) => {
    setFolderId(id);
    setEditingKey(null);
    setRenaming(false);
    setTrackLimit(TRACK_PAGE);
    scrollRef.current?.scrollTo({ y: 0, animated: false });
  };

  // A row is being dragged: freeze the sheet's scroll and close any editor so
  // row heights are uniform while the drag measures its way through the list.
  const [dragActive, setDragActive] = useState(false);
  const folderRefs = useRef(new Map<string, View>());
  const folderFrames = useRef(new Map<string, { top: number; bottom: number }>());
  const measureFolder = (id: string) => {
    folderRefs.current.get(id)?.measureInWindow((_x, y, _width, height) => {
      folderFrames.current.set(id, { top: y, bottom: y + height });
    });
  };
  const onDragActive = (active: boolean) => {
    setDragActive(active);
    if (active) {
      setEditingKey(null);
      // Only rows on screen now are targets — not those of a level left behind.
      folderFrames.current.clear();
      for (const id of folderRefs.current.keys()) measureFolder(id);
    }
  };

  // What the list is narrowed to — name, tag, notes or address, with a
  // leading `#` meaning tags alone, which is what a tapped tag chip writes.
  const filtered = useMemo(
    () => filterCollectionRecords({ collections, places, tracks }, filter),
    [collections, places, tracks, filter],
  );
  // Folder tree — derived by the shared model, so web and Android agree on
  // nesting, ordering and what happens to a folder whose parent is missing.
  // Browsing walks the whole tree; a filter lists what the filtered one holds.
  const allTree = useCollectionTree({ collections, places, tracks });
  const tree = useCollectionTree({
    collections: filtered.collections,
    places: filtered.places,
    tracks: filtered.tracks,
  });

  // A folder deleted here or on another device takes the view up to the top.
  const current = folderId === null ? null : (allTree.byId.get(folderId) ?? null);
  useEffect(() => {
    if (folderId !== null && !allTree.byId.has(folderId)) setFolderId(null);
  }, [folderId, allTree]);
  /** Folder names from the top level down to `id`, for breadcrumbs and result headings. */
  const pathOf = (id: string | null) =>
    ancestorFolderIds(allTree, id)
      .reverse()
      .map((ancestor) => allTree.byId.get(ancestor)!.folder);

  useEffect(() => {
    if (!visible || !revealItem) return;
    const item =
      revealItem.kind === 'track'
        ? tracks.find((track) => track.id === revealItem.id)
        : revealItem.kind === 'folder'
          ? collections.find((folder) => folder.id === revealItem.id)
          : places.find((place) => place.id === revealItem.id);
    if (item) {
      // A search pick should open the exact row without leaving a filter that
      // hides other saved data the next time Collections is opened.
      setFilter('');
      const parentId = 'parentId' in item ? item.parentId : item.collectionId;
      const level = parentId !== null && allTree.byId.has(parentId) ? parentId : null;
      setFolderId(level);
      setEditingKey(null);
      setRenaming(false);
      // A run deep in a long folder has to be drawn to be shown.
      const levelTracks = level === null ? allTree.tracks : allTree.byId.get(level)!.tracks;
      const index = tracksForList(levelTracks).findIndex((track) => track.id === revealItem.id);
      setTrackLimit(Math.max(TRACK_PAGE, index + 1));
      setHighlighted(`${revealItem.kind}:${revealItem.id}`);
    }
    onRevealed?.();
  }, [visible, revealItem, tracks, collections, places, allTree, onRevealed]);
  // Pickers (move-to-folder, import destination) offer *every* folder: a filter
  // narrows what you are looking at, never where you are allowed to put things.
  const flatFolders = useMemo(() => flattenFolders(collections), [collections]);
  // Tag pills offer the whole vocabulary for the same reason.
  const tagSuggestions = useMemo(
    () => collectionTagSuggestions([...places, ...tracks]),
    [places, tracks],
  );
  // A `#tag` filter naming a whole tag the user has is where that tag's labels
  // are switched: the rows on screen are exactly the pins it would name. A
  // partial `#sta` names no tag yet, so it offers nothing.
  const query = useMemo(() => parseCollectionQuery(filter), [filter]);
  const filterTag = useMemo(() => {
    if (!query.tagOnly || !query.text) return null;
    return tagSuggestions.find((tag) => tag.toLocaleLowerCase() === query.text) ?? null;
  }, [query, tagSuggestions]);

  const allShown =
    places.every((p) => p.visible) &&
    tracks.every((t) => t.visible) &&
    collections.every((c) => c.visible);

  const addFolder = () => {
    const name = newFolder.trim();
    if (!name) return;
    onCreateFolder(name, folderId);
    setNewFolder('');
  };

  const dropPlaceAtFolder = (place: PlaceRecord, pageY: number): boolean => {
    for (const [targetId, frame] of folderFrames.current) {
      if (pageY >= frame.top - 6 && pageY <= frame.bottom + 6) {
        onDrop({ kind: 'place', id: place.id }, { kind: 'folder', id: targetId }, 'inside');
        // Mark where it went — the place leaves this level, and without a cue
        // that reads as the place simply vanishing.
        setHighlighted(`folder:${targetId}`);
        return true;
      }
    }
    return false;
  };

  /**
   * A folder released over any visible folder row uses the same 30/40/30
   * before/inside/after zones as web. Releasing between rows falls back to the
   * sibling edge selected by ReorderableList.
   */
  const dropFolderAtFolder = (folder: CollectionRecord, pageY: number): boolean => {
    for (const [targetId, frame] of folderFrames.current) {
      if (targetId !== folder.id && pageY >= frame.top - 6 && pageY <= frame.bottom + 6) {
        const height = frame.bottom - frame.top;
        const position = height > 0 ? (pageY - frame.top) / height : 0.5;
        onDrop(
          { kind: 'folder', id: folder.id },
          { kind: 'folder', id: targetId },
          collectionDropZone(position, 'all'),
        );
        return true;
      }
    }
    return false;
  };

  const toggleEditing = (key: string) => setEditingKey((cur) => (cur === key ? null : key));

  const placeRow = (place: PlaceRecord, handle: ReactNode): ReactNode => {
    const key = `place:${place.id}`;
    return (
      <View>
        <View
          ref={highlighted === key ? revealRowRef : undefined}
          style={[
            styles.row,
            place.visible ? null : styles.rowHidden,
            highlighted === key ? styles.rowRevealed : null,
          ]}
        >
          {handle}
          <Pressable
            style={[styles.badge, { backgroundColor: place.color }]}
            onPress={() => toggleEditing(key)}
            testID={`favorite-style-${place.id}`}
          >
            <Text style={styles.badgeIcon}>{place.icon}</Text>
          </Pressable>
          <Pressable
            style={styles.rowMain}
            onPress={() => {
              onFlyTo(place);
              onClose();
            }}
            testID={`favorite-${place.id}`}
          >
            <Text style={styles.rowText} numberOfLines={1}>
              {place.name}
            </Text>
            <Text style={styles.muted}>
              {place.address || `${place.lat.toFixed(4)}, ${place.lng.toFixed(4)}`}
            </Text>
            {placeCommutes.has(place.id) ? (
              <Text style={styles.commuteBadge} numberOfLines={1}>
                Commute · {placeCommutes.get(place.id)!.join(', ')}
              </Text>
            ) : null}
            <TagChips tags={place.tags} onPick={setFilter} />
          </Pressable>
          <Pressable
            style={styles.eyeButton}
            onPress={() => onPatch(place.id, { visible: !place.visible })}
            testID={`favorite-visible-${place.id}`}
          >
            <EyeIcon off={!place.visible} />
          </Pressable>
          <Pressable
            style={[styles.button, styles.buttonQuiet]}
            onPress={() => toggleEditing(key)}
            testID={`favorite-edit-${place.id}`}
          >
            <Text style={styles.buttonQuietText}>✎</Text>
          </Pressable>
          <Pressable
            style={styles.button}
            onPress={() => {
              onNavigate(place);
              onClose();
            }}
            testID={`favorite-nav-${place.id}`}
          >
            <Text style={styles.buttonText}>Go</Text>
          </Pressable>
        </View>
        {editingKey === key ? (
          <ItemEditor
            id={place.id}
            noun="place"
            testPrefix="favorite"
            name={place.name}
            address={place.address}
            style={{ icon: place.icon, color: place.color }}
            collectionId={place.collectionId}
            notes={place.notes}
            tags={place.tags}
            folders={flatFolders}
            tagSuggestions={tagSuggestions}
            onSave={(patch) => onPatch(place.id, patch)}
            onDelete={() => onDelete(place.id)}
            onClose={() => setEditingKey(null)}
            inset
          />
        ) : null}
      </View>
    );
  };

  /**
   * A track row — the same shape as a place row minus the pin styling, and
   * without a drag handle: tracks have no stored order to arrange (web can't
   * drag them either). The name frames the track on the map, ✎ opens the same
   * editor a place gets, plus GPX/KML export.
   */
  const trackRow = (track: TrackRecord): ReactNode => {
    const key = `track:${track.id}`;
    return (
      <View key={key}>
        <View
          ref={highlighted === key ? revealRowRef : undefined}
          style={[
            styles.row,
            track.visible ? null : styles.rowHidden,
            highlighted === key ? styles.rowRevealed : null,
          ]}
        >
          <View style={styles.trackIconBox}>
            <Text style={styles.trackIcon}>〰</Text>
          </View>
          <Pressable
            style={styles.rowMain}
            onPress={() => {
              onShowTrack(track);
              onClose();
            }}
            testID={`track-${track.id}`}
          >
            <Text style={styles.rowText} numberOfLines={1}>
              {track.name}
            </Text>
            <Text style={styles.muted}>{trackListLine(track.stats)}</Text>
            <TagChips tags={userTags(track.tags)} onPick={setFilter} />
          </Pressable>
          <Pressable
            style={styles.eyeButton}
            onPress={() => onPatchTrack(track.id, { visible: !track.visible })}
            testID={`track-visible-${track.id}`}
          >
            <EyeIcon off={!track.visible} />
          </Pressable>
          <Pressable
            style={[styles.button, styles.buttonQuiet]}
            onPress={() => toggleEditing(key)}
            testID={`track-edit-${track.id}`}
          >
            <Text style={styles.buttonQuietText}>✎</Text>
          </Pressable>
        </View>
        {editingKey === key ? (
          <ItemEditor
            id={track.id}
            noun="track"
            testPrefix="track"
            name={track.name}
            collectionId={track.collectionId}
            notes={track.notes}
            tags={track.tags}
            folders={flatFolders}
            tagSuggestions={tagSuggestions}
            actions={
              <>
                <Pressable
                  style={[styles.button, styles.buttonQuiet]}
                  onPress={() => {
                    onPlanTrack(track);
                    onClose();
                  }}
                  testID={`track-plan-${track.id}`}
                >
                  <Text style={styles.buttonQuietText}>Plan route</Text>
                </Pressable>
                <Pressable
                  style={[styles.button, styles.buttonQuiet]}
                  onPress={() => onExportTrack(track.id, 'gpx')}
                  testID={`track-export-gpx-${track.id}`}
                >
                  <Text style={styles.buttonQuietText}>GPX</Text>
                </Pressable>
                <Pressable
                  style={[styles.button, styles.buttonQuiet]}
                  onPress={() => onExportTrack(track.id, 'kml')}
                  testID={`track-export-kml-${track.id}`}
                >
                  <Text style={styles.buttonQuietText}>KML</Text>
                </Pressable>
              </>
            }
            onSave={(patch) => onPatchTrack(track.id, patch)}
            onDelete={() => onDeleteTrack(track.id)}
            onClose={() => setEditingKey(null)}
            inset
          />
        ) : null}
      </View>
    );
  };

  /** A level's tracks, newest recording first, drawn a page at a time. */
  const renderTracks = (level: TrackRecord[]): ReactNode => {
    if (level.length === 0) return null;
    const ordered = tracksForList(level);
    const rest = ordered.length - trackLimit;
    return (
      <View>
        {ordered.slice(0, trackLimit).map(trackRow)}
        {rest > 0 ? (
          <Pressable
            style={[styles.button, styles.buttonQuiet, styles.moreButton]}
            onPress={() => setTrackLimit((limit) => limit + TRACK_PAGE)}
            testID="collections-more-tracks"
          >
            <Text style={styles.buttonQuietText}>
              Show {Math.min(rest, TRACK_PAGE)} more of {rest}
            </Text>
          </Pressable>
        ) : null}
      </View>
    );
  };

  const renderPlaces = (level: PlaceRecord[]): ReactNode => {
    if (level.length === 0) return null;
    return (
      <ReorderableList
        items={level}
        keyOf={(place) => place.id}
        onMove={(place, target, zone) =>
          onDrop({ kind: 'place', id: place.id }, { kind: 'place', id: target.id }, zone)
        }
        onDragActive={onDragActive}
        onDropAt={dropPlaceAtFolder}
        renderRow={placeRow}
      />
    );
  };

  /**
   * A folder as one full-width row: its name gets every pixel the eye and the
   * chevron leave, wrapping to two lines rather than clipping, with what it
   * holds underneath. Tapping it opens the folder; its own actions live in the
   * folder's header, where there is room to name them.
   */
  const folderRow = (folder: CollectionRecord, handle: ReactNode): ReactNode => {
    const node = allTree.byId.get(folder.id);
    const path = filtered.active ? pathOf(folder.parentId).map((f) => f.name) : [];
    return (
      <View
        ref={(view) => {
          if (view) folderRefs.current.set(folder.id, view);
          else folderRefs.current.delete(folder.id);
          if (highlighted === `folder:${folder.id}`) revealRowRef.current = view;
        }}
        onLayout={() => measureFolder(folder.id)}
        style={[
          styles.row,
          node?.visible === false ? styles.rowHidden : null,
          highlighted === `folder:${folder.id}` ? styles.rowRevealed : null,
        ]}
        testID={`folder-row-${folder.id}`}
      >
        {handle}
        <Pressable
          style={styles.folderOpen}
          onPress={() => {
            setFilter('');
            openFolder(folder.id);
          }}
          accessibilityRole="button"
          accessibilityLabel={`Open ${folder.name}`}
          testID={`folder-open-${folder.id}`}
        >
          <Text style={styles.folderIcon}>📁</Text>
          <View style={styles.rowMain}>
            <Text style={styles.rowText} numberOfLines={2}>
              {folder.name}
            </Text>
            <Text style={styles.muted} numberOfLines={1}>
              {path.length > 0 ? `${path.join(' › ')} · ` : ''}
              {node ? folderContentsLine(node) : ''}
            </Text>
          </View>
        </Pressable>
        <Pressable
          style={styles.eyeButton}
          onPress={() => onSetFolderVisible(folder.id, !folder.visible)}
          accessibilityLabel={`${folder.visible ? 'Hide' : 'Show'} ${folder.name} on the map`}
          testID={`folder-visible-${folder.id}`}
        >
          <EyeIcon off={!folder.visible} />
        </Pressable>
        <Text style={styles.chevronText}>›</Text>
      </View>
    );
  };

  const renderFolders = (level: CollectionRecord[]): ReactNode => {
    if (level.length === 0) return null;
    return (
      <ReorderableList
        items={level}
        keyOf={(folder) => folder.id}
        onMove={(folder, target, zone) =>
          onDrop({ kind: 'folder', id: folder.id }, { kind: 'folder', id: target.id }, zone)
        }
        onDragActive={onDragActive}
        onDropAt={dropFolderAtFolder}
        renderRow={folderRow}
      />
    );
  };

  /**
   * The open folder: where you are (back, the path above it, its whole name)
   * stays above the list while a long folder scrolls.
   */
  const folderHeader = (folder: CollectionRecord): ReactNode => {
    const above = pathOf(folder.parentId);
    return (
      <View style={styles.folderHeader}>
        <View style={styles.crumbRow}>
          <Pressable
            style={styles.backButton}
            onPress={() =>
              openFolder(
                folder.parentId !== null && allTree.byId.has(folder.parentId)
                  ? folder.parentId
                  : null,
              )
            }
            hitSlop={8}
            accessibilityLabel={`Back to ${above.at(-1)?.name ?? 'Collections'}`}
            testID="collections-back"
          >
            <Text style={styles.backText}>‹</Text>
          </Pressable>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.crumbs}>
            <Pressable onPress={() => openFolder(null)} hitSlop={6} testID="collections-crumb-root">
              <Text style={styles.crumb}>Collections</Text>
            </Pressable>
            {above.map((ancestor) => (
              <Pressable
                key={ancestor.id}
                onPress={() => openFolder(ancestor.id)}
                hitSlop={6}
                testID={`collections-crumb-${ancestor.id}`}
              >
                <Text style={styles.crumb}> › {ancestor.name}</Text>
              </Pressable>
            ))}
          </ScrollView>
        </View>
        {renaming ? (
          <TextInput
            style={[styles.textField, styles.folderTitleInput]}
            defaultValue={folder.name}
            autoFocus
            selectTextOnFocus
            onEndEditing={(e) => {
              const value = e.nativeEvent.text.trim();
              if (value && value !== folder.name) onRenameFolder(folder.id, value);
              setRenaming(false);
            }}
            returnKeyType="done"
            accessibilityLabel={`Rename ${folder.name}`}
            testID={`folder-rename-${folder.id}`}
          />
        ) : (
          <Text style={styles.folderTitle} numberOfLines={3} testID="collections-folder-title">
            📂 {folder.name}
          </Text>
        )}
      </View>
    );
  };

  /** The open folder's own actions, named in full — the row has no room for them. */
  const folderActions = (folder: CollectionRecord): ReactNode => (
    <View style={styles.folderActions}>
      <Pressable
        style={[styles.chipButton, folder.visible ? null : styles.chipButtonOn]}
        onPress={() => onSetFolderVisible(folder.id, !folder.visible)}
        accessibilityRole="switch"
        accessibilityState={{ checked: folder.visible }}
        testID="collections-folder-visible"
      >
        <EyeIcon off={!folder.visible} />
        <Text style={styles.chipButtonText}>{folder.visible ? 'On map' : 'Hidden'}</Text>
      </Pressable>
      <View style={styles.chipButton}>
        <PinLabelToggle
          on={folderHasPinLabels(pinLabels.prefs, folder.id)}
          what={folder.name}
          onToggle={() => void pinLabels.toggleFolder(folder.id)}
          testID={`folder-labels-${folder.id}`}
        />
        <Text style={styles.chipButtonText}>Names</Text>
      </View>
      <Pressable
        style={styles.chipButton}
        onPress={() => setRenaming(true)}
        testID={`folder-name-${folder.id}`}
      >
        <Text style={styles.chipButtonText}>Rename</Text>
      </Pressable>
      {folder.parentId !== null ? (
        <Pressable
          style={styles.chipButton}
          onPress={() => onMoveFolder(folder.id, promoteParentId(collections, folder))}
          accessibilityLabel={`Move ${folder.name} up one level`}
          testID={`folder-up-${folder.id}`}
        >
          <Text style={styles.chipButtonText}>↑ Move up</Text>
        </Pressable>
      ) : null}
      <Pressable
        style={styles.chipButton}
        onPress={() =>
          confirmDelete(
            `Delete folder “${folder.name}”?`,
            'Places, tracks and subfolders inside it move up one level.',
            () => {
              openFolder(
                folder.parentId !== null && allTree.byId.has(folder.parentId)
                  ? folder.parentId
                  : null,
              );
              onDeleteFolder(folder.id);
            },
          )
        }
        testID={`folder-delete-${folder.id}`}
      >
        <Text style={[styles.chipButtonText, styles.dangerText]}>Delete</Text>
      </Pressable>
    </View>
  );

  /** One folder level: its subfolders, a new-folder field, then what is filed in it. */
  const renderLevel = (): ReactNode => {
    const subfolders = (allTree.byParent.get(folderId) ?? []).map((node) => node.folder);
    const levelPlaces = current ? current.places : allTree.places;
    const levelTracks = current ? current.tracks : allTree.tracks;
    const nothingSaved = places.length === 0 && tracks.length === 0 && collections.length === 0;
    return (
      <>
        {current ? folderActions(current.folder) : null}
        {renderFolders(subfolders)}
        <View style={styles.row}>
          <TextInput
            style={[styles.folderName, styles.newFolderInput]}
            value={newFolder}
            onChangeText={setNewFolder}
            placeholder={current ? `New folder in ${current.folder.name}…` : 'New folder…'}
            returnKeyType="done"
            onSubmitEditing={addFolder}
            testID="folder-new-name"
          />
          <Pressable
            style={[styles.button, newFolder.trim() ? null : styles.buttonDisabled]}
            disabled={!newFolder.trim()}
            onPress={addFolder}
            testID="folder-add"
          >
            <Text style={styles.buttonText}>Add</Text>
          </Pressable>
        </View>
        {nothingSaved ? (
          <Text style={styles.muted}>
            Nothing saved yet. Long-press the map to save a pin, import a GPX/KML/KMZ file — or sign
            in to sync what you saved on your other devices.
          </Text>
        ) : current && current.children.length + levelPlaces.length + levelTracks.length === 0 ? (
          <Text style={styles.muted}>This folder is empty.</Text>
        ) : null}
        {renderPlaces(levelPlaces)}
        {renderTracks(levelTracks)}
      </>
    );
  };

  /**
   * A filter lists its matches flat, each group headed by the folder path it
   * sits in — the answer is the rows, and drilling through folders to reach
   * them would hide it. Folders whose name matched come first, to open.
   */
  const renderResults = (): ReactNode => {
    const namedFolders = query.tagOnly
      ? []
      : filtered.collections.filter((folder) =>
          folder.name.toLocaleLowerCase().includes(query.text),
        );
    const groups = [
      { id: null as string | null, places: tree.places, tracks: tree.tracks },
      ...flattenCollectionTree(tree).map(({ folder }) => {
        const node = tree.byId.get(folder.id)!;
        return { id: folder.id as string | null, places: node.places, tracks: node.tracks };
      }),
    ].filter((group) => group.places.length + group.tracks.length > 0);
    return (
      <>
        {namedFolders.length > 0 ? (
          <>
            <Text style={styles.sectionLabel}>Folders</Text>
            {namedFolders.map((folder) => (
              <View key={folder.id}>{folderRow(folder, null)}</View>
            ))}
          </>
        ) : null}
        {groups.map((group) => (
          <View key={group.id ?? 'root'}>
            <Text style={styles.sectionLabel} numberOfLines={2}>
              {group.id === null
                ? 'Not in a folder'
                : pathOf(group.id)
                    .map((folder) => folder.name)
                    .join(' › ')}
            </Text>
            {renderPlaces(group.places)}
            {renderTracks(group.tracks)}
          </View>
        ))}
      </>
    );
  };

  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      initialSnap="half"
      bottomInset={bottomInset}
      testID="favorites-sheet"
    >
      <View style={styles.headerRow}>
        <Text style={styles.heading}>Collections</Text>
        <View style={styles.headerActions}>
          <Pressable
            style={[styles.button, styles.buttonQuiet, importOpen ? styles.buttonOn : null]}
            onPress={() => setImportOpen((open) => !open)}
            accessibilityLabel="Import files, backups and permits"
            testID="favorites-import"
          >
            <Text style={styles.buttonQuietText}>Import</Text>
          </Pressable>
          {/* Also in Settings → Account & data. Two homes on purpose: web puts
              it on this header, and a user who learned it there should find it
              here (rule 5 is about the data, not about one route to it). */}
          <Pressable
            style={[styles.button, styles.buttonQuiet]}
            onPress={onExportAll}
            testID="favorites-export-all"
          >
            <Text style={styles.buttonQuietText}>Export all</Text>
          </Pressable>
          {places.length > 0 || tracks.length > 0 || collections.length > 0 ? (
            <Pressable
              style={[styles.button, styles.buttonQuiet]}
              onPress={() => onSetAllVisible(!allShown)}
              testID="toggle-all-visible"
            >
              <Text style={styles.buttonQuietText}>{allShown ? 'Hide all' : 'Show all'}</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
      {importOpen ? (
        <ImportControls folders={flatFolders} onImport={onImport} onImportInatur={onImportInatur} />
      ) : null}

      <View style={styles.filterRow}>
        <TextInput
          style={[styles.textField, styles.filterInput]}
          value={filter}
          onChangeText={(text) => {
            setFilter(text);
            setTrackLimit(TRACK_PAGE);
          }}
          placeholder="Filter by name, #tag or notes"
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          accessibilityLabel="Filter collections"
          testID="collections-filter"
        />
        {filterTag !== null ? (
          <PinLabelToggle
            on={tagHasPinLabels(pinLabels.prefs, filterTag)}
            what={`#${filterTag}`}
            onToggle={() => void pinLabels.toggleTag(filterTag)}
            testID="collections-filter-labels"
          />
        ) : null}
        {filtered.active ? (
          <Pressable
            style={[styles.button, styles.buttonQuiet]}
            onPress={() => setFilter('')}
            accessibilityLabel="Clear filter"
            testID="collections-filter-clear"
          >
            <Text style={styles.buttonQuietText}>✕</Text>
          </Pressable>
        ) : null}
      </View>
      {!filtered.active && current ? folderHeader(current.folder) : null}

      <ScrollView
        ref={scrollRef}
        style={styles.scroll}
        scrollEnabled={!dragActive}
        onScroll={(event) => {
          scrollY.current = event.nativeEvent.contentOffset.y;
        }}
        scrollEventThrottle={16}
      >
        {/* A filter that matched nothing is not an empty collection: saying
            "nothing saved yet" to someone whose pins are all still there reads
            as data loss. */}
        {filtered.active && filtered.empty ? (
          <Text style={styles.muted}>Nothing here matches “{filter.trim()}”.</Text>
        ) : null}
        {filtered.active ? renderResults() : renderLevel()}
      </ScrollView>
      <Pressable
        style={[styles.button, styles.closeButton]}
        onPress={onClose}
        testID="favorites-close"
      >
        <Text style={styles.buttonText}>Close</Text>
      </Pressable>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: 6,
    marginBottom: 6,
  },
  heading: { fontSize: 15, fontWeight: '700', color: theme.text },
  headerActions: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6 },
  importBlock: {
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingBottom: 10,
    marginBottom: 4,
  },
  fieldLabel: { fontSize: 12, fontWeight: '600', color: theme.textMuted, marginTop: 8 },
  choiceRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 4 },
  folderChip: {
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 14,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  folderChipSelected: { borderColor: theme.accent, backgroundColor: theme.surfaceMuted },
  folderChipText: { fontSize: 12, color: theme.text },
  textField: {
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 15,
    color: theme.text,
    marginTop: 6,
  },
  importButton: { marginTop: 8, alignItems: 'center' },
  filterRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  filterInput: { flex: 1, marginTop: 0 },
  tagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 3 },
  tagChip: {
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 10,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  tagChipText: { fontSize: 11, color: theme.textMuted },
  inaturRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 },
  inaturInput: { flex: 1 },
  close: { fontSize: 18, color: theme.textMuted, paddingHorizontal: 4 },
  sectionLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: theme.textMuted,
    marginTop: 14,
    marginBottom: 4,
  },
  muted: { fontSize: 13, color: theme.textMuted, marginTop: 2 },
  commuteBadge: { color: theme.accent, fontSize: 11, fontWeight: '700', marginTop: 2 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8 },
  rowRevealed: { backgroundColor: theme.accentFaint, borderRadius: 8 },
  rowHidden: { opacity: 0.45 },
  eyeButton: { paddingHorizontal: 2, paddingVertical: 4 },
  folderIcon: { fontSize: 20 },
  // The whole name block opens the folder: icon, name and contents line.
  folderOpen: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10 },
  chevronText: { fontSize: 22, color: theme.textMuted, paddingHorizontal: 2 },
  folderHeader: { marginTop: 8, gap: 2 },
  crumbRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  backButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: theme.surfaceMuted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backText: { fontSize: 22, lineHeight: 24, color: theme.text, fontWeight: '600' },
  crumbs: { flexGrow: 1, flexShrink: 1 },
  crumb: { fontSize: 13, color: theme.accent, fontWeight: '600', paddingVertical: 4 },
  folderTitle: { fontSize: 18, fontWeight: '700', color: theme.text, paddingVertical: 2 },
  folderTitleInput: { fontSize: 18, fontWeight: '700' },
  folderActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8, marginBottom: 4 },
  chipButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 16,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  chipButtonOn: { borderColor: theme.accent },
  chipButtonText: { fontSize: 13, color: theme.text, fontWeight: '600' },
  dangerText: { color: theme.danger },
  moreButton: { alignItems: 'center', marginTop: 6 },
  folderName: {
    flexGrow: 1,
    flexShrink: 1,
    fontSize: 16,
    color: theme.text,
    paddingVertical: 4,
  },
  newFolderInput: {
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  badge: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeIcon: { fontSize: 17 },
  // Same footprint as a place's colour badge, so track and place names line up.
  trackIconBox: { width: 34, alignItems: 'center', justifyContent: 'center' },
  trackIcon: { fontSize: 18, color: theme.textMuted },
  rowMain: { flexShrink: 1, flexGrow: 1 },
  rowText: { fontSize: 16, color: theme.text },
  button: {
    backgroundColor: theme.accent,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  buttonDisabled: { opacity: 0.5 },
  buttonText: { color: theme.onAccent, fontWeight: '600' },
  buttonQuiet: { backgroundColor: theme.surfaceMuted },
  buttonQuietText: { color: theme.text, fontWeight: '600' },
  // A quiet button that is currently *doing* something — the open disclosure.
  buttonOn: { borderWidth: 1, borderColor: theme.accent },
  closeButton: { marginTop: 14, alignSelf: 'stretch', alignItems: 'center' },
});
