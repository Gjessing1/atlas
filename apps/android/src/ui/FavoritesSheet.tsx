import { flattenCollectionTree, promoteParentId, useCollectionTree } from '@atlas/app-hooks';
import { PLACE_COLORS, PLACE_ICONS } from '@atlas/core';
import type { CollectionRecord, PlacePatch, PlaceRecord } from '@atlas/storage';
import { useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Alert,
  Keyboard,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { BottomSheet } from './BottomSheet';
import { flattenFolders } from './folders';
import { ReorderableList } from './ReorderableList';
import { theme } from './theme';

export type EditablePlacePatch = Pick<
  PlacePatch,
  'name' | 'icon' | 'color' | 'notes' | 'tags' | 'visible' | 'collectionId'
>;

/**
 * Ask before a delete. The undo toast catches mistakes afterwards, but these
 * buttons sit in dense rows where a mis-tap is easy — cheaper to ask first.
 */
function confirmDelete(title: string, message: string, onConfirm: () => void): void {
  Alert.alert(title, message, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Delete', style: 'destructive', onPress: onConfirm },
  ]);
}

/** Controlled place editor: changes land together when Save is tapped. */
function PlaceEditor({
  place,
  folders,
  onSave,
  onDelete,
  onClose,
  inset = false,
}: {
  place: PlaceRecord;
  folders: { folder: CollectionRecord; depth: number }[];
  onSave: (patch: EditablePlacePatch) => void;
  onDelete: () => void;
  onClose: () => void;
  inset?: boolean;
}) {
  const [name, setName] = useState(place.name);
  const [icon, setIcon] = useState(place.icon);
  const [color, setColor] = useState(place.color);
  const [collectionId, setCollectionId] = useState(place.collectionId);
  const [notes, setNotes] = useState(place.notes);
  const [tags, setTags] = useState(place.tags.join(', '));

  const save = () => {
    const trimmedName = name.trim();
    if (!trimmedName) return;
    Keyboard.dismiss();
    onSave({
      name: trimmedName,
      icon,
      color,
      collectionId,
      notes,
      tags: tags
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean),
    });
    onClose();
  };

  return (
    <View style={[styles.picker, inset && styles.pickerInset]}>
      <View style={styles.field}>
        <Text style={styles.fieldLabel}>Name</Text>
        <TextInput
          style={styles.nameInput}
          value={name}
          onChangeText={setName}
          placeholder="Place name"
          returnKeyType="done"
          accessibilityLabel="Name"
          testID={`favorite-name-${place.id}`}
        />
      </View>
      <Text style={styles.fieldLabel}>Icon</Text>
      <View style={styles.choiceRow}>
        {PLACE_ICONS.map((candidate) => (
          <Pressable
            key={candidate}
            style={[styles.iconChoice, candidate === icon && styles.choiceSelected]}
            onPress={() => setIcon(candidate)}
            testID={`favorite-icon-${place.id}-${candidate}`}
          >
            <Text style={styles.iconChoiceText}>{candidate}</Text>
          </Pressable>
        ))}
      </View>
      <Text style={styles.fieldLabel}>Colour</Text>
      <View style={styles.choiceRow}>
        {PLACE_COLORS.map((candidate) => (
          <Pressable
            key={candidate}
            style={[
              styles.colorChoice,
              { backgroundColor: candidate },
              candidate === color && styles.colorChoiceSelected,
            ]}
            onPress={() => setColor(candidate)}
            testID={`favorite-color-${place.id}-${candidate}`}
          />
        ))}
      </View>
      <Text style={styles.fieldLabel}>Folder</Text>
      <View style={styles.choiceRow}>
        <Pressable
          style={[styles.folderChip, collectionId === null && styles.folderChipSelected]}
          onPress={() => setCollectionId(null)}
          testID={`favorite-folder-${place.id}-none`}
        >
          <Text style={styles.folderChipText}>No folder</Text>
        </Pressable>
        {folders.map(({ folder, depth }) => (
          <Pressable
            key={folder.id}
            style={[styles.folderChip, collectionId === folder.id && styles.folderChipSelected]}
            onPress={() => setCollectionId(folder.id)}
            testID={`favorite-folder-${place.id}-${folder.id}`}
          >
            <Text style={styles.folderChipText}>
              {depth > 0 ? '└ ' : ''}📁 {folder.name}
            </Text>
          </Pressable>
        ))}
      </View>
      <View style={styles.field}>
        <Text style={styles.fieldLabel}>Notes</Text>
        <TextInput
          style={[styles.nameInput, styles.notesInput]}
          value={notes}
          onChangeText={setNotes}
          placeholder="Add details about this place"
          multiline
          accessibilityLabel="Notes"
          testID={`favorite-notes-${place.id}`}
        />
      </View>
      <View style={styles.field}>
        <Text style={styles.fieldLabel}>Tags</Text>
        <TextInput
          style={styles.nameInput}
          value={tags}
          onChangeText={setTags}
          placeholder="hike, family, todo"
          returnKeyType="done"
          accessibilityLabel="Tags"
          testID={`favorite-tags-${place.id}`}
        />
      </View>
      <View style={styles.editorActions}>
        <Pressable
          style={[styles.button, !name.trim() && styles.buttonDisabled]}
          disabled={!name.trim()}
          onPress={save}
          testID={`favorite-save-${place.id}`}
        >
          <Text style={styles.buttonText}>Save</Text>
        </Pressable>
        <Pressable
          style={[styles.button, styles.buttonDanger]}
          onPress={() => {
            Keyboard.dismiss();
            confirmDelete(`Delete “${place.name}”?`, 'You can undo this right after.', () => {
              onClose();
              onDelete();
            });
          }}
          testID={`favorite-delete-${place.id}`}
        >
          <Text style={styles.buttonText}>Delete place</Text>
        </Pressable>
      </View>
    </View>
  );
}

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
        <PlaceEditor
          key={place.id}
          place={place}
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
 * Saved (places & folders) — the mobile counterpart of the web Sidebar: browse saved
 * pins (synced ones from other devices appear here too), organise them into
 * folders, and control what's drawn on the map. Fly to, navigate to, or edit a
 * place (the ✎ button or the icon badge): rename it, assign it to a folder,
 * pick an icon/colour, or delete it. Folders can be created, renamed, hidden
 * (hiding their places too) and deleted; a header toggle shows or hides
 * everything at once.
 */
export function FavoritesSheet({
  visible,
  onClose,
  places,
  collections,
  onFlyTo,
  onNavigate,
  onPatch,
  onDelete,
  onCreateFolder,
  onRenameFolder,
  onMoveFolder,
  onSetFolderVisible,
  onDeleteFolder,
  onSetAllVisible,
  onReorderPlaces,
  onReorderCollections,
  bottomInset = 0,
}: {
  visible: boolean;
  onClose: () => void;
  places: PlaceRecord[];
  collections: CollectionRecord[];
  onFlyTo: (place: PlaceRecord) => void;
  onNavigate: (place: PlaceRecord) => void;
  /** Patch a place (the editor batches its fields behind an explicit Save). */
  onPatch: (id: string, patch: EditablePlacePatch) => void;
  onDelete: (id: string) => void;
  /** Create a folder — at the root, or nested under `parentId` (subfolder). */
  onCreateFolder: (name: string, parentId: string | null) => void;
  onRenameFolder: (id: string, name: string) => void;
  /** Re-parent a collection; the row action moves it up exactly one level. */
  onMoveFolder: (id: string, parentId: string | null) => void;
  onSetFolderVisible: (id: string, visible: boolean) => void;
  onDeleteFolder: (id: string) => void;
  /** Show or hide every place and folder at once (header toggle). */
  onSetAllVisible: (visible: boolean) => void;
  /** Persist a drag arrangement (row ≡ handles) — ids in their new order. */
  onReorderPlaces: (orderedIds: string[]) => void;
  onReorderCollections: (orderedIds: string[]) => void;
  /** System nav-bar inset — keeps the Close button clear of it (edge-to-edge). */
  bottomInset?: number;
}) {
  // Which row's edit panel is currently open (the ✎ button or icon badge toggles it).
  const [editingId, setEditingId] = useState<string | null>(null);
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
      setEditingId(null);
      for (const id of folderRefs.current.keys()) measureFolder(id);
    }
  };

  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const p of places) {
      if (p.collectionId) map.set(p.collectionId, (map.get(p.collectionId) ?? 0) + 1);
    }
    return map;
  }, [places]);

  // Folder tree — derived by the shared model, so web and Android agree on
  // nesting, ordering and what happens to a folder whose parent is missing.
  const tree = useCollectionTree({ collections, places });
  const flatFolders = useMemo(() => flattenCollectionTree(tree), [tree]);

  const allShown = places.every((p) => p.visible) && collections.every((c) => c.visible);

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

  const placeRow = (place: PlaceRecord, handle: ReactNode): ReactNode => (
    <View>
      <View style={[styles.row, place.visible ? null : styles.rowHidden]}>
        {handle}
        <Pressable
          style={[styles.badge, { backgroundColor: place.color }]}
          onPress={() => setEditingId((id) => (id === place.id ? null : place.id))}
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
            {place.lat.toFixed(4)}, {place.lng.toFixed(4)}
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
          onPress={() => setEditingId((id) => (id === place.id ? null : place.id))}
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
      {editingId === place.id ? (
        <PlaceEditor
          place={place}
          folders={flatFolders}
          onSave={(patch) => onPatch(place.id, patch)}
          onDelete={() => onDelete(place.id)}
          onClose={() => setEditingId(null)}
          inset
        />
      ) : null}
    </View>
  );

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
        {places.length > 0 || collections.length > 0 ? (
          <Pressable
            style={[styles.button, styles.buttonQuiet]}
            onPress={() => onSetAllVisible(!allShown)}
            testID="toggle-all-visible"
          >
            <Text style={styles.buttonQuietText}>{allShown ? 'Hide all' : 'Show all'}</Text>
          </Pressable>
        ) : null}
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

        {/* Root places stay at the root; foldered places are rendered
            immediately below their respective folder rows above. */}
        <Text style={styles.sectionLabel}>Places without a folder</Text>
        {places.length === 0 ? (
          <Text style={styles.muted}>
            No saved places yet. Long-press the map to save a pin — or sign in to sync the favorites
            from your other devices.
          </Text>
        ) : (
          renderPlaces(null)
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
  buttonDanger: { backgroundColor: theme.danger, alignSelf: 'flex-start' },
  picker: {
    paddingBottom: 10,
    gap: 8,
  },
  pickerInset: { paddingLeft: 42 },
  field: { gap: 5 },
  fieldLabel: { fontSize: 12, fontWeight: '700', color: theme.textMuted },
  nameInput: {
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 15,
    color: theme.text,
  },
  notesInput: { minHeight: 60, textAlignVertical: 'top' },
  choiceRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  iconChoice: {
    width: 38,
    height: 38,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.surfaceMuted,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  iconChoiceText: { fontSize: 18 },
  colorChoice: {
    width: 30,
    height: 30,
    borderRadius: 15,
    borderWidth: 3,
    borderColor: 'transparent',
  },
  colorChoiceSelected: { borderColor: theme.text },
  choiceSelected: { borderColor: theme.accent },
  folderChip: {
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: theme.surfaceMuted,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  folderChipSelected: { borderColor: theme.accent, backgroundColor: theme.surfaceActive },
  folderChipText: { fontSize: 13, color: theme.text, fontWeight: '600' },
  editorActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  closeButton: { marginTop: 14, alignSelf: 'stretch', alignItems: 'center' },
});
