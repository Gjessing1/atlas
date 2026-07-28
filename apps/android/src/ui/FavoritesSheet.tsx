import { flattenCollectionTree, promoteParentId, useCollectionTree } from '@atlas/app-hooks';
import { trackSummary } from '@atlas/core';
import type {
  CollectionRecord,
  PlacePatch,
  PlaceRecord,
  TrackPatch,
  TrackRecord,
} from '@atlas/storage';
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { BottomSheet } from './BottomSheet';
import { flattenFolders } from './folders';
import { confirmDelete, ItemEditor } from './ItemEditor';
import { ReorderableList } from './ReorderableList';
import { theme } from './theme';

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
  onPatch,
  onDelete,
  onClose,
  bottomInset = 0,
}: {
  visible: boolean;
  place: PlaceRecord | null;
  collections: CollectionRecord[];
  onPatch: (id: string, patch: EditablePlacePatch) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
  bottomInset?: number;
}) {
  const folders = useMemo(() => flattenFolders(collections), [collections]);
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
 * Saved (places, tracks & folders) — the mobile counterpart of the web Sidebar:
 * browse everything saved (synced records from other devices appear here too),
 * organise it into folders, and control what's drawn on the map. Fly to,
 * navigate to, or edit a place (the ✎ button or the icon badge): rename it,
 * assign it to a folder, pick an icon/colour, or delete it. Tracks sit in the
 * same tree with the same editor (folder, notes, tags, export, delete) —
 * anything filed in a folder is visible *in* that folder. Folders can be
 * created, renamed, hidden (hiding their contents too) and deleted; a header
 * toggle shows or hides everything at once.
 */
export function FavoritesSheet({
  visible,
  onClose,
  places,
  tracks,
  collections,
  onFlyTo,
  onNavigate,
  onPatch,
  onDelete,
  onShowTrack,
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
  onReorderPlaces,
  onReorderCollections,
  bottomInset = 0,
}: {
  visible: boolean;
  onClose: () => void;
  places: PlaceRecord[];
  tracks: TrackRecord[];
  collections: CollectionRecord[];
  onFlyTo: (place: PlaceRecord) => void;
  onNavigate: (place: PlaceRecord) => void;
  /** Patch a place (the editor batches its fields behind an explicit Save). */
  onPatch: (id: string, patch: EditablePlacePatch) => void;
  onDelete: (id: string) => void;
  /** Frame a track on the map (the row's name, like web's track row). */
  onShowTrack: (track: TrackRecord) => void;
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
  /** Persist a drag arrangement (row ≡ handles) — ids in their new order. */
  onReorderPlaces: (orderedIds: string[]) => void;
  onReorderCollections: (orderedIds: string[]) => void;
  /** System nav-bar inset — keeps the Close button clear of it (edge-to-edge). */
  bottomInset?: number;
}) {
  // Which row's edit panel is currently open (the ✎ button or icon badge
  // toggles it). Keyed `place:<id>` / `track:<id>`, as on web — two record
  // kinds now share the list, and only one editor is ever open.
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [newFolder, setNewFolder] = useState('');
  // Folder the new-folder input creates into (a folder row's ＋ sets it; null = root).
  const [newFolderParent, setNewFolderParent] = useState<string | null>(null);
  // Folders whose contents are showing (the ▾/▸ chevron toggles them). Empty by
  // default: on a phone, expanding everything at once buries the folder list
  // itself under its contents. Kept in memory only — which folders are open is a
  // view preference, not user data.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const toggleExpanded = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  /** Open a folder so something created inside it isn't added out of sight. */
  const revealFolder = (id: string) =>
    setExpanded((current) => (current.has(id) ? current : new Set(current).add(id)));
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
      for (const id of folderRefs.current.keys()) measureFolder(id);
    }
  };

  // What a folder row's number means: everything filed directly in it. Counting
  // only places would report "0" for a folder holding nothing but tracks.
  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const item of [...places, ...tracks]) {
      if (item.collectionId) map.set(item.collectionId, (map.get(item.collectionId) ?? 0) + 1);
    }
    return map;
  }, [places, tracks]);

  // Folder tree — derived by the shared model, so web and Android agree on
  // nesting, ordering and what happens to a folder whose parent is missing.
  const tree = useCollectionTree({ collections, places, tracks });
  const flatFolders = useMemo(() => flattenCollectionTree(tree), [tree]);

  const allShown =
    places.every((p) => p.visible) &&
    tracks.every((t) => t.visible) &&
    collections.every((c) => c.visible);

  const addFolder = () => {
    const name = newFolder.trim();
    if (!name) return;
    onCreateFolder(name, newFolderParent);
    // A subfolder added into a collapsed parent would land out of sight and read
    // as "nothing happened", so opening the parent is part of creating into it.
    if (newFolderParent !== null) revealFolder(newFolderParent);
    setNewFolder('');
    setNewFolderParent(null);
  };

  const dropPlaceAtFolder = (place: PlaceRecord, pageY: number): boolean => {
    for (const [folderId, frame] of folderFrames.current) {
      if (pageY >= frame.top - 6 && pageY <= frame.bottom + 6) {
        if (place.collectionId !== folderId) onPatch(place.id, { collectionId: folderId });
        // Show where it went — dropping into a closed folder otherwise looks
        // like the place simply vanished from the list.
        revealFolder(folderId);
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
        <View style={[styles.row, place.visible ? null : styles.rowHidden]}>
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
        <View style={[styles.row, track.visible ? null : styles.rowHidden]}>
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
            <Text style={styles.muted}>{trackSummary(track.stats)}</Text>
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
            actions={
              <>
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

  const renderTracks = (collectionId: string | null, nested = false): ReactNode => {
    const level = collectionId === null ? tree.tracks : (tree.byId.get(collectionId)?.tracks ?? []);
    if (level.length === 0) return null;
    return <View style={nested ? styles.subLevel : undefined}>{level.map(trackRow)}</View>;
  };

  const renderPlaces = (collectionId: string | null, nested = false): ReactNode => {
    const level = collectionId === null ? tree.places : (tree.byId.get(collectionId)?.places ?? []);
    if (level.length === 0) return null;
    return (
      <View style={nested ? styles.subLevel : undefined}>
        <ReorderableList
          items={level}
          keyOf={(place) => place.id}
          onReorder={onReorderPlaces}
          onDragActive={onDragActive}
          onDropAt={dropPlaceAtFolder}
          renderRow={placeRow}
        />
      </View>
    );
  };

  /** One nesting level of the folder tree: siblings reorder among themselves,
      each row followed by its (indented) subtree so a drag carries it along. */
  const renderFolderLevel = (parentId: string | null, depth: number): ReactNode => {
    const level = (tree.byParent.get(parentId) ?? []).map((node) => node.folder);
    if (level.length === 0) return null;
    return (
      <View style={depth > 0 ? styles.subLevel : undefined}>
        <ReorderableList
          items={level}
          keyOf={(folder) => folder.id}
          onReorder={onReorderCollections}
          onDragActive={onDragActive}
          renderRow={(folder, handle) => (
            <View>
              <View
                ref={(node) => {
                  if (node) folderRefs.current.set(folder.id, node);
                  else folderRefs.current.delete(folder.id);
                }}
                onLayout={() => measureFolder(folder.id)}
                style={[styles.row, folder.visible ? null : styles.rowHidden]}
                testID={`folder-row-${folder.id}`}
              >
                {handle}
                {/* Chevron and folder icon are one target: the name beside them
                    is an inline rename field, so tapping *it* has to keep
                    meaning "rename" — this is the widest tap area that can open
                    a folder without stealing that. */}
                <Pressable
                  style={styles.chevronButton}
                  onPress={() => toggleExpanded(folder.id)}
                  accessibilityLabel={`${expanded.has(folder.id) ? 'Collapse' : 'Expand'} ${folder.name}`}
                  testID={`folder-collapse-${folder.id}`}
                >
                  <Text style={styles.chevronText}>{expanded.has(folder.id) ? '▾' : '▸'}</Text>
                </Pressable>
                <Pressable
                  onPress={() => toggleExpanded(folder.id)}
                  accessibilityLabel={`${expanded.has(folder.id) ? 'Collapse' : 'Expand'} ${folder.name}`}
                  testID={`folder-icon-${folder.id}`}
                >
                  <Text style={styles.folderIcon}>{expanded.has(folder.id) ? '📂' : '📁'}</Text>
                </Pressable>
                <TextInput
                  style={styles.folderName}
                  defaultValue={folder.name}
                  onEndEditing={(e) => {
                    const value = e.nativeEvent.text.trim();
                    if (value && value !== folder.name) onRenameFolder(folder.id, value);
                  }}
                  returnKeyType="done"
                  testID={`folder-name-${folder.id}`}
                />
                <Text style={styles.muted}>{counts.get(folder.id) ?? 0}</Text>
                {folder.parentId !== null ? (
                  <Pressable
                    style={styles.eyeButton}
                    onPress={() => onMoveFolder(folder.id, promoteParentId(collections, folder))}
                    accessibilityLabel={`Move ${folder.name} up one level`}
                    testID={`folder-up-${folder.id}`}
                  >
                    <Text style={styles.subButtonText}>↑</Text>
                  </Pressable>
                ) : null}
                <Pressable
                  style={styles.eyeButton}
                  onPress={() => setNewFolderParent((id) => (id === folder.id ? null : folder.id))}
                  testID={`folder-sub-${folder.id}`}
                >
                  <Text style={styles.subButtonText}>＋</Text>
                </Pressable>
                {/* The eye sits just left of the actions on folder and place rows alike. */}
                <Pressable
                  style={styles.eyeButton}
                  onPress={() => onSetFolderVisible(folder.id, !folder.visible)}
                  testID={`folder-visible-${folder.id}`}
                >
                  <EyeIcon off={!folder.visible} />
                </Pressable>
                <Pressable
                  style={[styles.button, styles.buttonQuiet]}
                  onPress={() =>
                    confirmDelete(
                      `Delete folder “${folder.name}”?`,
                      'Places, tracks and subfolders inside it move up one level.',
                      () => onDeleteFolder(folder.id),
                    )
                  }
                  testID={`folder-delete-${folder.id}`}
                >
                  <Text style={styles.buttonQuietText}>Delete</Text>
                </Pressable>
              </View>
              {expanded.has(folder.id) ? (
                <>
                  {renderPlaces(folder.id, true)}
                  {renderTracks(folder.id, true)}
                  {renderFolderLevel(folder.id, depth + 1)}
                </>
              ) : null}
            </View>
          )}
        />
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

      <ScrollView style={styles.scroll} scrollEnabled={!dragActive}>
        {/* Folders (nested — a folder row's ＋ targets the new-folder input at it) */}
        <Text style={styles.sectionLabel}>Folders</Text>
        {renderFolderLevel(null, 0)}
        <View style={styles.row}>
          <TextInput
            style={[styles.folderName, styles.newFolderInput]}
            value={newFolder}
            onChangeText={setNewFolder}
            placeholder={
              newFolderParent
                ? `New subfolder in ${collections.find((c) => c.id === newFolderParent)?.name ?? 'folder'}…`
                : 'New folder…'
            }
            returnKeyType="done"
            onSubmitEditing={addFolder}
            testID="folder-new-name"
          />
          {newFolderParent ? (
            <Pressable
              style={[styles.button, styles.buttonQuiet]}
              onPress={() => setNewFolderParent(null)}
              testID="folder-new-parent-clear"
            >
              <Text style={styles.buttonQuietText}>Root</Text>
            </Pressable>
          ) : null}
          <Pressable
            style={[styles.button, newFolder.trim() ? null : styles.buttonDisabled]}
            disabled={!newFolder.trim()}
            onPress={addFolder}
            testID="folder-add"
          >
            <Text style={styles.buttonText}>Add</Text>
          </Pressable>
        </View>

        {/* Unfiled places and tracks stay at the root; anything in a folder is
            rendered immediately below its folder row above. */}
        <Text style={styles.sectionLabel}>Not in a folder</Text>
        {places.length === 0 && tracks.length === 0 ? (
          <Text style={styles.muted}>
            Nothing saved yet. Long-press the map to save a pin, import a GPX/KML/KMZ file — or sign
            in to sync what you saved on your other devices.
          </Text>
        ) : (
          <>
            {renderPlaces(null)}
            {renderTracks(null)}
          </>
        )}
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
    marginBottom: 6,
  },
  heading: { fontSize: 15, fontWeight: '700', color: theme.text },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 6 },
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
  rowHidden: { opacity: 0.45 },
  eyeButton: { paddingHorizontal: 2, paddingVertical: 4 },
  subButtonText: { fontSize: 16, color: theme.textMuted, fontWeight: '700' },
  subLevel: { paddingLeft: 18 },
  folderIcon: { fontSize: 18 },
  // Fixed width so folder names line up whether open or collapsed.
  chevronButton: { width: 22, paddingVertical: 6, alignItems: 'center' },
  chevronText: { fontSize: 12, color: theme.textMuted },
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
  closeButton: { marginTop: 14, alignSelf: 'stretch', alignItems: 'center' },
});
