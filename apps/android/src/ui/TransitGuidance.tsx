import { transitGuidanceAt, type TransitTrip } from '@atlas/transit';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { theme } from './theme';

export function TransitGuidance({
  trip,
  onStop,
  top,
  left,
  right,
}: {
  trip: TransitTrip;
  onStop: () => void;
  top: number;
  left: number;
  right: number;
}) {
  const [nowMs, setNowMs] = useState(Date.now());
  const snapshot = useMemo(() => transitGuidanceAt(trip, nowMs), [trip, nowMs]);

  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);

  return (
    <View
      style={[styles.card, snapshot.alightSoon && styles.alight, { top, left, right }]}
      accessibilityLabel="Transit guidance"
      testID="transit-guidance"
    >
      <View style={styles.head}>
        <Text style={styles.leg}>
          Leg {snapshot.legIndex + 1} of {trip.legs.length}
        </Text>
        <Pressable onPress={onStop} style={styles.end} testID="transit-guidance-end">
          <Text style={styles.endText}>End</Text>
        </Pressable>
      </View>
      <Text
        style={styles.title}
        accessibilityLiveRegion={snapshot.alightSoon ? 'assertive' : 'polite'}
      >
        {snapshot.headline}
      </Text>
      {snapshot.countdown ? <Text style={styles.countdown}>{snapshot.countdown}</Text> : null}
      <Text style={styles.detail}>{snapshot.detail}</Text>
      <Text style={styles.offline}>
        Timetable snapshot — continues offline; live changes need a new lookup.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    position: 'absolute',
    zIndex: 30,
    padding: 12,
    gap: 3,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: theme.surface,
    elevation: 7,
  },
  alight: { borderColor: theme.warning, borderWidth: 2 },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  leg: { color: theme.textMuted, fontSize: 11, fontWeight: '700' },
  end: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
    backgroundColor: theme.surfaceMuted,
  },
  endText: { color: theme.text, fontSize: 11, fontWeight: '800' },
  title: { color: theme.text, fontSize: 18, fontWeight: '900' },
  countdown: { color: theme.accent, fontSize: 16, fontWeight: '900' },
  detail: { color: theme.text, fontSize: 13, fontWeight: '600' },
  offline: { color: theme.textMuted, fontSize: 10, marginTop: 3 },
});
