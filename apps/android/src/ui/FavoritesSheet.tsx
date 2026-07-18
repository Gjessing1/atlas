import { PLACE_COLORS, PLACE_ICONS } from '@atlas/core';
import type { CollectionRecord, PlacePatch, PlaceRecord } from '@atlas/storage';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { ReorderableList } from './ReorderableList';

/** Folders flattened depth-first, with their nesting depth (for indented lists). */
function flattenFolders(
  collections: CollectionRecord[],
): { folder: CollectionRecord; depth: number }[] {
  const byParent = new Map<string | null, CollectionRecord[]>();
  for (const c of collections) {
    const key = c.parentId && collections.some((p) => p.id === c.parentId) ? c.parentId : null;
    const list = byParent.get(key) ?? [];
    list.push(c);
    byParent.set(key, list);
  }
  const out: { folder: CollectionRecord; depth: number }[] = [];
  const walk = (parentId: string | null, depth: number) => {
    for (const folder of byParent.get(parentId) ?? []) {
      out.push({ folder, depth });
      walk(folder.id, depth + 1);
    }
  };
  walk(null, 0);
  // Defensive: folders stranded by a cyclic parent chain still get listed.
  for (const c of collections) {
    if (!out.some((f) => f.folder.id === c.id)) out.push({ folder: c, depth: 0 });
  }
  return out;
}

/**
 * A drawn eye / crossed-out eye for the visibility toggles (an emoji eye reads
 * as alarming and renders inconsistently across Android skins).
 */
export function EyeIcon({ off = false }: { off?: boolean }) {
  const color = off ? '#a5adba' : '#4a5568';
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
    backgroundColor: '#a5adba',
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
  onSetFolderVisible,
  onDeleteFolder,
  onSetAllVisible,
  onReorderPlaces,
  onReorderCollections,
  editId = null,
  bottomInset = 0,
}: {
  visible: boolean;
  onClose: () => void;
  places: PlaceRecord[];
  collections: CollectionRecord[];
  onFlyTo: (place: PlaceRecord) => void;
  onNavigate: (place: PlaceRecord) => void;
  /** Patch a place (name/icon/colour/notes/tags/visibility/folder) — auto-saved + synced, same as web. */
  onPatch: (
    id: string,
    patch: Pick<
      PlacePatch,
      'name' | 'icon' | 'color' | 'notes' | 'tags' | 'visible' | 'collectionId'
    >,
  ) => void;
  onDelete: (id: string) => void;
  /** Create a folder — at the root, or nested under `parentId` (subfolder). */
  onCreateFolder: (name: string, parentId: string | null) => void;
  onRenameFolder: (id: string, name: string) => void;
  onSetFolderVisible: (id: string, visible: boolean) => void;
  onDeleteFolder: (id: string) => void;
  /** Show or hide every place and folder at once (header toggle). */
  onSetAllVisible: (visible: boolean) => void;
  /** Persist a drag arrangement (row ≡ handles) — ids in their new order. */
  onReorderPlaces: (orderedIds: string[]) => void;
  onReorderCollections: (orderedIds: string[]) => void;
  /** Open with this place's edit panel expanded (map pin → "Edit"). */
  editId?: string | null;
  /** System nav-bar inset — keeps the Close button clear of it (edge-to-edge). */
  bottomInset?: number;
}) {
  // Which row's edit panel is currently open (the ✎ button or icon badge toggles it).
  const [editingId, setEditingId] = useState<string | null>(null);
  const [newFolder, setNewFolder] = useState('');
  // Folder the new-folder input creates into (a folder row's ＋ sets it; null = root).
  const [newFolderParent, setNewFolderParent] = useState<string | null>(null);
  // A row is being dragged: freeze the sheet's scroll and close any editor so
  // row heights are uniform while the drag measures its way through the list.
  const [dragActive, setDragActive] = useState(false);
  const onDragActive = (active: boolean) => {
    setDragActive(active);
    if (active) setEditingId(null);
  };

  // Jump straight to a place's edit panel when the sheet is opened for it.
  useEffect(() => {
    if (visible && editId) setEditingId(editId);
  }, [visible, editId]);

  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const p of places) {
      if (p.collectionId) map.set(p.collectionId, (map.get(p.collectionId) ?? 0) + 1);
    }
    return map;
  }, [places]);

  // Folder tree (folders nest via parentId; dangling parents count as roots).
  const flatFolders = useMemo(() => flattenFolders(collections), [collections]);
  const childrenOf = useMemo(() => {
    const map = new Map<string | null, CollectionRecord[]>();
    for (const { folder, depth } of flatFolders) {
      const key = depth === 0 ? null : folder.parentId;
      const list = map.get(key) ?? [];
      list.push(folder);
      map.set(key, list);
    }
    return map;
  }, [flatFolders]);

  const allShown = places.every((p) => p.visible) && collections.every((c) => c.visible);

  const addFolder = () => {
    const name = newFolder.trim();
    if (!name) return;
    onCreateFolder(name, newFolderParent);
    setNewFolder('');
    setNewFolderParent(null);
  };

  /** One nesting level of the folder tree: siblings reorder among themselves,
      each row followed by its (indented) subtree so a drag carries it along. */
  const renderFolderLevel = (parentId: string | null, depth: number): ReactNode => {
    const level = childrenOf.get(parentId) ?? [];
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
              <View style={[styles.row, folder.visible ? null : styles.rowHidden]}>
                {handle}
                <Text style={styles.folderIcon}>📁</Text>
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
                  onPress={() => onDeleteFolder(folder.id)}
                  testID={`folder-delete-${folder.id}`}
                >
                  <Text style={styles.buttonQuietText}>Delete</Text>
                </Pressable>
              </View>
              {renderFolderLevel(folder.id, depth + 1)}
            </View>
          )}
        />
      </View>
    );
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={[styles.sheet, { paddingBottom: bottomInset + 20 }]}>
          <View style={styles.headerRow}>
            <Text style={styles.heading}>Saved</Text>
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

          <ScrollView scrollEnabled={!dragActive}>
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

            {/* Places */}
            <Text style={styles.sectionLabel}>Places</Text>
            {places.length === 0 ? (
              <Text style={styles.muted}>
                No saved places yet. Long-press the map to save a pin — or sign in to sync the
                favorites from your other devices.
              </Text>
            ) : (
              <ReorderableList
                items={places}
                keyOf={(place) => place.id}
                onReorder={onReorderPlaces}
                onDragActive={onDragActive}
                renderRow={(place, handle) => (
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
                      <View style={styles.picker}>
                        <TextInput
                          style={styles.nameInput}
                          defaultValue={place.name}
                          placeholder="Name"
                          // Commit when editing ends (like the web name field's
                          // blur): rename only when non-empty and actually changed.
                          onEndEditing={(e) => {
                            const value = e.nativeEvent.text.trim();
                            if (value && value !== place.name) onPatch(place.id, { name: value });
                          }}
                          returnKeyType="done"
                          testID={`favorite-name-${place.id}`}
                        />
                        <View style={styles.choiceRow}>
                          {PLACE_ICONS.map((ic) => (
                            <Pressable
                              key={ic}
                              style={[
                                styles.iconChoice,
                                ic === place.icon && styles.choiceSelected,
                              ]}
                              onPress={() => onPatch(place.id, { icon: ic })}
                              testID={`favorite-icon-${place.id}-${ic}`}
                            >
                              <Text style={styles.iconChoiceText}>{ic}</Text>
                            </Pressable>
                          ))}
                        </View>
                        <View style={styles.choiceRow}>
                          {PLACE_COLORS.map((c) => (
                            <Pressable
                              key={c}
                              style={[
                                styles.colorChoice,
                                { backgroundColor: c },
                                c === place.color && styles.colorChoiceSelected,
                              ]}
                              onPress={() => onPatch(place.id, { color: c })}
                              testID={`favorite-color-${place.id}-${c}`}
                            />
                          ))}
                        </View>
                        {/* Folder assignment — parity with the web place folder picker
                            (depth-first order, subfolders marked with └). */}
                        <View style={styles.choiceRow}>
                          <Pressable
                            style={[
                              styles.folderChip,
                              place.collectionId === null && styles.folderChipSelected,
                            ]}
                            onPress={() => onPatch(place.id, { collectionId: null })}
                            testID={`favorite-folder-${place.id}-none`}
                          >
                            <Text style={styles.folderChipText}>No folder</Text>
                          </Pressable>
                          {flatFolders.map(({ folder, depth }) => (
                            <Pressable
                              key={folder.id}
                              style={[
                                styles.folderChip,
                                place.collectionId === folder.id && styles.folderChipSelected,
                              ]}
                              onPress={() => onPatch(place.id, { collectionId: folder.id })}
                              testID={`favorite-folder-${place.id}-${folder.id}`}
                            >
                              <Text style={styles.folderChipText}>
                                {depth > 0 ? '└ ' : ''}📁 {folder.name}
                              </Text>
                            </Pressable>
                          ))}
                        </View>
                        {/* Notes + tags — storage and sync carry both (web parity). */}
                        <TextInput
                          style={[styles.nameInput, styles.notesInput]}
                          defaultValue={place.notes}
                          placeholder="Notes"
                          multiline
                          onEndEditing={(e) => {
                            const value = e.nativeEvent.text;
                            if (value !== place.notes) onPatch(place.id, { notes: value });
                          }}
                          testID={`favorite-notes-${place.id}`}
                        />
                        <TextInput
                          style={styles.nameInput}
                          defaultValue={place.tags.join(', ')}
                          placeholder="Tags: hike, family, todo"
                          onEndEditing={(e) => {
                            const next = e.nativeEvent.text
                              .split(',')
                              .map((t) => t.trim())
                              .filter(Boolean);
                            if (next.join('\n') !== place.tags.join('\n'))
                              onPatch(place.id, { tags: next });
                          }}
                          returnKeyType="done"
                          testID={`favorite-tags-${place.id}`}
                        />
                        <Pressable
                          style={[styles.button, styles.buttonDanger]}
                          onPress={() => {
                            setEditingId(null);
                            onDelete(place.id);
                          }}
                          testID={`favorite-delete-${place.id}`}
                        >
                          <Text style={styles.buttonText}>Delete place</Text>
                        </Pressable>
                      </View>
                    ) : null}
                  </View>
                )}
              />
            )}
          </ScrollView>
          <Pressable
            style={[styles.button, styles.closeButton]}
            onPress={onClose}
            testID="favorites-close"
          >
            <Text style={styles.buttonText}>Close</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: 20,
    maxHeight: '85%',
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  heading: { fontSize: 15, fontWeight: '700', color: '#334' },
  sectionLabel: { fontSize: 12, fontWeight: '700', color: '#889', marginTop: 14, marginBottom: 4 },
  muted: { fontSize: 13, color: '#778', marginTop: 2 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8 },
  rowHidden: { opacity: 0.45 },
  eyeButton: { paddingHorizontal: 2, paddingVertical: 4 },
  subButtonText: { fontSize: 16, color: '#4a5568', fontWeight: '700' },
  subLevel: { paddingLeft: 18 },
  folderIcon: { fontSize: 18 },
  folderName: {
    flexGrow: 1,
    flexShrink: 1,
    fontSize: 16,
    color: '#111',
    paddingVertical: 4,
  },
  newFolderInput: {
    borderWidth: 1,
    borderColor: '#cdd3dd',
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
  rowText: { fontSize: 16, color: '#111' },
  button: {
    backgroundColor: '#1a73e8',
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  buttonDisabled: { opacity: 0.5 },
  buttonText: { color: '#fff', fontWeight: '600' },
  buttonQuiet: { backgroundColor: '#eef1f6' },
  buttonQuietText: { color: '#334', fontWeight: '600' },
  buttonDanger: { backgroundColor: '#b3261e', alignSelf: 'flex-start' },
  picker: {
    paddingBottom: 10,
    paddingLeft: 42,
    gap: 8,
  },
  nameInput: {
    borderWidth: 1,
    borderColor: '#cdd3dd',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 15,
    color: '#111',
  },
  notesInput: { minHeight: 60, textAlignVertical: 'top' },
  choiceRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  iconChoice: {
    width: 38,
    height: 38,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#f1f3f7',
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
  colorChoiceSelected: { borderColor: '#111' },
  choiceSelected: { borderColor: '#1a73e8' },
  folderChip: {
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: '#f1f3f7',
    borderWidth: 2,
    borderColor: 'transparent',
  },
  folderChipSelected: { borderColor: '#1a73e8', backgroundColor: '#e7effd' },
  folderChipText: { fontSize: 13, color: '#334', fontWeight: '600' },
  closeButton: { marginTop: 14, alignSelf: 'stretch', alignItems: 'center' },
});
