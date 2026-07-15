import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { NavController } from './useNavigation';

function formatDistance(m: number): string {
  if (m < 1000) return `${Math.round(m / 10) * 10} m`;
  return `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`;
}

function formatDuration(ms: number): string {
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return `${h} h ${min % 60} min`;
}

function formatEta(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Turn-by-turn banner: the next maneuver up top, trip summary + stop below. */
export function NavBanner({ nav }: { nav: NavController }) {
  if (nav.phase === 'idle') return null;

  const { state } = nav;
  const maneuver = state?.upcoming;

  return (
    <View style={styles.wrap} pointerEvents="box-none">
      <View style={styles.card}>
        {nav.phase === 'starting' ? (
          <Text style={styles.maneuver}>Finding route…</Text>
        ) : nav.phase === 'error' ? (
          <Text style={styles.error}>{nav.error ?? 'Navigation error'}</Text>
        ) : nav.phase === 'arrived' ? (
          <Text style={styles.maneuver}>You have arrived</Text>
        ) : maneuver ? (
          <View style={styles.maneuverRow}>
            <Text style={styles.distanceTo}>{formatDistance(maneuver.distanceToM)}</Text>
            <Text style={styles.maneuver} numberOfLines={2}>
              {maneuver.instruction.text}
            </Text>
          </View>
        ) : (
          <Text style={styles.maneuver}>Continue on route</Text>
        )}

        {nav.phase === 'rerouting' ? <Text style={styles.reroute}>Rerouting…</Text> : null}

        {state && nav.phase !== 'arrived' ? (
          <Text style={styles.summary}>
            {formatDistance(state.distanceRemainingM)} · {formatDuration(state.timeRemainingMs)} ·
            arrive {formatEta(state.etaEpochMs)}
          </Text>
        ) : null}
      </View>

      <Pressable style={styles.stop} onPress={nav.stop} testID="stop-nav">
        <Text style={styles.stopText}>{nav.phase === 'arrived' ? 'Done' : 'End'}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', top: 40, left: 12, right: 12, gap: 8 },
  card: {
    backgroundColor: 'rgba(17,17,17,0.9)',
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 12,
    elevation: 6,
  },
  maneuverRow: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  distanceTo: { color: '#7ec8ff', fontSize: 22, fontWeight: '700', minWidth: 72 },
  maneuver: { color: '#fff', fontSize: 17, fontWeight: '600', flexShrink: 1 },
  summary: { color: '#cdd6e0', fontSize: 13, marginTop: 8 },
  reroute: { color: '#ffcf7e', fontSize: 13, marginTop: 6 },
  error: { color: '#ff9a8f', fontSize: 15, fontWeight: '600' },
  stop: {
    alignSelf: 'center',
    backgroundColor: '#b3261e',
    borderRadius: 20,
    paddingHorizontal: 22,
    paddingVertical: 8,
    elevation: 4,
  },
  stopText: { color: '#fff', fontWeight: '700', fontSize: 15 },
});
