import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { TrackRecordingController } from '../nav/useTrackRecording';

function fmtDistance(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`;
}

function fmtDuration(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function fmtSpeed(mps: number): string {
  return `${(mps * 3.6).toFixed(1)} km/h`;
}

/**
 * Bottom sheet shown while a track is recording (or paused): live distance /
 * duration / speed and the pause·resume·save·discard controls. Purely presents
 * the {@link TrackRecordingController}; all logic lives in the hook + engine.
 */
export function RecordControls({
  rec,
  bottomInset,
  onSaved,
}: {
  rec: TrackRecordingController;
  bottomInset: number;
  onSaved: (name: string | null) => void;
}) {
  if (rec.phase !== 'recording' && rec.phase !== 'paused' && rec.phase !== 'saving') return null;
  const stats = rec.snapshot?.stats;
  const paused = rec.phase === 'paused';

  return (
    <View style={[styles.card, { bottom: bottomInset + 24 }]} testID="record-controls">
      <View style={styles.statsRow}>
        <Stat label="Distance" value={stats ? fmtDistance(stats.distanceM) : '—'} />
        <Stat label="Time" value={stats ? fmtDuration(stats.movingMs) : '—'} />
        <Stat label="Speed" value={stats ? fmtSpeed(stats.movingSpeedMps) : '—'} />
      </View>
      <View style={styles.buttonRow}>
        <Pressable
          style={[styles.btn, styles.btnNeutral]}
          onPress={() => (paused ? rec.resume() : rec.pause())}
          testID="record-pause"
        >
          <Text style={styles.btnNeutralText}>{paused ? 'Resume' : 'Pause'}</Text>
        </Pressable>
        <Pressable
          style={[styles.btn, styles.btnPrimary]}
          onPress={() => void rec.stopAndSave().then(onSaved)}
          testID="record-save"
        >
          <Text style={styles.btnPrimaryText}>Save</Text>
        </Pressable>
        <Pressable
          style={[styles.btn, styles.btnDanger]}
          onPress={() => rec.discard()}
          testID="record-discard"
        >
          <Text style={styles.btnDangerText}>Discard</Text>
        </Pressable>
      </View>
      {paused ? <Text style={styles.pausedHint}>Recording paused</Text> : null}
    </View>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    position: 'absolute',
    left: 12,
    right: 12,
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 14,
    elevation: 6,
    gap: 12,
  },
  statsRow: { flexDirection: 'row', justifyContent: 'space-around' },
  stat: { alignItems: 'center' },
  statValue: { fontSize: 18, fontWeight: '600', color: '#111' },
  statLabel: { fontSize: 12, color: '#667' },
  buttonRow: { flexDirection: 'row', gap: 8 },
  btn: { flex: 1, borderRadius: 10, paddingVertical: 10, alignItems: 'center' },
  btnNeutral: { backgroundColor: '#eef1f6' },
  btnNeutralText: { color: '#233', fontWeight: '600' },
  btnPrimary: { backgroundColor: '#2b6cff' },
  btnPrimaryText: { color: '#fff', fontWeight: '600' },
  btnDanger: { backgroundColor: '#fdecec' },
  btnDangerText: { color: '#b3261e', fontWeight: '600' },
  pausedHint: { textAlign: 'center', color: '#a06a00', fontSize: 12, marginTop: -4 },
});
