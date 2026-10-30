import {
  libraryPlaces,
  libraryPlaceLine,
  libraryPlaceName,
  libraryVisibility,
  isQuickAccess,
  quickAccessTags,
  quickAccessTiles,
  libraryOnMapCount,
  type LibraryPlaceSort,
  type LibraryTrackSort,
  ancestorFolderIds,
  collectionDropZone,
  collectionTagSuggestions,
  filterCollectionRecords,
  activityDate,
  activityYearCounts,
  librarySportCounts,
  libraryTrackLine,
  libraryTrackSport,
  libraryTrackTags,
  libraryTracks,
  type LibraryView,
  flattenCollectionTree,
  folderContentsLine,
  importedCount,
  parseCollectionQuery,
  promoteParentId,
  tagQuery,
  tracksForList,
  type PinLabelsController,
  type GarminState,
  useCollectionTree,
  type CollectionDragItem,
  type CollectionDropZone,
} from '@atlas/app-hooks';
import {
  fmtShortDate,
  folderHasPinLabels,
  garminSportIcon,
  tagHasPinLabels,
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
import { ActionMenu, ActionSheet, FilterMenu, type MenuAction } from './FilterMenu';
import { GarminCourses } from './GarminCourses';
import { DirectionsIcon, FolderIcon, FolderPlusIcon, LayersIcon, MapPinIcon } from './modeIcons';
import { theme } from './theme';

/** Tracks a folder level draws before its "Show more" button. */
const TRACK_PAGE = 30;
/**
 * Places a list draws before its "Show more" button. A camper-stop guide imported as one folder
 * is 780 pins, and every row drawn up front made the Places tab take seconds to open.
 */
const PLACE_PAGE = 40;
/** The folder a Garmin Explore waypoint export is filed into. */
const GARMIN_LOCATIONS = 'Garmin locations';

/**
 * Garmin has no tab of its own: its courses are routes, its recordings activities and its
 * watch locations places, so each is found where that kind of thing is looked for.
 */
type CollectionsView = LibraryView;

const VIEW_LABELS: Record<CollectionsView, string> = {
  folders: 'Folders',
  places: 'Places',
  courses: 'Routes',
  activities: 'Activities',
};

/** "14:05" today, otherwise "3 Oct". */
function fmtCheckTime(at: number): string {
  const date = new Date(at);
  if (date.toDateString() === new Date().toDateString()) {
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  }
  return fmtShortDate(at);
}

/** "2026-05-01" → "1 May" (this year) or "1 May 2025". */
function recordedLabel(date: string): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return fmtShortDate(new Date(year, month - 1, day).getTime());
}

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
  garmin,
  onRevealGarminItem,
  onShowGarminTrack,
  onEditGarminCourse,
  revealItem,
  onRevealed,
  onClose,
  places,
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
  onShowOnlyTracks,
  onSetTracksVisible,
  onExportAll,
  onImport,
  onImportInatur,
  onDrop,
  bottomInset = 0,
}: {
  visible: boolean;
  garmin: GarminState;
  onRevealGarminItem: (target: CollectionRevealTarget) => void;
  onShowGarminTrack: (id: string) => void;
  onEditGarminCourse: (id: string) => void;
  revealItem?: CollectionRevealTarget | null;
  onRevealed?: () => void;
  onClose: () => void;
  places: PlaceRecord[];
  tracks: TrackRecord[];
  collections: CollectionRecord[];
  /** Which folders and tags draw their pins' names on the map. */
  pinLabels: PinLabelsController;
  /** Reveal a place on the map with its card — what tapping a row or a tile does. */
  onFlyTo: (place: PlaceRecord) => void;
  /** Plan a route there now: a Quick access tile's arrow, or a row's Directions. */
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
  onShowOnlyTracks: (ids: string[]) => void;
  /** Show or hide just these tracks (the Routes or Activities list), leaving the rest. */
  onSetTracksVisible: (ids: string[], visible: boolean) => void;
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
  const [view, setView] = useState<CollectionsView>('folders');
  const [placeSort, setPlaceSort] = useState<LibraryPlaceSort>('name');
  const [trackSort, setTrackSort] = useState<LibraryTrackSort>('newest');
  const [reordering, setReordering] = useState(false);
  const [sport, setSport] = useState<string | null>(null);
  const [year, setYear] = useState<number | null>(null);
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
  const [placeLimit, setPlaceLimit] = useState(PLACE_PAGE);
  const [highlighted, setHighlighted] = useState<string | null>(null);
  // The long-pressed row's actions (or Manage's), in one sheet for the whole list.
  const [menu, setMenu] = useState<{ title: string; actions: MenuAction[] } | null>(null);
  // Quick access: removing shortcuts is its own mode, and past six the rest fold away.
  const [quickEditing, setQuickEditing] = useState(false);
  const [quickExpanded, setQuickExpanded] = useState(false);
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
  // The new-folder field, folded behind a button: an always-open text box on
  // every level was the first thing under the tabs, above the folders it adds to.
  const [addingFolder, setAddingFolder] = useState(false);
  // The current folder's name is open for editing (its header's Rename).
  const [renaming, setRenaming] = useState(false);

  /** Go to a folder (null = top level), starting its list from the top. */
  const openFolder = (id: string | null) => {
    setFolderId(id);
    setReordering(false);
    setEditingKey(null);
    setRenaming(false);
    setTrackLimit(TRACK_PAGE);
    setPlaceLimit(PLACE_PAGE);
    setAddingFolder(false);
    setQuickEditing(false);
    scrollRef.current?.scrollTo({ y: 0, animated: false });
  };

  /** Switch tabs, starting the new one unfiltered and from the top. */
  const showView = (next: CollectionsView) => {
    setView(next);
    setReordering(false);
    setSport(null);
    setYear(null);
    setTrackLimit(TRACK_PAGE);
    setPlaceLimit(PLACE_PAGE);
    setEditingKey(null);
    setQuickEditing(false);
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
  // On Places a search finds folders and places, wherever the user is standing
  // (top level, a folder or All places); tracks are found on their own tabs.
  const placesTab = view === 'folders' || view === 'places';
  const filtered = useMemo(
    () =>
      filterCollectionRecords(
        { collections, places, tracks: placesTab && filter.trim() ? [] : tracks },
        filter,
      ),
    [collections, places, tracks, filter, placesTab],
  );
  const viewSource = useMemo(
    () => libraryTracks(tracks, view === 'activities' ? 'activities' : 'courses', null, null),
    [tracks, view],
  );
  const viewTracks = useMemo(
    () =>
      libraryTracks(
        filtered.tracks,
        view === 'activities' ? 'activities' : 'courses',
        sport,
        year,
        trackSort,
      ),
    [filtered.tracks, view, sport, year, trackSort],
  );
  const sports = useMemo(() => librarySportCounts(viewSource), [viewSource]);
  const onMap = useMemo(
    () => libraryOnMapCount(viewTracks, tracks, collections),
    [viewTracks, tracks, collections],
  );
  const years = useMemo(() => activityYearCounts(viewSource), [viewSource]);
  // Tab counts are of everything saved, so a filter typed on one tab does not
  // make another look empty.
  const activities = useMemo(() => libraryTracks(tracks, 'activities', null, null), [tracks]);
  const garminLocations = useMemo(
    () => collections.find((item) => item.name === GARMIN_LOCATIONS && item.parentId === null),
    [collections],
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
      setView('folders');
      const parentId = 'parentId' in item ? item.parentId : item.collectionId;
      const level = parentId !== null && allTree.byId.has(parentId) ? parentId : null;
      setFolderId(level);
      setEditingKey(null);
      setRenaming(false);
      // A run deep in a long folder has to be drawn to be shown.
      const levelTracks = level === null ? allTree.tracks : allTree.byId.get(level)!.tracks;
      const index = tracksForList(levelTracks).findIndex((track) => track.id === revealItem.id);
      setTrackLimit(Math.max(TRACK_PAGE, index + 1));
      const levelPlaces = level === null ? allTree.places : allTree.byId.get(level)!.places;
      const placeIndex = levelPlaces.findIndex((place) => place.id === revealItem.id);
      setPlaceLimit(Math.max(PLACE_PAGE, placeIndex + 1));
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
    setAddingFolder(false);
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

  /** A place's occasional actions — a long-press away, never a button on every row. */
  const placeActions = (place: PlaceRecord): MenuAction[] => [
    {
      label: 'Directions',
      onPress: () => {
        onNavigate(place);
        onClose();
      },
      testID: `favorite-nav-${place.id}`,
    },
    {
      label: 'Edit place',
      onPress: () => setEditingKey(`place:${place.id}`),
      testID: `favorite-edit-${place.id}`,
    },
    {
      label: isQuickAccess(place) ? 'Remove from Quick access' : 'Pin to Quick access',
      onPress: () => onPatch(place.id, { tags: quickAccessTags(place) }),
      testID: `favorite-quick-${place.id}`,
    },
    {
      label: 'Delete place…',
      danger: true,
      onPress: () =>
        confirmDelete(
          `Delete “${libraryPlaceName(place)}”?`,
          'You can undo this right after.',
          () => onDelete(place.id),
        ),
      testID: `favorite-delete-${place.id}`,
    },
  ];

  /**
   * A place row: its pin, name and where it is filed, and the eye. Tapping reveals it on the
   * map with its card, from which navigating is an explicit choice; holding it offers the
   * rest. While reordering, holding drags instead — and the empty long-press keeps the
   * release from also counting as a tap.
   */
  const placeRow = (place: PlaceRecord, handle: ReactNode): ReactNode => {
    const key = `place:${place.id}`;
    const name = libraryPlaceName(place);
    const mapState = libraryVisibility(place, collections);
    return (
      <View>
        <View
          ref={highlighted === key ? revealRowRef : undefined}
          style={[styles.row, highlighted === key ? styles.rowRevealed : null]}
        >
          {handle}
          <Pressable
            style={styles.rowPress}
            onPress={() => {
              onFlyTo(place);
              onClose();
            }}
            onLongPress={
              reordering ? () => {} : () => setMenu({ title: name, actions: placeActions(place) })
            }
            accessibilityHint="Shows it on the map. Long-press for more actions."
            testID={`favorite-${place.id}`}
          >
            <View style={[styles.badge, { backgroundColor: place.color }]}>
              <Text style={styles.badgeIcon}>{place.icon}</Text>
            </View>
            <View style={styles.rowMain}>
              <Text style={styles.rowText} numberOfLines={2}>
                {name}
              </Text>
              <Text style={styles.muted} numberOfLines={1}>
                {libraryPlaceLine(place, collections)}
              </Text>
              <TagChips
                tags={place.tags.filter((tag) => tag !== 'quick-access')}
                onPick={setFilter}
              />
            </View>
          </Pressable>
          <Pressable
            style={styles.eyeButton}
            onPress={() => onPatch(place.id, { visible: !place.visible })}
            accessibilityRole="button"
            accessibilityLabel={`${place.visible ? 'Hide' : 'Show'} ${place.name} on map. ${mapState}`}
            accessibilityState={{ selected: place.visible }}
            testID={`favorite-visible-${place.id}`}
          >
            <EyeIcon off={mapState !== 'On map'} />
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

  /** A track's actions, behind a long-press like a place's. */
  const trackActions = (track: TrackRecord): MenuAction[] => [
    {
      label: 'Edit',
      onPress: () => setEditingKey(`track:${track.id}`),
      testID: `track-edit-${track.id}`,
    },
    {
      label: 'Plan route',
      onPress: () => {
        onPlanTrack(track);
        onClose();
      },
      testID: `track-plan-${track.id}`,
    },
    {
      label: 'Export GPX',
      onPress: () => onExportTrack(track.id, 'gpx'),
      testID: `track-export-gpx-${track.id}`,
    },
    {
      label: 'Export KML',
      onPress: () => onExportTrack(track.id, 'kml'),
      testID: `track-export-kml-${track.id}`,
    },
    {
      label: 'Delete…',
      danger: true,
      onPress: () =>
        confirmDelete(`Delete “${track.name}”?`, 'You can undo this right after.', () =>
          onDeleteTrack(track.id),
        ),
      testID: `track-delete-${track.id}`,
    },
  ];

  /**
   * A track row: sport, name, the one line that answers "which one was it", and the eye.
   * Tapping frames it and opens its profile; holding offers edit, plan and export. Tracks
   * have no stored order to arrange, so there is no drag handle.
   */
  const trackRow = (track: TrackRecord): ReactNode => {
    const key = `track:${track.id}`;
    const mapState = libraryVisibility(track, collections);
    return (
      <View key={key}>
        <View
          ref={highlighted === key ? revealRowRef : undefined}
          style={[styles.row, highlighted === key ? styles.rowRevealed : null]}
        >
          <Pressable
            style={styles.rowPress}
            onPress={() => {
              onShowTrack(track);
              onClose();
            }}
            onLongPress={() => setMenu({ title: track.name, actions: trackActions(track) })}
            accessibilityHint="Shows it on the map. Long-press for more actions."
            testID={`track-${track.id}`}
          >
            <View style={styles.trackIconBox}>
              <Text style={styles.trackIcon}>{garminSportIcon(libraryTrackSport(track))}</Text>
            </View>
            <View style={styles.rowMain}>
              <Text style={styles.rowText} numberOfLines={2}>
                {track.name}
              </Text>
              <Text style={styles.muted} numberOfLines={1}>
                {libraryTrackLine(track)}
              </Text>
              <TagChips tags={libraryTrackTags(track)} onPick={setFilter} />
            </View>
          </Pressable>
          <Pressable
            style={styles.eyeButton}
            onPress={() => onPatchTrack(track.id, { visible: !track.visible })}
            accessibilityRole="button"
            accessibilityLabel={`${track.visible ? 'Hide' : 'Show'} ${track.name} on map. ${mapState}`}
            accessibilityState={{ selected: track.visible }}
            testID={`track-visible-${track.id}`}
          >
            <EyeIcon off={mapState !== 'On map'} />
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
  const renderTracks = (level: TrackRecord[], presorted = false): ReactNode => {
    if (level.length === 0) return null;
    const ordered = presorted ? level : tracksForList(level);
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

  /**
   * Places, a page at a time. Inside a folder they can be dragged into order or
   * onto a folder; a flat list across folders (the Places tab) has no order to
   * arrange, so its rows name their folder instead of carrying a handle.
   */
  const renderPlaces = (level: PlaceRecord[], flat = false): ReactNode => {
    if (level.length === 0) return null;
    const shown = level.slice(0, placeLimit);
    const rest = level.length - shown.length;
    return (
      <View>
        {flat ? (
          shown.map((place) => <View key={place.id}>{placeRow(place, null)}</View>)
        ) : (
          <ReorderableList
            holdToDrag={reordering && editingKey === null}
            showHandles={reordering && !filtered.active}
            items={shown}
            keyOf={(place) => place.id}
            onMove={(place, target, zone) =>
              onDrop({ kind: 'place', id: place.id }, { kind: 'place', id: target.id }, zone)
            }
            onDragActive={onDragActive}
            onDropAt={dropPlaceAtFolder}
            renderRow={(place, handle) => placeRow(place, handle)}
          />
        )}
        {rest > 0 ? (
          <Pressable
            style={[styles.button, styles.buttonQuiet, styles.moreButton]}
            onPress={() => setPlaceLimit((limit) => limit + PLACE_PAGE)}
            testID="collections-more-places"
          >
            <Text style={styles.buttonQuietText}>
              Show {Math.min(rest, PLACE_PAGE)} more of {rest}
            </Text>
          </Pressable>
        ) : null}
      </View>
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
        style={[styles.row, highlighted === `folder:${folder.id}` ? styles.rowRevealed : null]}
        testID={`folder-row-${folder.id}`}
      >
        {handle}
        <Pressable
          style={styles.folderOpen}
          onPress={() => {
            setFilter('');
            setView('folders');
            openFolder(folder.id);
          }}
          accessibilityRole="button"
          accessibilityLabel={`Open ${folder.name}`}
          onLongPress={() => {}}
          testID={`folder-open-${folder.id}`}
        >
          <View style={styles.rowIcon}>
            <FolderIcon color={theme.icon} />
          </View>
          <View style={styles.rowMain}>
            <Text style={styles.rowText} numberOfLines={2}>
              {folder.name}
            </Text>
            {/* What it holds, not whether it is drawn: the eye beside it says that, and
                hiding a folder never changes what is filed in it. */}
            <Text style={styles.muted} numberOfLines={1}>
              {path.length > 0 ? `${path.join(' › ')} · ` : ''}
              {node ? folderContentsLine(node) : ''}
            </Text>
          </View>
        </Pressable>
        <Pressable
          style={styles.eyeButton}
          onPress={() => onSetFolderVisible(folder.id, !folder.visible)}
          accessibilityRole="button"
          accessibilityState={{ selected: folder.visible }}
          accessibilityLabel={`${folder.visible ? 'Hide' : 'Show'} ${folder.name} on the map. ${libraryVisibility({ visible: folder.visible, collectionId: folder.parentId }, collections)}`}
          testID={`folder-visible-${folder.id}`}
        >
          <EyeIcon off={!node?.visible} />
        </Pressable>
        <Text style={styles.chevronText}>›</Text>
      </View>
    );
  };

  const renderFolders = (level: CollectionRecord[]): ReactNode => {
    if (level.length === 0) return null;
    return (
      <ReorderableList
        holdToDrag={reordering && editingKey === null}
        showHandles={reordering && !filtered.active}
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
          <Text style={[styles.rowText, styles.rowMain]} numberOfLines={2}>
            {folder.name}
          </Text>
          {folderActions(folder)}
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
          <Text style={styles.muted} testID="collections-folder-title">
            {above.length ? above.map((item) => item.name).join(' › ') : 'Places'}
          </Text>
        )}
      </View>
    );
  };

  /** The open folder's own actions, named in full — the row has no room for them. */
  const folderActions = (folder: CollectionRecord): ReactNode => (
    <View style={styles.folderActions}>
      <ActionMenu
        title={folder.name}
        testID={`folder-more-${folder.id}`}
        actions={[
          {
            label: `${folder.visible ? '✓ ' : ''}Show on map`,
            onPress: () => onSetFolderVisible(folder.id, !folder.visible),
            testID: 'collections-folder-visible',
            selected: folder.visible,
          },
          {
            label: `${folderHasPinLabels(pinLabels.prefs, folder.id) ? '✓ ' : ''}Show labels`,
            onPress: () => void pinLabels.toggleFolder(folder.id),
            testID: `folder-labels-${folder.id}`,
            selected: folderHasPinLabels(pinLabels.prefs, folder.id),
          },
          { label: 'New subfolder', onPress: () => setAddingFolder(true), testID: 'folder-new' },
          {
            label: reordering ? 'Done reordering' : 'Reorder',
            onPress: () => setReordering((value) => !value),
            testID: 'collections-reorder',
          },
          { label: 'Rename', onPress: () => setRenaming(true), testID: `folder-name-${folder.id}` },
          ...(folder.parentId !== null
            ? [
                {
                  label: 'Move up one level',
                  onPress: () => onMoveFolder(folder.id, promoteParentId(collections, folder)),
                  testID: `folder-up-${folder.id}`,
                },
              ]
            : []),
          {
            label: 'Delete folder…',
            danger: true,
            onPress: () =>
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
              ),
            testID: `folder-delete-${folder.id}`,
          },
        ]}
      />
    </View>
  );

  /**
   * Quick access: a few personal shortcuts as tiles, two to a row. A tile shows the place on
   * the map; its arrow plans the way there in one tap. Pinning is a tag on the place itself,
   * so a shortcut stays filed in its folder and is never a second copy.
   */
  const quickAccess = (): ReactNode => {
    const { shown, more } = quickAccessTiles(places, quickExpanded);
    const editing = quickEditing && shown.length > 0;
    return (
      <View testID="quick-access">
        <View style={styles.sectionHead}>
          <Text style={styles.sectionTitle}>Quick access</Text>
          {shown.length > 0 ? (
            <Pressable
              onPress={() => setQuickEditing((value) => !value)}
              hitSlop={10}
              accessibilityRole="button"
              testID="quick-edit"
            >
              <Text style={styles.link}>{editing ? 'Done' : 'Edit'}</Text>
            </Pressable>
          ) : null}
        </View>
        {shown.length === 0 ? (
          <Text style={styles.muted}>
            Long-press a saved place and pin it here for one-tap access.
          </Text>
        ) : (
          <View style={styles.tileGrid}>
            {shown.map((place) => {
              const name = libraryPlaceName(place);
              return (
                <View key={`quick:${place.id}`} style={styles.tile}>
                  <Pressable
                    style={styles.tileMain}
                    disabled={editing}
                    onPress={() => {
                      onFlyTo(place);
                      onClose();
                    }}
                    onLongPress={() => setQuickEditing(true)}
                    accessibilityLabel={`Show ${name} on the map`}
                    testID={`quick-place-${place.id}`}
                  >
                    <View style={[styles.tileBadge, { backgroundColor: place.color }]}>
                      <Text style={styles.tileIcon}>{place.icon}</Text>
                    </View>
                    <Text style={styles.tileName} numberOfLines={2}>
                      {name}
                    </Text>
                  </Pressable>
                  {editing ? (
                    <Pressable
                      style={styles.tileCorner}
                      onPress={() => onPatch(place.id, { tags: quickAccessTags(place) })}
                      hitSlop={6}
                      accessibilityLabel={`Remove ${name} from Quick access`}
                      testID={`quick-remove-${place.id}`}
                    >
                      <Text style={styles.tileRemove}>✕</Text>
                    </Pressable>
                  ) : (
                    <Pressable
                      style={styles.tileCorner}
                      onPress={() => {
                        onNavigate(place);
                        onClose();
                      }}
                      hitSlop={6}
                      accessibilityLabel={`Directions to ${name}`}
                      testID={`quick-go-${place.id}`}
                    >
                      <DirectionsIcon color={theme.accent} size={22} />
                    </Pressable>
                  )}
                </View>
              );
            })}
            {more > 0 ? (
              <Pressable
                style={[styles.tile, styles.tileMain]}
                onPress={() => setQuickExpanded(true)}
                accessibilityLabel={`Show ${more} more shortcuts`}
                testID="quick-more"
              >
                <View style={[styles.tileBadge, styles.tileBadgeMore]}>
                  <Text style={styles.tileMoreIcon}>⋯</Text>
                </View>
                <Text style={styles.tileName}>{more} more</Text>
              </Pressable>
            ) : null}
          </View>
        )}
      </View>
    );
  };

  /** The new-folder name field, folded behind the Folders heading's icon (or a folder's ⋯). */
  const newFolderField = (): ReactNode =>
    addingFolder ? (
      <View style={styles.row}>
        <TextInput
          style={[styles.folderName, styles.newFolderInput]}
          value={newFolder}
          onChangeText={setNewFolder}
          placeholder={current ? `New folder in ${current.folder.name}` : 'New folder name'}
          autoFocus
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
    ) : null;

  /**
   * One folder level. The top level is Quick access, the folders, then All places — a
   * destination of its own rather than a toggle competing with the Folders heading — and
   * whatever is filed in no folder. Inside a folder: its subfolders, then what it holds.
   */
  const renderLevel = (): ReactNode => {
    const subfolders = (allTree.byParent.get(folderId) ?? []).map((node) => node.folder);
    const levelPlaces = current ? current.places : allTree.places;
    const levelTracks = current ? current.tracks : allTree.tracks;
    if (current) {
      return (
        <>
          {renderFolders(subfolders)}
          {newFolderField()}
          {current.children.length + levelPlaces.length + levelTracks.length === 0 ? (
            <Text style={styles.muted}>This folder is empty.</Text>
          ) : null}
          {renderPlaces(levelPlaces)}
          {renderTracks(levelTracks)}
        </>
      );
    }
    const nothingSaved = places.length === 0 && tracks.length === 0 && collections.length === 0;
    return (
      <>
        {quickAccess()}
        <View style={styles.sectionHead}>
          <Text style={styles.sectionTitle}>Folders</Text>
          <Pressable
            style={styles.headIcon}
            onPress={() => setAddingFolder(true)}
            hitSlop={6}
            accessibilityRole="button"
            accessibilityLabel="New folder"
            testID="folder-new"
          >
            <FolderPlusIcon color={theme.icon} />
          </Pressable>
        </View>
        {renderFolders(subfolders)}
        {newFolderField()}
        {nothingSaved ? (
          <Text style={styles.muted}>
            Nothing saved yet. Long-press the map to save a pin, import a GPX/KML/KMZ file — or sign
            in to sync what you saved on your other devices.
          </Text>
        ) : null}
        <Pressable
          style={styles.row}
          onPress={() => showView('places')}
          accessibilityRole="button"
          testID="collections-view-places"
        >
          <View style={styles.rowIcon}>
            <MapPinIcon color={theme.icon} />
          </View>
          <View style={styles.rowMain}>
            <Text style={styles.rowText}>All places</Text>
            <Text style={styles.muted}>
              {places.length} {places.length === 1 ? 'place' : 'places'}
            </Text>
          </View>
          <Text style={styles.chevronText}>›</Text>
        </Pressable>
        {levelPlaces.length + levelTracks.length > 0 ? (
          <Text style={styles.sectionLabel}>Not in a folder</Text>
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

  /**
   * Sport, year and sort, then one line saying how much of the list is on the map. Showing
   * or hiding the whole list is under Manage: the tab is for finding an activity, not for
   * running a map layer.
   */
  const libraryFilters = (): ReactNode => {
    const noun = view === 'activities' ? 'activities' : 'routes';
    if (viewSource.length === 0) return null;
    const ids = viewTracks.map((track) => track.id);
    const count = viewTracks.length;
    return (
      <View style={styles.libraryFilters}>
        <View style={styles.filterPills}>
          {sports.length > 1 ? (
            <FilterMenu
              label="Sport"
              allLabel="All sports"
              value={sport}
              options={sports.map((item) => ({
                key: item.sport,
                label: item.sport,
                count: item.count,
              }))}
              onChange={(next) => {
                setSport(next);
                setTrackLimit(TRACK_PAGE);
              }}
              testID="library-sport"
            />
          ) : null}
          {view === 'activities' && years.length > 1 ? (
            <FilterMenu
              label="Year"
              allLabel="All years"
              value={year}
              options={years.map((item) => ({
                key: item.year,
                label: String(item.year),
                count: item.count,
              }))}
              onChange={(next) => {
                setYear(next);
                setTrackLimit(TRACK_PAGE);
              }}
              testID="library-year"
            />
          ) : null}
          <FilterMenu
            label="Newest first"
            allLabel="Newest first"
            value={trackSort === 'newest' ? null : trackSort}
            options={[
              { key: 'oldest', label: 'Oldest first' },
              { key: 'name', label: 'Name' },
              { key: 'distance', label: 'Longest first' },
            ]}
            onChange={(value) => {
              setTrackSort(value ?? 'newest');
              scrollRef.current?.scrollTo({ y: 0, animated: false });
              setTrackLimit(TRACK_PAGE);
            }}
            testID="library-sort"
          />
        </View>
        <View style={[styles.summaryRow, styles.onMapRow]}>
          <LayersIcon color={theme.icon} size={20} />
          <Text style={styles.onMapText} numberOfLines={1} testID="library-on-map">
            On map · {onMap} of {count}
          </Text>
          {count > 0 ? (
            <Pressable
              onPress={() =>
                setMenu({
                  title: view === 'activities' ? 'Activities on the map' : 'Routes on the map',
                  actions: [
                    {
                      label: `Show all ${count} on map`,
                      onPress: () => onSetTracksVisible(ids, true),
                      testID: 'library-show-all',
                    },
                    {
                      label: `Hide all ${count} from map`,
                      onPress: () => onSetTracksVisible(ids, false),
                      testID: 'library-hide-all',
                    },
                    {
                      label: `Show only these ${count}, hide other tracks`,
                      onPress: () => onShowOnlyTracks(ids),
                      testID: 'library-show-only-matches',
                    },
                  ],
                })
              }
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel={`Manage which ${noun} are on the map`}
              testID="library-manage"
            >
              <Text style={styles.link}>Manage</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    );
  };

  /** What a library tab says when it has nothing to list, and where to get some. */
  const libraryEmpty = (): ReactNode => {
    if (view === 'places') {
      return filtered.active ? (
        <Text style={styles.muted}>No saved places match “{filter.trim()}”.</Text>
      ) : (
        <Text style={styles.muted}>
          No saved places yet. Long-press the map to save one, or import a GPX/KML file.
        </Text>
      );
    }
    if (viewSource.length > 0) {
      return <Text style={styles.muted}>Nothing matches these filters.</Text>;
    }
    const garminHint = garmin.connected
      ? 'Tap ↻ above to import them from Garmin.'
      : 'Connect Garmin in Settings → Garmin to bring them in, or import GPX files.';
    return (
      <View style={styles.emptyBlock}>
        <Text style={styles.muted}>
          {view === 'activities'
            ? `No activities yet. ${garminHint}`
            : garmin.connected
              ? 'No routes in Atlas yet. Save one from the route planner or import a GPX file; your Garmin courses are below.'
              : 'No routes yet. Save one from the route planner or import a GPX file.'}
        </Text>
        <Pressable
          style={styles.buttonQuiet}
          onPress={() => setImportOpen(true)}
          testID="library-empty-import"
        >
          <Text style={styles.link}>Import GPX / KML</Text>
        </Pressable>
        {view === 'courses' ? (
          <Pressable style={styles.buttonQuiet} onPress={onClose}>
            <Text style={styles.link}>Back to map to plan a route</Text>
          </Pressable>
        ) : null}
      </View>
    );
  };

  /**
   * Atop Activities, one line: what has come in from Garmin and a check for more. The
   * schedule and the history backfill are Settings → Garmin's to explain.
   */
  const garminActivitiesCard = (): ReactNode => {
    const newest = activities[0] ? activityDate(activities[0]) : null;
    const last = garmin.lastImport;
    return (
      <View style={styles.garminLine} testID="garmin-library">
        <View style={styles.rowMain}>
          <Text style={styles.muted} numberOfLines={2}>
            Garmin ·{' '}
            {activities.length > 0
              ? `${activities.length} imported${newest ? `, newest ${recordedLabel(newest)}` : ''}`
              : 'tap ↻ to import'}
            {garmin.lastActivityCheck ? ` · checked ${fmtCheckTime(garmin.lastActivityCheck)}` : ''}
            {activities.length > 0 && !garmin.historyComplete
              ? ' · older history still coming'
              : ''}
          </Text>
          {last ? (
            <Text style={styles.muted} testID="garmin-import-result">
              {last.imported > 0
                ? `Added ${last.imported} ${last.imported === 1 ? 'activity' : 'activities'}`
                : 'Nothing new'}
              {last.errors > 0 ? ` · ${last.errors} failed` : ''}
              {last.sorted > 0 ? ` · filed ${last.sorted} into sport folders` : ''}
            </Text>
          ) : null}
          {garmin.error ? <Text style={styles.error}>{garmin.error}</Text> : null}
        </View>
        <Pressable
          style={[styles.iconButton, garmin.busy && styles.buttonDisabled]}
          disabled={garmin.busy}
          onPress={() => void garmin.checkNewActivities()}
          hitSlop={8}
          accessibilityLabel="Check Garmin for new activities"
          testID="garmin-check-newest"
        >
          {garmin.busy ? (
            <ActivityIndicator size="small" color={theme.accent} />
          ) : (
            <Text style={styles.iconButtonText}>↻</Text>
          )}
        </Pressable>
      </View>
    );
  };

  /** Under Places: watch locations come in as a Garmin Explore GPX export. */
  const garminLocationsCard = (): ReactNode => {
    const locationPlaces = garminLocations
      ? places.filter((place) => place.collectionId === garminLocations.id)
      : [];
    return (
      <View style={styles.card}>
        <View style={styles.cardHead}>
          <Text style={styles.cardTitle}>Garmin saved locations</Text>
          {garminLocations ? (
            <Pressable
              onPress={() => {
                showView('folders');
                openFolder(garminLocations.id);
              }}
              hitSlop={10}
              testID="garmin-locations-open"
            >
              <Text style={styles.link}>Open folder ›</Text>
            </Pressable>
          ) : null}
        </View>
        <Text style={styles.muted}>
          {locationPlaces.length > 0 ? `${locationPlaces.length} in ${GARMIN_LOCATIONS}. ` : ''}
          Atlas can’t read watch locations from Garmin yet. Export them as GPX from Garmin Explore
          and import the file here.
        </Text>
        <View style={styles.buttonRow}>
          <Pressable
            style={[styles.button, styles.buttonQuiet]}
            onPress={() =>
              void onImport(
                garminLocations
                  ? { collectionId: garminLocations.id }
                  : { newCollection: { name: GARMIN_LOCATIONS } },
              )
            }
            testID="garmin-locations-import"
          >
            <Text style={styles.buttonQuietText}>Import GPX</Text>
          </Pressable>
        </View>
      </View>
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
          <ActionMenu
            title="Collections"
            testID="collections-more"
            actions={[
              {
                label: 'Import · Export',
                onPress: () => setImportOpen((open) => !open),
                testID: 'favorites-import',
              },
              {
                label: reordering ? 'Done reordering' : 'Reorder',
                onPress: () => {
                  setView('folders');
                  setReordering((value) => !value);
                },
                testID: 'collections-reorder',
              },
              {
                label: allShown ? 'Hide everything from map' : 'Show everything on map',
                onPress: () => onSetAllVisible(!allShown),
                testID: 'toggle-all-visible',
              },
            ]}
          />
          <Pressable
            style={styles.headerIcon}
            onPress={onClose}
            hitSlop={8}
            accessibilityLabel="Close Collections"
            testID="favorites-close"
          >
            <Text style={styles.close}>✕</Text>
          </Pressable>
        </View>
      </View>
      {importOpen ? (
        <View>
          <ImportControls
            folders={flatFolders}
            onImport={onImport}
            onImportInatur={onImportInatur}
          />
          {/* Also in Settings → Account & data. Two homes on purpose: web puts
              it on this header, and a user who learned it there should find it
              here (rule 5 is about the data, not about one route to it). */}
          <Pressable
            style={[styles.button, styles.buttonQuiet, styles.exportButton]}
            onPress={onExportAll}
            testID="favorites-export-all"
          >
            <Text style={styles.buttonQuietText}>Export everything (backup file)</Text>
          </Pressable>
        </View>
      ) : null}

      <View style={styles.tabBar} accessibilityRole="tablist">
        {(['folders', 'courses', 'activities'] as const).map((item) => {
          const on = view === item || (item === 'folders' && placesTab);
          return (
            <Pressable
              key={item}
              style={[styles.tab, on && styles.tabOn]}
              onPress={() => {
                showView(item);
                // Places opens at its top level: Quick access and the folders.
                if (item === 'folders') openFolder(null);
              }}
              accessibilityRole="tab"
              accessibilityState={{ selected: on }}
              testID={`collections-view-${item}`}
            >
              <Text style={[styles.tabText, on && styles.tabTextOn]} numberOfLines={1}>
                {item === 'folders' ? 'Places' : VIEW_LABELS[item]}
              </Text>
            </Pressable>
          );
        })}
      </View>
      {placesTab || viewSource.length > 0 ? (
        <View style={styles.filterRow}>
          <TextInput
            style={[styles.textField, styles.filterInput]}
            value={filter}
            onChangeText={(text) => {
              setFilter(text);
              setTrackLimit(TRACK_PAGE);
              setPlaceLimit(PLACE_PAGE);
            }}
            placeholder={
              placesTab ? 'Search saved places' : `Search ${VIEW_LABELS[view].toLocaleLowerCase()}`
            }
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
      ) : null}
      {reordering ? (
        <View style={styles.summaryRow}>
          <Text style={[styles.muted, styles.rowMain]}>
            Hold a row and drag it to reorder, or onto a folder to move it there.
          </Text>
          <Pressable onPress={() => setReordering(false)} testID="collections-reorder-done">
            <Text style={styles.link}>Done</Text>
          </Pressable>
        </View>
      ) : null}
      {view === 'courses' || view === 'activities' ? libraryFilters() : null}
      {view === 'folders' && !filtered.active && current ? folderHeader(current.folder) : null}
      {view === 'places' && !filtered.active ? (
        <View style={[styles.crumbRow, styles.folderHeader]}>
          <Pressable
            style={styles.backButton}
            onPress={() => showView('folders')}
            hitSlop={8}
            accessibilityLabel="Back to Places"
            testID="collections-places-back"
          >
            <Text style={styles.backText}>‹</Text>
          </Pressable>
          <Text style={[styles.rowText, styles.rowMain]}>All places</Text>
          <FilterMenu
            label="Name"
            allLabel="Name"
            value={placeSort === 'name' ? null : placeSort}
            options={[
              { key: 'recent', label: 'Recently added' },
              { key: 'folder', label: 'Folder' },
            ]}
            onChange={(value) => {
              setPlaceSort(value ?? 'name');
              scrollRef.current?.scrollTo({ y: 0, animated: false });
              setPlaceLimit(PLACE_PAGE);
            }}
            testID="places-sort"
          />
        </View>
      ) : null}

      <ScrollView
        ref={scrollRef}
        style={styles.scroll}
        scrollEnabled={!dragActive}
        keyboardShouldPersistTaps="handled"
        onScroll={(event) => {
          scrollY.current = event.nativeEvent.contentOffset.y;
        }}
        scrollEventThrottle={16}
        testID="collections-scroll"
      >
        {/* A filter that matched nothing is not an empty collection: saying
            "nothing saved yet" to someone whose pins are all still there reads
            as data loss. */}
        {placesTab && filtered.active && filtered.empty ? (
          <Text style={styles.muted}>Nothing here matches “{filter.trim()}”.</Text>
        ) : null}
        {view === 'activities' && garmin.connected ? garminActivitiesCard() : null}
        {placesTab
          ? filtered.active
            ? renderResults()
            : view === 'folders'
              ? renderLevel()
              : places.length > 0
                ? renderPlaces(libraryPlaces(places, collections, placeSort), true)
                : libraryEmpty()
          : viewTracks.length > 0
            ? renderTracks(viewTracks, true)
            : libraryEmpty()}
        {view === 'places' && garmin.connected ? garminLocationsCard() : null}
        {view === 'courses' && garmin.connected ? (
          <GarminCourses
            garmin={garmin}
            onReveal={onRevealGarminItem}
            onShowTrack={onShowGarminTrack}
            onEditRoute={onEditGarminCourse}
          />
        ) : null}
        <View style={styles.listFoot} />
      </ScrollView>
      <ActionSheet
        title={menu?.title ?? ''}
        actions={menu?.actions ?? null}
        onClose={() => setMenu(null)}
      />
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
  heading: { fontSize: 17, fontWeight: '700', color: theme.text },
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
  folderChipText: { fontSize: 13, color: theme.text },
  folderChipTextOn: { fontWeight: '700' },
  // Top-level views as a tab bar: equal widths, all five always on screen
  // (a scrolling pill row hid the last one, Garmin, past the edge).
  tabBar: {
    flexDirection: 'row',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.border,
    marginTop: 4,
    marginBottom: 8,
  },
  tab: {
    flex: 1,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
    paddingHorizontal: 2,
  },
  tabOn: { borderBottomColor: theme.accent },
  tabText: { fontSize: 14, color: theme.textMuted, fontWeight: '600' },
  tabTextOn: { color: theme.accent },
  libraryFilters: { marginTop: 8, marginBottom: 2 },
  filterPills: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  summaryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    marginTop: 8,
  },
  summaryText: { flexShrink: 1, fontSize: 13, color: theme.textMuted, fontWeight: '600' },
  link: { color: theme.accent, fontWeight: '600', fontSize: 14 },
  error: { fontSize: 13, color: theme.danger, marginTop: 6 },
  emptyBlock: { marginTop: 8, gap: 8, alignItems: 'flex-start' },
  emptyButton: { marginTop: 4 },
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
    borderRadius: 10,
    padding: 12,
    marginTop: 10,
    gap: 4,
  },
  cardHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  cardTitle: { fontSize: 15, fontWeight: '700', color: theme.text },
  cardActions: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  cardLink: { alignSelf: 'flex-start', paddingVertical: 6 },
  iconButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: theme.surfaceMuted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconButtonText: { fontSize: 20, lineHeight: 22, color: theme.accent, fontWeight: '700' },
  headerButton: {
    backgroundColor: theme.surfaceMuted,
    borderRadius: 8,
    paddingHorizontal: 12,
    minHeight: 36,
    justifyContent: 'center',
  },
  headerIcon: { minWidth: 36, minHeight: 36, alignItems: 'center', justifyContent: 'center' },
  exportButton: { marginTop: 8, alignItems: 'center' },
  newFolderButton: { paddingVertical: 12 },
  listFoot: { height: 24 },
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
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8 },
  rowRevealed: { backgroundColor: theme.accentFaint, borderRadius: 8 },
  // A row's tappable body: its pin or sport, then the text — the eye stays its own target.
  rowPress: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10 },
  rowIcon: { width: 34, alignItems: 'center', justifyContent: 'center' },
  eyeButton: { paddingHorizontal: 6, paddingVertical: 8 },
  sectionHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 16,
    marginBottom: 8,
  },
  sectionTitle: { fontSize: 16, fontWeight: '700', color: theme.text },
  headIcon: { minWidth: 36, minHeight: 36, alignItems: 'flex-end', justifyContent: 'center' },
  // Quick access: two compact tiles to a row, so six shortcuts take three rows at most.
  tileGrid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', rowGap: 8 },
  tile: { width: '48.5%', borderRadius: 14, backgroundColor: theme.surfaceMuted },
  // Top row: the place's own badge (as on its row) left, Directions right; the name
  // gets the tile's full width underneath instead of wrapping around the arrow.
  tileMain: { minHeight: 84, paddingHorizontal: 12, paddingTop: 10, paddingBottom: 12, gap: 8 },
  tileBadge: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tileBadgeMore: { backgroundColor: theme.surface },
  tileIcon: { fontSize: 16 },
  tileMoreIcon: { fontSize: 16, color: theme.text, fontWeight: '700' },
  tileName: { fontSize: 15, fontWeight: '600', color: theme.text },
  tileCorner: {
    position: 'absolute',
    top: 10,
    right: 10,
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.surface,
  },
  tileRemove: { fontSize: 16, color: theme.danger, fontWeight: '700' },
  onMapRow: { justifyContent: 'flex-start', marginTop: 12, marginBottom: 4 },
  onMapText: { flex: 1, fontSize: 15, color: theme.text, fontWeight: '600' },
  garminLine: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6 },
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
  buttonRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 6 },
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
});
