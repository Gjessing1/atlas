import type { ResumableTrip } from '@atlas/app-hooks';
import { fmtDistanceM } from '@atlas/core';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { theme } from '../ui/theme';

/**
 * "You were navigating — carry on?" after the trip died with the app.
 *
 * Sits low on an otherwise idle map so it reads as an offer rather than a
 * modal: the map is usable behind it, and dismissing is one tap. What it shows
 * is what identifies the trip to the person who was on it — the distance that
 * was still left, and the mode — because Atlas records the destination as a
 * coordinate, not a name, and "12 km to go, driving" is what they remember.
 */
export function NavResumeCard({
  trip,
  bottom,
  left,
  right,
  onResume,
  onDismiss,
}: {
  trip: ResumableTrip;
  bottom: number;
  left: number;
  right: number;
  onResume: () => void;
  onDismiss: () => void;
}) {
  const detail = [
    trip.remainingM !== null ? `${fmtDistanceM(trip.remainingM)} to go` : null,
    trip.vias.length > 0
      ? `${trip.vias.length} stop${trip.vias.length === 1 ? '' : 's'} left`
      : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <View style={[styles.card, { bottom, left, right }]} testID="nav-resume-card">
      <View style={styles.text}>
        <Text style={styles.title}>Resume navigation?</Text>
        <Text style={styles.detail} numberOfLines={1}>
          {detail || 'Your last trip was interrupted'}
        </Text>
      </View>
      <Pressable
        style={styles.resume}
        onPress={onResume}
        testID="nav-resume"
        accessibilityRole="button"
        accessibilityLabel="Resume navigation to your previous destination"
      >
        <Text style={styles.resumeText}>Resume</Text>
      </Pressable>
      <Pressable
        onPress={onDismiss}
        hitSlop={10}
        testID="nav-resume-dismiss"
        accessibilityRole="button"
        accessibilityLabel="Dismiss"
      >
        <Text style={styles.close}>✕</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    position: 'absolute',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: theme.surface,
    borderRadius: 14,
    paddingVertical: 10,
    paddingHorizontal: 14,
    elevation: 4,
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
  },
  text: { flex: 1 },
  title: { color: theme.text, fontSize: 15, fontWeight: '700' },
  detail: { color: theme.textMuted, fontSize: 12, marginTop: 1 },
  resume: {
    backgroundColor: theme.accent,
    borderRadius: 10,
    paddingVertical: 9,
    paddingHorizontal: 16,
  },
  resumeText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  close: { color: theme.textMuted, fontSize: 18, paddingHorizontal: 4 },
});
