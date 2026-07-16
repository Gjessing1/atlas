import { PLACE_COLORS, PLACE_ICONS } from '@atlas/core';
import type { CollectionRecord, PlacePatch, PlaceRecord } from '@atlas/storage';
import { useEffect, useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

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
 * Places & folders — the mobile counterpart of the web Sidebar: browse saved
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
  editId = null,
  bottomInset = 0,
}: {
  visible: boolean;
  onClose: () => void;
  places: PlaceRecord[];
  collections: CollectionRecord[];
  onFlyTo: (place: PlaceRecord) => void;
  onNavigate: (place: PlaceRecord) => void;
  /** Patch a place (name/icon/colour/visibility/folder) — auto-saved + synced, same as web. */
  onPatch: (
    id: string,
    patch: Pick<PlacePatch, 'name' | 'icon' | 'color' | 'visible' | 'collectionId'>,
  ) => void;
  onDelete: (id: string) => void;
  onCreateFolder: (name: string) => void;
  onRenameFolder: (id: string, name: string) => void;
  onSetFolderVisible: (id: string, visible: boolean) => void;
  onDeleteFolder: (id: string) => void;
  /** Show or hide every place and folder at once (header toggle). */
  onSetAllVisible: (visible: boolean) => void;
  /** Open with this place's edit panel expanded (map pin → "Edit"). */
  editId?: string | null;
  /** System nav-bar inset — keeps the Close button clear of it (edge-to-edge). */
  bottomInset?: number;
}) {
  // Which row's edit panel is currently open (the ✎ button or icon badge toggles it).
  const [editingId, setEditingId] = useState<string | null>(null);
  const [newFolder, setNewFolder] = useState('');

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

  const allShown = places.every((p) => p.visible) && collections.every((c) => c.visible);

  const addFolder = () => {
    const name = newFolder.trim();
    if (!name) return;
    onCreateFolder(name);
    setNewFolder('');
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={[styles.sheet, { paddingBottom: bottomInset + 20 }]}>
          <View style={styles.headerRow}>
            <Text style={styles.heading}>Places &amp; folders</Text>
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

          <ScrollView>
            {/* Folders */}
            <Text style={styles.sectionLabel}>Folders</Text>
            {collections.map((folder) => (
              <View key={folder.id} style={[styles.row, folder.visible ? null : styles.rowHidden]}>
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
            ))}
            <View style={styles.row}>
              <TextInput
                style={[styles.folderName, styles.newFolderInput]}
                value={newFolder}
                onChangeText={setNewFolder}
                placeholder="New folder…"
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

            {/* Places */}
            <Text style={styles.sectionLabel}>Places</Text>
            {places.length === 0 ? (
              <Text style={styles.muted}>
                No saved places yet. Long-press the map to save a pin — or sign in to sync the
                favorites from your other devices.
              </Text>
            ) : (
              places.map((place) => (
                <View key={place.id}>
                  <View style={[styles.row, place.visible ? null : styles.rowHidden]}>
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
                            style={[styles.iconChoice, ic === place.icon && styles.choiceSelected]}
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
                      {/* Folder assignment — parity with the web place folder picker. */}
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
                        {collections.map((folder) => (
                          <Pressable
                            key={folder.id}
                            style={[
                              styles.folderChip,
                              place.collectionId === folder.id && styles.folderChipSelected,
                            ]}
                            onPress={() => onPatch(place.id, { collectionId: folder.id })}
                            testID={`favorite-folder-${place.id}-${folder.id}`}
                          >
                            <Text style={styles.folderChipText}>📁 {folder.name}</Text>
                          </Pressable>
                        ))}
                      </View>
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
              ))
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
