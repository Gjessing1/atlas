import type { PlaceRecord } from '@atlas/storage';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

/**
 * Favorites/saved-places list — the mobile counterpart of the web Sidebar's
 * favorites, so saved pins are browsable (and synced ones from other devices
 * appear here), not only tappable on the map. Fly to, navigate to, or remove.
 */
export function FavoritesSheet({
  visible,
  onClose,
  places,
  onFlyTo,
  onNavigate,
  onDelete,
}: {
  visible: boolean;
  onClose: () => void;
  places: PlaceRecord[];
  onFlyTo: (place: PlaceRecord) => void;
  onNavigate: (place: PlaceRecord) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <Text style={styles.heading}>Favorites</Text>
          {places.length === 0 ? (
            <Text style={styles.muted}>
              No saved places yet. Long-press the map to save a pin — or sign in to sync the
              favorites from your other devices.
            </Text>
          ) : (
            <ScrollView>
              {places.map((place) => (
                <View key={place.id} style={styles.row}>
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
  closeButton: { marginTop: 14, alignSelf: 'stretch', alignItems: 'center' },
});
