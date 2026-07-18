import { Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { TurnIcon } from './TurnIcon';
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
  // 24-hour clock (no AM/PM) regardless of device locale.
  return new Date(epochMs).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/** Ground speed in km/h, or null when stationary/unknown. */
function formatSpeed(speedMps: number | null): string | null {
  if (speedMps == null || speedMps < 0.5) return null;
  return `${Math.round(speedMps * 3.6)} km/h`;
}

/** Turn-by-turn banner: the next maneuver up top, trip summary + stop below. */
export function NavBanner({
  nav,
  topInset = 0,
  onHeight,
}: {
  nav: NavController;
  topInset?: number;
  /** Reports the banner's laid-out height so siblings can sit clear of it. */
  onHeight?: (height: number) => void;
}) {
  const win = useWindowDimensions();
  // The preview phase has its own bottom card (RoutePreview) — no banner.
  if (nav.phase === 'idle' || nav.phase === 'preview') return null;
  // Landscape: park the banner on the left (Google-style side panel) so the
  // road ahead keeps the rest of the width.
  const landscape = win.width > win.height;

  const { state } = nav;
  const maneuver = state?.upcoming;
  const speed = formatSpeed(nav.speedMps);
  const moving = nav.phase === 'navigating' || nav.phase === 'rerouting';
  // "then …" hint when the maneuver after the current one follows hot on its
  // heels — the heads-up that matters for lane choice (Google-style).
  const thenManeuver =
    maneuver && state?.then && state.then.distanceToM - maneuver.distanceToM < 300
      ? state.then
      : null;

  return (
    <View
      style={[
        styles.wrap,
        { top: topInset + 8 },
        landscape && { right: undefined, width: Math.min(400, Math.round(win.width * 0.42)) },
      ]}
      pointerEvents="box-none"
      onLayout={(e) => onHeight?.(e.nativeEvent.layout.height)}
    >
      <View style={styles.card}>
        {nav.phase === 'starting' ? (
          <Text style={styles.maneuver}>Finding route…</Text>
        ) : nav.phase === 'error' ? (
          <Text style={styles.error}>{nav.error ?? 'Navigation error'}</Text>
        ) : nav.phase === 'arrived' ? (
          <>
            <Text style={styles.maneuver}>You have arrived</Text>
            {nav.tripSummary ? (
              <Text style={styles.summary}>
                {formatDistance(nav.tripSummary.distanceM)} ·{' '}
                {formatDuration(nav.tripSummary.durationMs)}
              </Text>
            ) : null}
          </>
        ) : maneuver ? (
          <View style={styles.maneuverRow}>
            <View style={styles.turnBox}>
              <TurnIcon instruction={maneuver.instruction} size={40} />
            </View>
            <Text style={styles.distanceTo}>{formatDistance(maneuver.distanceToM)}</Text>
            <Text style={styles.maneuver} numberOfLines={2}>
              {maneuver.instruction.text}
            </Text>
          </View>
        ) : (
          <Text style={styles.maneuver}>Continue on route</Text>
        )}

        {thenManeuver ? (
          <View style={styles.thenRow}>
            <Text style={styles.thenLabel}>then</Text>
            <TurnIcon instruction={thenManeuver.instruction} size={22} color="#cdd6e0" />
          </View>
        ) : null}

        {nav.phase === 'rerouting' ? <Text style={styles.reroute}>Rerouting…</Text> : null}
        {state?.wrongBranch && nav.phase === 'navigating' ? (
          <Text style={styles.reroute}>Check route — you may have taken a different turn</Text>
        ) : null}

        {state && nav.phase !== 'arrived' ? (
          <>
            <View style={styles.progressTrack}>
              <View
                style={[
                  styles.progressFill,
                  { width: `${Math.round(Math.min(1, Math.max(0, state.routeProgress)) * 100)}%` },
                ]}
              />
            </View>
            <Text style={styles.summary}>
              {formatDistance(state.distanceRemainingM)} · {formatDuration(state.timeRemainingMs)} ·
              arrive {formatEta(state.etaEpochMs)}
            </Text>
          </>
        ) : null}
      </View>

      <View style={styles.actionRow}>
        {moving ? (
          <View style={styles.speedPill}>
            <Text style={styles.speedValue}>{speed ?? '0 km/h'}</Text>
          </View>
        ) : (
          <View style={styles.actionSpacer} />
        )}
        <View style={styles.actionButtons}>
          {moving ? (
            <Pressable
              style={styles.muteButton}
              onPress={nav.toggleMute}
              testID="toggle-mute"
              hitSlop={8}
            >
              <Text style={styles.muteIcon}>{nav.muted ? '🔇' : '🔊'}</Text>
            </Pressable>
          ) : null}
          <Pressable style={styles.stop} onPress={nav.stop} testID="stop-nav">
            <Text style={styles.stopText}>{nav.phase === 'arrived' ? 'Done' : 'End'}</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: 12, right: 12, gap: 8 },
  card: {
    backgroundColor: 'rgba(17,17,17,0.9)',
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 12,
    elevation: 6,
  },
  maneuverRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  turnBox: { width: 44, alignItems: 'center', justifyContent: 'center' },
  thenRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 6 },
  thenLabel: { color: '#cdd6e0', fontSize: 14, fontWeight: '600' },
  distanceTo: { color: '#7ec8ff', fontSize: 22, fontWeight: '700', minWidth: 68 },
  maneuver: { color: '#fff', fontSize: 17, fontWeight: '600', flexShrink: 1 },
  progressTrack: {
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.18)',
    marginTop: 10,
    overflow: 'hidden',
  },
  progressFill: { height: 4, borderRadius: 2, backgroundColor: '#7ec8ff' },
  summary: { color: '#cdd6e0', fontSize: 13, marginTop: 6 },
  reroute: { color: '#ffcf7e', fontSize: 13, marginTop: 6 },
  error: { color: '#ff9a8f', fontSize: 15, fontWeight: '600' },
  actionRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  actionSpacer: { flex: 1 },
  actionButtons: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  speedPill: {
    backgroundColor: 'rgba(17,17,17,0.9)',
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 6,
    minWidth: 78,
    alignItems: 'center',
    elevation: 4,
  },
  speedValue: { color: '#fff', fontWeight: '700', fontSize: 16 },
  muteButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(17,17,17,0.9)',
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 4,
  },
  muteIcon: { fontSize: 18 },
  stop: {
    backgroundColor: '#b3261e',
    borderRadius: 20,
    paddingHorizontal: 22,
    paddingVertical: 8,
    elevation: 4,
  },
  stopText: { color: '#fff', fontWeight: '700', fontSize: 15 },
});
