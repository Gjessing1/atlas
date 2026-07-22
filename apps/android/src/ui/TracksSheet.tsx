import { importedCount } from '@atlas/app-hooks';
import { fmtDuration, fmtKm } from '@atlas/core';
import type { TrackData } from '@atlas/gpx';
import type { CollectionRecord, TrackRecord } from '@atlas/storage';
import { useMemo, useRef, useState } from 'react';
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
import { ElevationChart } from './ElevationChart';
import { flattenFolders } from './folders';
import { theme } from './theme';

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
  collections,
  onSetVisible,
  onRename,
  onExport,
  onDelete,
  onImport,
  onLoadTrackData,
  bottomInset = 0,
}: {
  visible: boolean;
  onClose: () => void;
  tracks: TrackRecord[];
  /** Folders offered as import destinations. */
  collections: CollectionRecord[];
  onSetVisible: (id: string, visible: boolean) => void;
  onRename: (id: string, name: string) => void;
  onExport: (id: string, format: 'gpx' | 'kml') => void;
  onDelete: (id: string) => void;
  /** Pick files and import them; returns a per-run summary (null if cancelled). */
  onImport: (options?: ImportOptions) => Promise<ImportResult | null>;
  /** Parsed geometry for the elevation profile (cached by the shared hook). */
  onLoadTrackData: (id: string) => Promise<TrackData | null>;
  /** System nav-bar inset — keeps the Close button clear of it (edge-to-edge). */
  bottomInset?: number;
}) {
  const [importing, setImporting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // Import destination: a folder id, 'root' for no folder, or 'new' (named below).
  const [target, setTarget] = useState('root');
  const [newFolder, setNewFolder] = useState('');
  // Track whose elevation profile is expanded, and its lazily-loaded geometry
  // (null = still loading; the wrapper marks "loaded but unparseable" apart).
  const [profileId, setProfileId] = useState<string | null>(null);
  const [profile, setProfile] = useState<{ data: TrackData | null } | null>(null);
  const profileGeneration = useRef(0);

  const toggleProfile = (id: string) => {
    const gen = ++profileGeneration.current;
    if (profileId === id) {
      setProfileId(null);
      return;
    }
    setProfileId(id);
    setProfile(null);
    void onLoadTrackData(id).then((data) => {
      // Ignore a slow load that resolves after another profile was toggled.
      if (gen === profileGeneration.current) setProfile({ data });
    });
  };

  const folders = useMemo(() => flattenFolders(collections), [collections]);
  const importDisabled = importing || (target === 'new' && !newFolder.trim());

  const runImport = async () => {
    setImporting(true);
    setMessage(null);
    try {
      const options: ImportOptions =
        target === 'new'
          ? { newCollection: { name: newFolder.trim() } }
          : { collectionId: target === 'root' ? null : target };
      const result = await onImport(options);
      if (result) {
        // The new folder now exists as a normal chip — drop back to the default
        // rather than silently creating a second folder of the same name.
        setNewFolder('');
        if (target === 'new') setTarget('root');
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
    <BottomSheet
      visible={visible}
      onClose={onClose}
      initialSnap="half"
      bottomInset={bottomInset}
      testID="tracks-sheet"
    >
      <View style={styles.headerRow}>
        <Text style={styles.heading}>Tracks</Text>
        <Pressable
          style={[styles.button, importDisabled ? styles.buttonDisabled : null]}
          disabled={importDisabled}
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
          style={styles.nameInput}
          value={newFolder}
          onChangeText={setNewFolder}
          placeholder="New folder name"
          returnKeyType="done"
          accessibilityLabel="New import folder name"
          testID="import-folder-name"
        />
      ) : null}
      {message ? <Text style={styles.muted}>{message}</Text> : null}

      {tracks.length === 0 ? (
        <Text style={[styles.muted, styles.empty]}>
          No tracks yet. Import a GPX/KML/KMZ file to see it on the map.
        </Text>
      ) : (
        <ScrollView style={styles.scroll}>
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
                    onPress={() => toggleProfile(track.id)}
                    testID={`track-profile-${track.id}`}
                  >
                    <Text style={styles.buttonQuietText}>Profile</Text>
                  </Pressable>
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
                {profileId === track.id ? (
                  profile === null ? (
                    <ActivityIndicator style={styles.profileLoading} />
                  ) : profile.data ? (
                    <ElevationChart data={profile.data} />
                  ) : (
                    <Text style={styles.muted}>Track data unavailable.</Text>
                  )
                ) : null}
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
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  empty: { flex: 1 },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  heading: { fontSize: 15, fontWeight: '700', color: theme.text },
  muted: { fontSize: 13, color: theme.textMuted, marginTop: 4 },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, paddingVertical: 10 },
  rowHidden: { opacity: 0.45 },
  eyeButton: { paddingHorizontal: 2, paddingVertical: 4 },
  eyeText: { fontSize: 18 },
  rowMain: { flexShrink: 1, flexGrow: 1, gap: 6 },
  nameInput: {
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 15,
    color: theme.text,
  },
  actionRow: { flexDirection: 'row', gap: 8 },
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
  profileLoading: { marginVertical: 12 },
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
  closeButton: { marginTop: 12, alignSelf: 'stretch', alignItems: 'center' },
});
