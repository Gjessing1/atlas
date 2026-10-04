import { fmtDuration, fmtKm, garminActivityLabel } from '@atlas/core';
import { computeTrackStats, type TrackData } from '@atlas/gpx';
import type { TrackRecord } from '@atlas/storage';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { BottomSheet } from './BottomSheet';
import { ElevationChart } from './ElevationChart';
import { theme } from './theme';

/**
 * A saved track's shape, in height — opened by tapping its row in Collections,
 * the same gesture that frames it on the map.
 *
 * Web has answered a track-row click with the map *and* the profile since the
 * sidebar existed; Android framed the track and showed nothing, which is half
 * the gesture. A map sheet rather than a modal one: the point is to read the
 * climb against the line the camera has just moved to.
 */
export function TrackProfileSheet({
  track,
  data,
  onClose,
  bottomInset = 0,
}: {
  track: TrackRecord | null;
  /** Parsed geometry; null while it loads or when the track cannot be read. */
  data: TrackData | null;
  onClose: () => void;
  bottomInset?: number;
}) {
  const activity = track ? garminActivityLabel(track.tags) : null;
  const distanceM = track?.stats['distanceM'] ?? (data ? computeTrackStats(data).distanceM : null);
  const durationMs = track?.stats['durationMs'];
  const ascentM = track?.stats['ascentM'];
  return (
    <BottomSheet
      visible={track !== null}
      mode="map"
      onClose={onClose}
      initialSnap="peek"
      peekHeight={230}
      bottomInset={bottomInset}
      testID="track-profile-sheet"
    >
      <View style={styles.headerRow}>
        <Text style={styles.heading} numberOfLines={1}>
          {track?.name ?? ''}
        </Text>
        <Pressable onPress={onClose} hitSlop={10} testID="track-profile-close">
          <Text style={styles.close}>✕</Text>
        </Pressable>
      </View>
      {activity ? <Text style={styles.muted}>Activity: {activity}</Text> : null}
      {track ? (
        <Text style={styles.muted} testID="track-profile-distance">
          Total distance: {distanceM === null ? 'Unavailable' : fmtKm(distanceM)}
        </Text>
      ) : null}
      {track && ((durationMs !== undefined && durationMs > 0) || (ascentM ?? 0) > 0) ? (
        <Text style={styles.muted}>
          {[
            durationMs !== undefined && durationMs > 0 ? fmtDuration(durationMs) : null,
            ascentM !== undefined && ascentM > 0 ? `↗ ${Math.round(ascentM)} m` : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </Text>
      ) : null}
      {data ? (
        <ElevationChart data={data} />
      ) : (
        <Text style={styles.muted}>No elevation data in this track.</Text>
      )}
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  heading: { flexShrink: 1, fontSize: 15, fontWeight: '700', color: theme.text },
  close: { fontSize: 18, color: theme.textMuted, paddingHorizontal: 4 },
  muted: { fontSize: 13, color: theme.textMuted, marginTop: 4 },
});
