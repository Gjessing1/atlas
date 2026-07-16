import { PLACE_COLORS, PLACE_ICONS } from '@atlas/core';
import type { PlacePatch, PlaceRecord } from '@atlas/storage';
import { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

/**
 * Favorites/saved-places list — the mobile counterpart of the web Sidebar's
 * favorites, so saved pins are browsable (and synced ones from other devices
 * appear here), not only tappable on the map. Fly to, navigate to, remove, or
 * (tap the emoji badge) edit a place: rename it and pick a different
 * icon/colour — the mobile counterpart of the web Sidebar's style panel.
 */
export function FavoritesSheet({
  visible,
  onClose,
  places,
  onFlyTo,
  onNavigate,
  onPatch,
  onDelete,
  bottomInset = 0,
}: {
  visible: boolean;
  onClose: () => void;
  places: PlaceRecord[];
  onFlyTo: (place: PlaceRecord) => void;
  onNavigate: (place: PlaceRecord) => void;
  /** Patch a place's name/icon/colour (auto-saved + synced, same as the web panel). */
  onPatch: (id: string, patch: Pick<PlacePatch, 'name' | 'icon' | 'color'>) => void;
  onDelete: (id: string) => void;
  /** System nav-bar inset — keeps the Close button clear of it (edge-to-edge). */
  bottomInset?: number;
}) {
  // Which row's edit panel is currently open (tap the emoji badge to toggle).
  const [editingId, setEditingId] = useState<string | null>(null);

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={[styles.sheet, { paddingBottom: bottomInset + 20 }]}>
          <Text style={styles.heading}>Favorites</Text>
          {places.length === 0 ? (
            <Text style={styles.muted}>
              No saved places yet. Long-press the map to save a pin — or sign in to sync the
              favorites from your other devices.
            </Text>
          ) : (
            <ScrollView>
              {places.map((place) => (
                <View key={place.id}>
                  <View style={styles.row}>
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
                      style={styles.button}
                      onPress={() => {
                        onNavigate(place);
                        onClose();
                      }}
                      testID={`favorite-nav-${place.id}`}
                    >
                      <Text style={styles.buttonText}>Go</Text>
                    </Pressable>
                    <Pressable
                      style={[styles.button, styles.buttonQuiet]}
                      onPress={() => onDelete(place.id)}
                      testID={`favorite-delete-${place.id}`}
                    >
                      <Text style={styles.buttonQuietText}>Remove</Text>
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
                    </View>
                  ) : null}
                </View>
              ))}
            </ScrollView>
          )}
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
    maxHeight: '80%',
  },
  heading: { fontSize: 15, fontWeight: '700', color: '#334', marginBottom: 10 },
  muted: { fontSize: 13, color: '#778', marginTop: 2 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8 },
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
  buttonText: { color: '#fff', fontWeight: '600' },
  buttonQuiet: { backgroundColor: '#eef1f6' },
  buttonQuietText: { color: '#334', fontWeight: '600' },
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
  closeButton: { marginTop: 14, alignSelf: 'stretch', alignItems: 'center' },
});
