import { ROUTING_PROFILES, type RoutePath } from '@atlas/routing';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import type { RoutePlanner } from '../routing/useRoute';

function fmtKm(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
}

function fmtDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const min = Math.floor((total % 3600) / 60);
  return h > 0 ? `${h} h ${min} min` : `${min} min`;
}

const fmtEta = (timeMs: number): string =>
  new Date(Date.now() + timeMs).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

/** Waypoint label, matching the map markers: A, B, C… (⟳ for a round trip). */
function waypointLabel(index: number, roundTrip: boolean, count: number): string {
  if (roundTrip || count === 1) return '⟳';
  return index < 26 ? String.fromCharCode(65 + index) : String(index + 1);
}

/**
 * Route-planning panel — the mobile counterpart of the web RoutePanel
 * (apps/web/src/routing/RoutePanel.tsx). Bottom-docked (not modal) so the map
 * stays tappable to add stops. Profile, round trip, ordered stops (reorder with
 * ▲/▼ since there's no drag on the map list), reverse/optimize/clear, result
 * stats, alternatives, and GPX export via the OS share sheet.
 */
export function RoutePanel({
  route,
  onExport,
  bottomInset = 0,
}: {
  route: RoutePlanner;
  /** Share the selected path as GPX; App owns the build+share. */
  onExport: (path: RoutePath) => void;
  bottomInset?: number;
}) {
  const path = route.paths?.[route.selectedPath] ?? null;

  return (
    <View style={[styles.panel, { paddingBottom: bottomInset + 12 }]}>
      <View style={styles.headerRow}>
        <Text style={styles.heading}>Route</Text>
        {route.loading ? <Text style={styles.muted}>Routing…</Text> : null}
        <Pressable style={styles.closeX} onPress={route.stop} testID="route-close">
          <Text style={styles.closeXText}>✕</Text>
        </Pressable>
      </View>

      <View style={styles.chipRow}>
        {ROUTING_PROFILES.map((p) => (
          <Pressable
            key={p.id}
            style={[styles.chip, p.id === route.profile && styles.chipSelected]}
            onPress={() => route.setProfile(p.id)}
            testID={`route-profile-${p.id}`}
          >
            <Text style={styles.chipText}>
              {p.icon} {p.label}
            </Text>
          </Pressable>
        ))}
      </View>

      <View style={styles.roundRow}>
        <Pressable
          style={[styles.chip, route.roundTrip && styles.chipSelected]}
          onPress={() => route.setRoundTrip(!route.roundTrip)}
          testID="route-roundtrip"
        >
          <Text style={styles.chipText}>Round trip</Text>
        </Pressable>
        {route.roundTrip ? (
          <>
            <TextInput
              style={styles.kmInput}
              keyboardType="numeric"
              value={String(route.roundTripKm)}
              onChangeText={(t) => route.setRoundTripKm(Math.max(Number(t) || 1, 1))}
              testID="route-roundtrip-km"
            />
            <Text style={styles.muted}>km</Text>
            <Pressable
              style={[styles.button, styles.buttonQuiet]}
              onPress={route.newLoop}
              disabled={route.waypoints.length === 0}
            >
              <Text style={styles.buttonQuietText}>New loop</Text>
            </Pressable>
          </>
        ) : null}
      </View>

      {route.waypoints.length > 0 ? (
        <ScrollView style={styles.wpList}>
          {route.waypoints.map((w, i) => (
            <View key={w.id} style={styles.wpRow}>
              <Text style={styles.wpLabel}>
                {waypointLabel(i, route.roundTrip, route.waypoints.length)}
              </Text>
              <Text style={styles.wpCoords}>
                {w.pos.lat.toFixed(4)}, {w.pos.lng.toFixed(4)}
              </Text>
              {!route.roundTrip ? (
                <>
                  <Pressable
                    style={styles.iconButton}
                    disabled={i === 0}
                    onPress={() => route.reorderWaypoint(i, i - 1)}
                    testID={`route-wp-up-${w.id}`}
                  >
                    <Text style={[styles.iconText, i === 0 && styles.iconDisabled]}>▲</Text>
                  </Pressable>
                  <Pressable
                    style={styles.iconButton}
                    disabled={i === route.waypoints.length - 1}
                    onPress={() => route.reorderWaypoint(i, i + 1)}
                    testID={`route-wp-down-${w.id}`}
                  >
                    <Text
                      style={[
                        styles.iconText,
                        i === route.waypoints.length - 1 && styles.iconDisabled,
                      ]}
                    >
                      ▼
                    </Text>
                  </Pressable>
                </>
              ) : null}
              <Pressable
                style={styles.iconButton}
                onPress={() => route.removeWaypoint(w.id)}
                testID={`route-wp-remove-${w.id}`}
              >
                <Text style={styles.iconText}>✕</Text>
              </Pressable>
            </View>
          ))}
        </ScrollView>
      ) : (
        <Text style={styles.muted}>
          {route.roundTrip
            ? 'Tap the map to set the starting point.'
            : 'Tap the map to add start and destination.'}
        </Text>
      )}

      <View style={styles.actionRow}>
        <Pressable
          style={[styles.button, styles.buttonQuiet]}
          disabled={route.roundTrip || route.waypoints.length < 2}
          onPress={route.reverse}
        >
          <Text style={styles.buttonQuietText}>Reverse</Text>
        </Pressable>
        <Pressable
          style={[styles.button, styles.buttonQuiet]}
          disabled={route.roundTrip || route.waypoints.length < 4}
          onPress={route.optimize}
        >
          <Text style={styles.buttonQuietText}>Optimize</Text>
        </Pressable>
        <Pressable
          style={[styles.button, styles.buttonQuiet]}
          disabled={route.waypoints.length === 0}
          onPress={route.clear}
        >
          <Text style={styles.buttonQuietText}>Clear</Text>
        </Pressable>
        <Pressable
          style={[styles.button, !path && styles.buttonDisabled]}
          disabled={!path}
          onPress={() => path && onExport(path)}
          testID="route-export"
        >
          <Text style={styles.buttonText}>Export GPX</Text>
        </Pressable>
      </View>

      {route.error ? <Text style={styles.error}>{route.error}</Text> : null}
      {path ? (
        <Text style={styles.stats}>
          {fmtKm(path.distanceM)} · {fmtDuration(path.timeMs)} · ETA {fmtEta(path.timeMs)} · ↗{' '}
          {Math.round(path.ascentM)} m ↘ {Math.round(path.descentM)} m
        </Text>
      ) : null}
      {route.paths && route.paths.length > 1 ? (
        <View style={styles.chipRow}>
          {route.paths.map((p, i) => (
            <Pressable
              key={i}
              style={[styles.chip, i === route.selectedPath && styles.chipSelected]}
              onPress={() => route.selectPath(i)}
              testID={`route-alt-${i}`}
            >
              <Text style={styles.chipText}>
                {i === 0 ? 'Best' : `Alt ${i}`}: {fmtKm(p.distanceM)} · {fmtDuration(p.timeMs)}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#fff',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: 16,
    gap: 8,
    elevation: 12,
    maxHeight: '60%',
  },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  heading: { fontSize: 15, fontWeight: '700', color: '#334', flexGrow: 1 },
  muted: { fontSize: 13, color: '#778' },
  closeX: { paddingHorizontal: 6, paddingVertical: 2 },
  closeXText: { fontSize: 18, color: '#556' },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: {
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: '#f1f3f7',
    borderWidth: 2,
    borderColor: 'transparent',
  },
  chipSelected: { borderColor: '#1a73e8', backgroundColor: '#e7effd' },
  chipText: { fontSize: 13, color: '#334', fontWeight: '600' },
  roundRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  kmInput: {
    borderWidth: 1,
    borderColor: '#cdd3dd',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    minWidth: 60,
    fontSize: 15,
    color: '#111',
  },
  wpList: { maxHeight: 160 },
  wpRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6 },
  wpLabel: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: '#1a73e8',
    color: '#fff',
    textAlign: 'center',
    lineHeight: 26,
    fontWeight: '700',
  },
  wpCoords: { flexGrow: 1, flexShrink: 1, fontSize: 14, color: '#223' },
  iconButton: { paddingHorizontal: 6, paddingVertical: 2 },
  iconText: { fontSize: 16, color: '#556' },
  iconDisabled: { color: '#ccd' },
  actionRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
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
  error: { fontSize: 13, color: '#b3261e' },
  stats: { fontSize: 14, color: '#111', fontWeight: '600' },
});
