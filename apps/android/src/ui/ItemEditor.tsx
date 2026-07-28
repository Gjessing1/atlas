import { PLACE_COLORS, PLACE_ICONS } from '@atlas/core';
import type { CollectionRecord } from '@atlas/storage';
import { useState, type ReactNode } from 'react';
import { Alert, Keyboard, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { theme } from './theme';

/** The fields the editor can change — a superset of `PlacePatch` and `TrackPatch`. */
export interface ItemPatch {
  name?: string;
  address?: string;
  icon?: string;
  color?: string;
  collectionId?: string | null;
  notes?: string;
  tags?: string[];
}

/**
 * Ask before a delete. The undo banner catches mistakes afterwards, but these
 * buttons sit in dense rows where a mis-tap is easy — cheaper to ask first.
 */
export function confirmDelete(title: string, message: string, onConfirm: () => void): void {
  Alert.alert(title, message, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Delete', style: 'destructive', onPress: onConfirm },
  ]);
}

/**
 * The inline detail editor for one saved item — the counterpart of web's
 * `sidebar/ItemEditor`. Places and tracks share it: a track has no address and
 * no icon/colour (nothing draws them), everything else — name, folder, notes,
 * tags, delete — is the same record shape and the same editing.
 *
 * The one deliberate difference from web is *when* a change lands. Web
 * auto-saves each field on blur; here everything lands together on Save. On a
 * phone the keyboard covers the row being edited, so "blur" is whatever the
 * next tap happens to be — an explicit Save is the only commit the user can
 * see. Cancel is the sheet's own close.
 */
export function ItemEditor({
  id,
  noun,
  testPrefix,
  name,
  address,
  style,
  collectionId,
  notes,
  tags,
  folders,
  actions,
  onSave,
  onDelete,
  onClose,
  inset = false,
}: {
  /** Record id — only used to key the testIDs to a row. */
  id: string;
  /** What this is, in the user's words — fills the placeholders and Delete. */
  noun: 'place' | 'track';
  /** Prefix for testIDs, e.g. `favorite` or `track`. */
  testPrefix: string;
  name: string;
  /** Present for places; tracks have no address field. */
  address?: string;
  /** Present for places: the current icon/colour, enabling the style picker. */
  style?: { icon: string; color: string };
  collectionId: string | null;
  notes: string;
  tags: string[];
  folders: { folder: CollectionRecord; depth: number }[];
  /** Extra actions rendered beside Delete (e.g. a track's GPX/KML export). */
  actions?: ReactNode;
  onSave: (patch: ItemPatch) => void;
  onDelete: () => void;
  onClose: () => void;
  inset?: boolean;
}) {
  const [nameValue, setNameValue] = useState(name);
  const [addressValue, setAddressValue] = useState(address ?? '');
  const [icon, setIcon] = useState(style?.icon ?? '');
  const [color, setColor] = useState(style?.color ?? '');
  const [folderId, setFolderId] = useState(collectionId);
  const [notesValue, setNotesValue] = useState(notes);
  const [tagsValue, setTagsValue] = useState(tags.join(', '));
  const Noun = noun[0]!.toUpperCase() + noun.slice(1);

  const save = () => {
    const trimmedName = nameValue.trim();
    if (!trimmedName) return;
    Keyboard.dismiss();
    onSave({
      name: trimmedName,
      // Only places carry these; sending them for a track would put keys the
      // track patch has no column for through storage.
      ...(address !== undefined ? { address: addressValue.trim() } : {}),
      ...(style ? { icon, color } : {}),
      collectionId: folderId,
      notes: notesValue,
      tags: tagsValue
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
          value={nameValue}
          onChangeText={setNameValue}
          placeholder={`${Noun} name`}
          returnKeyType="done"
          accessibilityLabel="Name"
          testID={`${testPrefix}-name-${id}`}
        />
      </View>
      {address !== undefined ? (
        <View style={styles.field}>
          <Text style={styles.fieldLabel}>Address</Text>
          <TextInput
            style={styles.nameInput}
            value={addressValue}
            onChangeText={setAddressValue}
            placeholder="Street, postcode, city"
            returnKeyType="done"
            accessibilityLabel="Address"
            testID={`${testPrefix}-address-${id}`}
          />
        </View>
      ) : null}
      {style ? (
        <>
          <Text style={styles.fieldLabel}>Icon</Text>
          <View style={styles.choiceRow}>
            {PLACE_ICONS.map((candidate) => (
              <Pressable
                key={candidate}
                style={[styles.iconChoice, candidate === icon && styles.choiceSelected]}
                onPress={() => setIcon(candidate)}
                testID={`${testPrefix}-icon-${id}-${candidate}`}
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
                testID={`${testPrefix}-color-${id}-${candidate}`}
              />
            ))}
          </View>
        </>
      ) : null}
      <Text style={styles.fieldLabel}>Folder</Text>
      <View style={styles.choiceRow}>
        <Pressable
          style={[styles.folderChip, folderId === null && styles.folderChipSelected]}
          onPress={() => setFolderId(null)}
          testID={`${testPrefix}-folder-${id}-none`}
        >
          <Text style={styles.folderChipText}>No folder</Text>
        </Pressable>
        {folders.map(({ folder, depth }) => (
          <Pressable
            key={folder.id}
            style={[styles.folderChip, folderId === folder.id && styles.folderChipSelected]}
            onPress={() => setFolderId(folder.id)}
            testID={`${testPrefix}-folder-${id}-${folder.id}`}
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
          value={notesValue}
          onChangeText={setNotesValue}
          placeholder={`Add details about this ${noun}`}
          multiline
          accessibilityLabel="Notes"
          testID={`${testPrefix}-notes-${id}`}
        />
      </View>
      <View style={styles.field}>
        <Text style={styles.fieldLabel}>Tags</Text>
        <TextInput
          style={styles.nameInput}
          value={tagsValue}
          onChangeText={setTagsValue}
          placeholder="hike, family, todo"
          returnKeyType="done"
          accessibilityLabel="Tags"
          testID={`${testPrefix}-tags-${id}`}
        />
      </View>
      <View style={styles.editorActions}>
        <Pressable
          style={[styles.button, !nameValue.trim() && styles.buttonDisabled]}
          disabled={!nameValue.trim()}
          onPress={save}
          testID={`${testPrefix}-save-${id}`}
        >
          <Text style={styles.buttonText}>Save</Text>
        </Pressable>
        {actions}
        <Pressable
          style={[styles.button, styles.buttonDanger]}
          onPress={() => {
            Keyboard.dismiss();
            confirmDelete(`Delete “${name}”?`, 'You can undo this right after.', () => {
              onClose();
              onDelete();
            });
          }}
          testID={`${testPrefix}-delete-${id}`}
        >
          <Text style={styles.buttonText}>Delete {noun}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  picker: { paddingBottom: 10, gap: 8 },
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
  button: {
    backgroundColor: theme.accent,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  buttonDisabled: { opacity: 0.5 },
  buttonText: { color: theme.onAccent, fontWeight: '600' },
  buttonDanger: { backgroundColor: theme.danger, alignSelf: 'flex-start' },
});
