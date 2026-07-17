import type { TrackRecord } from '@atlas/storage';
import { useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import type { ImportResult } from '../useUserData';

function fmtKm(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
}

function fmtDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const min = Math.floor((total % 3600) / 60);
  return h > 0 ? `${h} h ${min} min` : `${min} min`;
}

function trackSummary(stats: Record<string, number>): string {
  const parts: string[] = [];
  if (typeof stats.distanceM === 'number') parts.push(fmtKm(stats.distanceM));
  if (typeof stats.durationMs === 'number' && stats.durationMs > 0)
    parts.push(fmtDuration(stats.durationMs));
  if (typeof stats.ascentM === 'number' && stats.ascentM > 0)
    parts.push(`↗ ${Math.round(stats.ascentM)} m`);
  return parts.join(' · ') || 'no stats';
}

/**
 * Tracks list — the mobile counterpart of the web Sidebar's tracks: browse
 * saved/recorded/imported GPX tracks, toggle map visibility, rename, export
 * (share as GPX/KML), delete, and import GPX/KML/KMZ files from the device.
 */
export function TracksSheet({
  visible,
  onClose,
  tracks,
  onSetVisible,
  onRename,
  onExport,
  onDelete,
  onImport,
  bottomInset = 0,
}: {
  visible: boolean;
  onClose: () => void;
  tracks: TrackRecord[];
  onSetVisible: (id: string, visible: boolean) => void;
  onRename: (id: string, name: string) => void;
  onExport: (id: string, format: 'gpx' | 'kml') => void;
  onDelete: (id: string) => void;
  /** Pick files and import them; returns a per-run summary (null if cancelled). */
  onImport: () => Promise<ImportResult | null>;
  /** System nav-bar inset — keeps the Close button clear of it (edge-to-edge). */
  bottomInset?: number;
}) {
  const [importing, setImporting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const runImport = async () => {
    setImporting(true);
    setMessage(null);
    try {
      const result = await onImport();
      if (result) {
        const bits: string[] = [];
        if (result.tracks.length) bits.push(`${result.tracks.length} track(s)`);
        if (result.places.length) bits.push(`${result.places.length} place(s)`);
        setMessage(bits.length ? `Imported ${bits.join(', ')}.` : 'Nothing importable found.');
        if (result.errors.length) setMessage((m) => `${m ?? ''} ${result.errors[0]}`.trim());
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setImporting(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={[styles.sheet, { paddingBottom: bottomInset + 20 }]}>
          <View style={styles.headerRow}>
            <Text style={styles.heading}>Tracks</Text>
            <Pressable
              style={[styles.button, importing ? styles.buttonDisabled : null]}
              disabled={importing}
              onPress={() => void runImport()}
              testID="tracks-import"
            >
              {importing ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.buttonText}>Import file</Text>
              )}
            </Pressable>
          </View>
          {message ? <Text style={styles.muted}>{message}</Text> : null}

          {tracks.length === 0 ? (
            <Text style={styles.muted}>
              No tracks yet. Import a GPX/KML/KMZ file to see it on the map.
            </Text>
          ) : (
            <ScrollView>
              {tracks.map((track) => (
                <View key={track.id} style={[styles.row, track.visible ? null : styles.rowHidden]}>
                  <Pressable
                    style={styles.eyeButton}
                    onPress={() => onSetVisible(track.id, !track.visible)}
                    testID={`track-visible-${track.id}`}
                  >
                    <Text style={styles.eyeText}>{track.visible ? '👁' : '🚫'}</Text>
                  </Pressable>
                  <View style={styles.rowMain}>
                    <TextInput
                      style={styles.nameInput}
                      defaultValue={track.name}
                      onEndEditing={(e) => {
                        const value = e.nativeEvent.text.trim();
                        if (value && value !== track.name) onRename(track.id, value);
                      }}
                      returnKeyType="done"
                      testID={`track-name-${track.id}`}
                    />
                    <Text style={styles.muted}>{trackSummary(track.stats)}</Text>
                    <View style={styles.actionRow}>
                      <Pressable
                        style={[styles.button, styles.buttonQuiet]}
                        onPress={() => onExport(track.id, 'gpx')}
                        testID={`track-export-gpx-${track.id}`}
                      >
                        <Text style={styles.buttonQuietText}>GPX</Text>
                      </Pressable>
                      <Pressable
                        style={[styles.button, styles.buttonQuiet]}
                        onPress={() => onExport(track.id, 'kml')}
                        testID={`track-export-kml-${track.id}`}
                      >
                        <Text style={styles.buttonQuietText}>KML</Text>
                      </Pressable>
                      <Pressable
                        style={[styles.button, styles.buttonQuiet]}
                        onPress={() => onDelete(track.id)}
                        testID={`track-delete-${track.id}`}
                      >
                        <Text style={styles.buttonQuietText}>Delete</Text>
                      </Pressable>
                    </View>
                  </View>
                </View>
              ))}
            </ScrollView>
          )}
          <Pressable
            style={[styles.button, styles.closeButton]}
            onPress={onClose}
            testID="tracks-close"
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
  muted: { fontSize: 13, color: '#778', marginTop: 4 },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, paddingVertical: 10 },
  rowHidden: { opacity: 0.45 },
  eyeButton: { paddingHorizontal: 2, paddingVertical: 4 },
  eyeText: { fontSize: 18 },
  rowMain: { flexShrink: 1, flexGrow: 1, gap: 6 },
  nameInput: {
    borderWidth: 1,
    borderColor: '#cdd3dd',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 15,
    color: '#111',
  },
  actionRow: { flexDirection: 'row', gap: 8 },
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
  closeButton: { marginTop: 12, alignSelf: 'stretch', alignItems: 'center' },
});
