import { fmtClock } from '@atlas/core';
import { laneGlyphs, laneLabel } from '@atlas/navigation';
import { formatExitSign, type RouteLane } from '@atlas/routing';
import { Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import { theme } from '../ui/theme';
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

const formatEta = fmtClock;

/** Ground speed in km/h, or null when stationary/unknown. */
function speedKph(speedMps: number | null): number | null {
  if (speedMps == null || speedMps < 0.5) return null;
  return Math.round(speedMps * 3.6);
}

function LaneRow({ lanes }: { lanes: RouteLane[] }) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.lanesScroll}
      contentContainerStyle={styles.lanes}
      accessibilityLabel="Lane guidance"
    >
      {lanes.map((lane, index) => {
        const carrying = lane.state !== 'invalid';
        return (
          <View
            key={index}
            style={[
              styles.lane,
              carrying && styles.laneCarrying,
              lane.state === 'active' && styles.laneActive,
            ]}
            accessible
            accessibilityLabel={`Lane ${index + 1}: ${laneLabel(lane)}`}
          >
            <Svg width={25} height={34} viewBox="0 0 24 32">
              {laneGlyphs(lane).map((glyph) => (
                <Path
                  key={glyph.direction}
                  d={glyph.path}
                  fill="none"
                  stroke={carrying ? theme.accent : theme.icon}
                  strokeWidth={glyph.recommended ? 2.8 : 2.1}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  opacity={glyph.recommended ? 1 : carrying ? 0.38 : 0.62}
                />
              ))}
            </Svg>
          </View>
        );
      })}
    </ScrollView>
  );
}

function AudioIcon({ muted }: { muted: boolean }) {
  return (
    <Svg width={22} height={22} viewBox="0 0 24 24">
      <Path
        d="M4 10v4h4l5 4V6l-5 4H4z"
        fill="none"
        stroke={theme.text}
        strokeWidth={1.9}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {muted ? (
        <Path
          d="m17 9 5 5m0-5-5 5"
          fill="none"
          stroke={theme.text}
          strokeWidth={1.9}
          strokeLinecap="round"
        />
      ) : (
        <Path
          d="M16.5 9.2a4 4 0 0 1 0 5.6M19 6.8a7.3 7.3 0 0 1 0 10.4"
          fill="none"
          stroke={theme.text}
          strokeWidth={1.9}
          strokeLinecap="round"
        />
      )}
    </Svg>
  );
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
  const speed = speedKph(nav.speedMps);
  const moving = nav.phase === 'navigating' || nav.phase === 'rerouting';
  const sustain = moving ? (state?.sustain ?? null) : null;
  const speedLimit = moving ? (state?.speedLimitKph ?? null) : null;
  // The manual way out, offered only near the destination — where the automatic
  // rules can fail (a fix that never gets accurate enough in a car park) and
  // where "I've arrived" is the one thing the traveller knows better than we do.
  // Deliberately distinct from End: this completes the trip rather than
  // abandoning it, so it banks the summary.
  const canDeclareArrival = moving && state != null && state.distanceRemainingM <= 150;
  // "then …" hint when the maneuver after the current one follows hot on its
  // heels — or the distant maneuver demoted below a long-road sustain cue.
  const thenManeuver =
    sustain && maneuver
      ? maneuver
      : maneuver && state?.then && state.then.distanceToM - maneuver.distanceToM < 300
        ? state.then
        : null;

  return (
    <View
      style={[
        styles.wrap,
        { top: topInset + 8 },
        landscape && { right: undefined, width: Math.min(420, Math.round(win.width * 0.46)) },
      ]}
      pointerEvents="box-none"
      onLayout={(e) => onHeight?.(e.nativeEvent.layout.height)}
    >
      <View style={styles.card}>
        {nav.phase === 'starting' ? (
          <View style={styles.stateBlock}>
            <Text style={styles.eyebrow}>Navigation</Text>
            <Text style={styles.maneuver}>Finding the best route…</Text>
          </View>
        ) : nav.phase === 'error' ? (
          <View style={styles.stateBlock}>
            <Text style={styles.eyebrow}>Navigation unavailable</Text>
            <Text style={styles.error}>{nav.error ?? 'Navigation error'}</Text>
          </View>
        ) : nav.phase === 'arrived' ? (
          <View style={styles.stateBlock}>
            <Text style={styles.eyebrow}>Trip complete</Text>
            <Text style={styles.maneuver}>You have arrived</Text>
            {nav.tripSummary ? (
              <Text style={styles.arrivalSummary}>
                {formatDistance(nav.tripSummary.distanceM)} ·{' '}
                {formatDuration(nav.tripSummary.durationMs)}
              </Text>
            ) : null}
          </View>
        ) : maneuver ? (
          <>
            <View style={styles.guidanceRow}>
              <View style={styles.turnPanel}>
                <TurnIcon
                  instruction={sustain ? { sign: 0 } : maneuver.instruction}
                  size={44}
                  color="#fff"
                />
              </View>
              <View style={styles.maneuverText}>
                <Text style={styles.distanceTo}>
                  {sustain
                    ? `Continue for ${formatDistance(sustain.distanceRemainingM)}`
                    : `In ${formatDistance(maneuver.distanceToM)}`}
                </Text>
                <Text style={styles.maneuver} numberOfLines={2}>
                  {sustain ? sustain.road : maneuver.instruction.text}
                </Text>
                {!sustain && maneuver.instruction.exitSign ? (
                  <Text style={styles.exitSign} numberOfLines={1}>
                    {formatExitSign(maneuver.instruction.exitSign)}
                  </Text>
                ) : null}
              </View>
            </View>
            {state?.laneGuidance ? <LaneRow lanes={state.laneGuidance} /> : null}
            {thenManeuver ? (
              <View style={styles.thenRow}>
                <Text style={styles.thenLabel}>Then</Text>
                <TurnIcon instruction={thenManeuver.instruction} size={20} color={theme.icon} />
                <Text style={styles.thenText} numberOfLines={1}>
                  {thenManeuver.instruction.text}
                </Text>
              </View>
            ) : null}
          </>
        ) : (
          <View style={styles.stateBlock}>
            <Text style={styles.eyebrow}>On route</Text>
            <Text style={styles.maneuver}>Continue straight ahead</Text>
          </View>
        )}

        {nav.phase === 'rerouting' ? <Text style={styles.reroute}>Rerouting…</Text> : null}
        {nav.rerouteFailed && nav.phase === 'navigating' ? (
          <Text style={styles.reroute}>Can’t reroute — continue on the line</Text>
        ) : null}
        {state?.wrongBranch && nav.phase === 'navigating' ? (
          <Text style={styles.reroute}>Check route — you may have taken a different turn</Text>
        ) : null}

        {state && nav.phase !== 'arrived' ? (
          <>
            <View style={styles.tripRow}>
              <View style={styles.etaBlock}>
                <Text style={styles.eta}>{formatEta(state.etaEpochMs)}</Text>
                <Text style={styles.etaLabel}>Arrival</Text>
              </View>
              <Text style={styles.summary} numberOfLines={1}>
                {formatDuration(state.timeRemainingMs)} · {formatDistance(state.distanceRemainingM)}{' '}
                remaining
              </Text>
            </View>
            <View style={styles.progressTrack}>
              <View
                style={[
                  styles.progressFill,
                  { width: `${Math.round(Math.min(1, Math.max(0, state.routeProgress)) * 100)}%` },
                ]}
              />
            </View>
          </>
        ) : null}
      </View>

      <View style={styles.actionRow}>
        {moving && !canDeclareArrival ? (
          <View
            style={styles.speedGroup}
            accessibilityLabel={`Current speed ${speed ?? 0} kilometers per hour`}
          >
            <View style={styles.speedReadout}>
              <Text style={styles.speedValue}>{speed ?? 0}</Text>
              <Text style={styles.speedUnit}>km/h</Text>
            </View>
            {/* Absent wherever the map data has no limit — an honest gap beats
                a stale number the driver might trust. */}
            {speedLimit != null ? (
              <View style={styles.speedLimitSign}>
                <Text style={styles.speedLimitValue}>{speedLimit}</Text>
              </View>
            ) : null}
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
              accessibilityRole="button"
              accessibilityLabel={nav.muted ? 'Unmute guidance' : 'Mute guidance'}
              accessibilityState={{ selected: nav.muted }}
            >
              <AudioIcon muted={nav.muted} />
            </Pressable>
          ) : null}
          {canDeclareArrival ? (
            <Pressable
              style={styles.arrived}
              onPress={nav.arriveNow}
              testID="declare-arrived"
              accessibilityRole="button"
              accessibilityLabel="I am here"
            >
              <Text style={styles.stopText}>I&apos;ve arrived</Text>
            </Pressable>
          ) : null}
          <Pressable
            style={styles.stop}
            onPress={nav.stop}
            testID="stop-nav"
            accessibilityRole="button"
            accessibilityLabel={nav.phase === 'arrived' ? 'Done' : 'End navigation'}
          >
            <Text style={styles.stopText}>{nav.phase === 'arrived' ? 'Done' : 'End'}</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: 12, right: 12, gap: 10, alignItems: 'center' },
  card: {
    width: '100%',
    backgroundColor: theme.surfaceOverlay,
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 12,
    elevation: 7,
  },
  guidanceRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 14 },
  turnPanel: {
    width: 60,
    height: 60,
    borderRadius: 17,
    backgroundColor: theme.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  maneuverText: { flex: 1, minWidth: 0, gap: 4, paddingTop: 1 },
  distanceTo: { color: theme.accent, fontSize: 17, fontWeight: '800', lineHeight: 20 },
  maneuver: { color: theme.text, fontSize: 20, fontWeight: '700', lineHeight: 24 },
  exitSign: {
    alignSelf: 'flex-start',
    backgroundColor: '#1f7a3f',
    color: '#fff',
    borderRadius: 5,
    paddingHorizontal: 7,
    paddingVertical: 1,
    fontSize: 13,
    fontWeight: '700',
    overflow: 'hidden',
  },
  lanesScroll: { marginTop: 10, marginLeft: 74 },
  lanes: { flexGrow: 1, gap: 5 },
  lane: {
    minWidth: 34,
    maxWidth: 48,
    height: 44,
    flexGrow: 1,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 10,
    backgroundColor: theme.surfaceMuted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  laneCarrying: { borderColor: theme.accent, backgroundColor: theme.surfaceActive },
  laneActive: { borderWidth: 2, backgroundColor: theme.surfaceActive },
  thenRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minHeight: 34,
    marginTop: 10,
    marginLeft: 74,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 10,
    backgroundColor: theme.surfaceMuted,
  },
  thenLabel: {
    color: theme.textMuted,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.7,
    textTransform: 'uppercase',
  },
  thenText: { flex: 1, color: theme.text, fontSize: 13, fontWeight: '600' },
  stateBlock: { gap: 3, paddingHorizontal: 2, paddingVertical: 4 },
  eyebrow: {
    color: theme.accent,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  arrivalSummary: { color: theme.textMuted, fontSize: 14, fontWeight: '600', marginTop: 3 },
  tripRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    marginTop: 12,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.border,
  },
  etaBlock: { flexShrink: 0 },
  eta: { color: theme.text, fontSize: 19, fontWeight: '800', lineHeight: 20 },
  etaLabel: {
    color: theme.textMuted,
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.6,
    marginTop: 3,
    textTransform: 'uppercase',
  },
  summary: { flexShrink: 1, color: theme.textMuted, fontSize: 13, fontWeight: '600' },
  progressTrack: {
    height: 3,
    borderRadius: 2,
    backgroundColor: theme.accentFaint,
    marginTop: 9,
    overflow: 'hidden',
  },
  progressFill: { height: 3, borderRadius: 2, backgroundColor: theme.accent },
  reroute: { color: theme.warning, fontSize: 13, fontWeight: '600', marginTop: 8, marginLeft: 74 },
  error: { color: theme.danger, fontSize: 15, fontWeight: '600' },
  actionRow: {
    maxWidth: '100%',
    minHeight: 50,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    backgroundColor: theme.surfaceOverlay,
    borderRadius: 27,
    paddingLeft: 12,
    paddingRight: 6,
    paddingVertical: 5,
    elevation: 5,
  },
  actionSpacer: { flex: 1 },
  actionButtons: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  speedGroup: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  speedReadout: { minWidth: 48, alignItems: 'center' },
  speedValue: { color: theme.text, fontWeight: '800', fontSize: 18, lineHeight: 19 },
  speedUnit: {
    color: theme.textMuted,
    fontWeight: '700',
    fontSize: 9,
    letterSpacing: 0.3,
    lineHeight: 12,
    textTransform: 'uppercase',
  },
  // The European posted-limit sign: red ring, white face, black number —
  // drawn, not themed, so it reads as road signage at a glance.
  speedLimitSign: {
    width: 38,
    height: 38,
    borderRadius: 19,
    borderWidth: 4,
    borderColor: '#d81e05',
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  speedLimitValue: { color: '#111', fontWeight: '800', fontSize: 15 },
  muteButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stop: {
    minHeight: 40,
    justifyContent: 'center',
    backgroundColor: theme.danger,
    borderRadius: 20,
    paddingHorizontal: 18,
  },
  // Completing the trip, not abandoning it — green against the red End beside it.
  arrived: {
    minHeight: 40,
    justifyContent: 'center',
    backgroundColor: '#1e8e3e',
    borderRadius: 20,
    paddingHorizontal: 16,
  },
  stopText: { color: '#fff', fontWeight: '700', fontSize: 15 },
});
