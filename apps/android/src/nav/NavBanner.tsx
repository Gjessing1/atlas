import type { NavController, NavFollowMode } from '@atlas/app-hooks';
import { fmtDistanceM, type NavWidgetId } from '@atlas/core';
import { fmtClock } from '@atlas/core';
import {
  backToTrack,
  laneGlyphs,
  laneLabel,
  remainingAscentM,
  shortManeuverText,
} from '@atlas/navigation';
import { formatExitSign, ROUTING_PROFILES, type RouteLane } from '@atlas/routing';
import { formatTrafficDelay } from '@atlas/traffic';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import { MapOverviewIcon, NavArrowIcon } from '../ui/icons';
import { theme } from '../ui/theme';
import type { NavViewport } from './navViewport';
import { TurnIcon } from './TurnIcon';
import type { NavCameraControls } from './useNavCamera';

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

function widgetValue(widget: NavWidgetId, nav: NavController): { value: string; unit: string } {
  switch (widget) {
    case 'speed':
      return { value: String(speedKph(nav.speedMps) ?? 0), unit: 'km/h' };
    case 'altitude':
      return {
        value: nav.altitudeM === null ? '—' : String(Math.round(nav.altitudeM)),
        unit: 'altitude m',
      };
    case 'ascent': {
      // Climb still ahead — the number that matters on a hike. An honest dash
      // where the route carries no elevation (offline packs have no DEM).
      const ascent = nav.activePath
        ? remainingAscentM(nav.activePath.points, nav.state?.traveledM ?? 0)
        : null;
      return { value: ascent === null ? '—' : String(ascent), unit: 'climb m' };
    }
    case 'next-turn':
      return {
        value: nav.state?.upcoming ? fmtDistanceM(nav.state.upcoming.distanceToM) : '—',
        unit: 'next turn',
      };
    case 'remaining':
      return {
        value: nav.state ? fmtDistanceM(nav.state.distanceRemainingM) : '—',
        unit: 'remaining',
      };
  }
}

function LaneRow({ lanes, compact }: { lanes: RouteLane[]; compact: boolean }) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={[styles.lanesScroll, compact && styles.lanesScrollCompact]}
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
              compact && styles.laneCompact,
              carrying && styles.laneCarrying,
              lane.state === 'active' && styles.laneActive,
            ]}
            accessible
            accessibilityLabel={`Lane ${index + 1}: ${laneLabel(lane)}`}
          >
            <Svg width={compact ? 21 : 25} height={compact ? 28 : 34} viewBox="0 0 24 32">
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
  bottomInset = 0,
  viewport,
  navCam,
  followMode,
  onToggleFollowMode,
  widgets,
  onAddStop,
  onHeight,
  onRect,
}: {
  nav: NavController;
  topInset?: number;
  bottomInset?: number;
  viewport: NavViewport;
  navCam: NavCameraControls;
  followMode: NavFollowMode;
  onToggleFollowMode: () => void;
  widgets: NavWidgetId[];
  /** Open the quick add-a-stop sheet (gas, charging, food). */
  onAddStop: () => void;
  /** Reports the banner's laid-out height so siblings can sit clear of it. */
  onHeight?: (height: number) => void;
  /**
   * Reports where the banner sits in the window (dp) — picture-in-picture
   * shrinks the activity into exactly this rectangle, so the transition folds
   * up the guidance rather than the whole screen.
   */
  onRect?: (rect: { x: number; y: number; width: number; height: number }) => void;
}) {
  // The preview phase has its own bottom card (RoutePreview) — no banner.
  if (nav.phase === 'idle' || nav.phase === 'preview') return null;
  // Landscape: park guidance on the leading side so the road ahead owns the
  // trailing map pane. In portrait the same card spans the usable width.
  const { landscape } = viewport;

  const { state } = nav;
  const maneuver = state?.upcoming;
  const guiding = nav.phase === 'navigating' || nav.phase === 'rerouting';
  const exploring = nav.phase === 'exploring';
  const moving = guiding || exploring;
  const sustain = guiding ? (state?.sustain ?? null) : null;
  const walking = nav.profile === 'foot' || nav.profile === 'hike';
  // No speed-limit roundel on foot: the 80 km/h sign on the road a footpath
  // parallels is driving furniture, not guidance.
  const speedLimit = guiding && !walking ? (state?.speedLimitKph ?? null) : null;
  // Walking modes offer the reroute instead of performing it — and for the
  // hiker who lost the trail with no network, the straight line back to it is
  // the half that still works offline.
  const trackBack =
    nav.rerouteOffered && state && nav.activePath
      ? backToTrack(nav.activePath.points, state.raw)
      : null;
  const trackWord = nav.profile === 'hike' ? 'trail' : 'route';
  // The manual way out, offered only near the destination — where the automatic
  // rules can fail (a fix that never gets accurate enough in a car park) and
  // where "I've arrived" is the one thing the traveller knows better than we do.
  // Deliberately distinct from End: this completes the trip rather than
  // abandoning it, so it banks the summary.
  const canDeclareArrival = guiding && state != null && state.distanceRemainingM <= 150;
  // "then …" hint when the maneuver after the current one follows hot on its
  // heels — or the distant maneuver demoted below a long-road sustain cue.
  const thenManeuver =
    sustain && maneuver
      ? maneuver
      : maneuver && state?.then && state.then.distanceToM - maneuver.distanceToM < 300
        ? state.then
        : null;
  const profileLabel = ROUTING_PROFILES.find((candidate) => candidate.id === nav.profile)?.label;
  const shownWidgets: NavWidgetId[] = exploring ? ['speed', 'altitude'] : widgets;

  return (
    <View
      style={[
        styles.wrap,
        {
          top: topInset + 8,
          bottom: bottomInset + 12,
          left: viewport.guidanceLeft,
          width: viewport.guidanceWidth,
        },
      ]}
      pointerEvents="box-none"
    >
      <View
        style={[styles.card, landscape && styles.cardCompact]}
        onLayout={(e) => {
          const { x, y, width, height } = e.nativeEvent.layout;
          onHeight?.(height);
          // The card is laid out inside the absolutely positioned wrap above,
          // so its window position is that wrap's offset plus its own.
          onRect?.({ x: viewport.guidanceLeft + x, y: topInset + 8 + y, width, height });
        }}
      >
        {exploring ? (
          <View style={styles.stateBlock}>
            <Text style={styles.eyebrow}>Explorer mode</Text>
            <Text style={styles.maneuver}>
              {nav.position
                ? `${profileLabel ?? 'Travel'} · Following your position`
                : 'Finding your position…'}
            </Text>
            <Text style={styles.arrivalSummary}>No destination or turn-by-turn guidance</Text>
          </View>
        ) : nav.phase === 'starting' ? (
          <View style={styles.stateBlock}>
            <Text style={styles.eyebrow}>Navigation</Text>
            <Text style={styles.maneuver}>Finding the best route…</Text>
          </View>
        ) : nav.phase === 'error' ? (
          <View style={styles.stateBlock}>
            <Text style={styles.eyebrow}>
              {nav.activity === 'explorer' ? 'Explorer unavailable' : 'Navigation unavailable'}
            </Text>
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
              <View style={[styles.turnPanel, landscape && styles.turnPanelCompact]}>
                <TurnIcon
                  instruction={sustain ? { sign: 0 } : maneuver.instruction}
                  size={landscape ? 36 : 44}
                  color="#fff"
                />
              </View>
              <View style={styles.maneuverText}>
                <Text style={[styles.distanceTo, landscape && styles.distanceToCompact]}>
                  {sustain
                    ? `Continue for ${formatDistance(sustain.distanceRemainingM)}`
                    : `In ${formatDistance(maneuver.distanceToM)}`}
                </Text>
                <Text
                  style={[styles.maneuver, landscape && styles.maneuverCompact]}
                  numberOfLines={landscape ? 1 : 2}
                >
                  {sustain ? sustain.road : shortManeuverText(maneuver.instruction)}
                </Text>
                {!sustain && maneuver.instruction.exitSign ? (
                  <Text style={styles.exitSign} numberOfLines={1}>
                    {formatExitSign(maneuver.instruction.exitSign)}
                  </Text>
                ) : null}
              </View>
            </View>
            {state?.laneGuidance ? (
              <LaneRow lanes={state.laneGuidance} compact={landscape} />
            ) : null}
            {thenManeuver ? (
              <View style={[styles.thenRow, landscape && styles.thenRowCompact]}>
                <Text style={styles.thenLabel}>Then</Text>
                <TurnIcon instruction={thenManeuver.instruction} size={20} color={theme.icon} />
                <Text style={styles.thenText} numberOfLines={1}>
                  {shortManeuverText(thenManeuver.instruction)}
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
        {nav.rerouteOffered ? (
          <View style={styles.offRouteRow}>
            <Text style={styles.offRouteText} numberOfLines={2}>
              Off route
              {trackBack
                ? ` — ${trackWord} is ${fmtDistanceM(trackBack.distanceM)} ${trackBack.cardinal}`
                : ''}
            </Text>
            <Pressable
              style={styles.offRouteButton}
              onPress={nav.rerouteNow}
              testID="reroute-now"
              accessibilityRole="button"
              accessibilityLabel="Reroute from here"
            >
              <Text style={styles.offRouteButtonText}>Reroute</Text>
            </Pressable>
          </View>
        ) : null}
        {nav.rerouteFailed && nav.phase === 'navigating' ? (
          <Text style={styles.reroute}>
            {nav.rerouteOffered
              ? // The offline-hike case: no new line is coming, and the offer
                // row above still points the way back to the track.
                'Can’t reroute — no connection'
              : 'Can’t reroute — continue on the line'}
          </Text>
        ) : null}
        {nav.fasterRoute && nav.phase === 'navigating' ? (
          <View style={styles.fasterRow}>
            <Text style={styles.fasterText} numberOfLines={2}>
              Faster route — saves {formatDuration(nav.fasterRoute.savesMs)}
            </Text>
            <Pressable
              style={styles.fasterSwitch}
              onPress={nav.acceptFasterRoute}
              testID="faster-switch"
              accessibilityRole="button"
              accessibilityLabel="Switch to the faster route"
            >
              <Text style={styles.fasterSwitchText}>Switch</Text>
            </Pressable>
            <Pressable
              onPress={nav.dismissFasterRoute}
              hitSlop={10}
              testID="faster-dismiss"
              accessibilityRole="button"
              accessibilityLabel="Keep the current route"
            >
              <Text style={styles.fasterDismiss}>✕</Text>
            </Pressable>
          </View>
        ) : null}
        {state?.wrongBranch && nav.phase === 'navigating' ? (
          <Text style={styles.reroute}>Check route — you may have taken a different turn</Text>
        ) : null}

        {state && nav.phase !== 'arrived' ? (
          <>
            {/* Time left leads: mid-drive "12 min" is the number the driver is
                actually deciding on — unlabelled, because a duration in a
                guidance banner can only mean time remaining. Arrival clock
                next, distance last. Landscape has no vertical room to spare,
                so the same order collapses onto one line. */}
            <View style={[styles.tripRow, landscape && styles.tripRowCompact]}>
              {landscape ? (
                <Text style={styles.summaryCompact} numberOfLines={1}>
                  <Text style={styles.etaInline}>{formatDuration(state.timeRemainingMs)}</Text>
                  {'  '}
                  {formatEta(state.etaEpochMs)} · {formatDistance(state.distanceRemainingM)}
                </Text>
              ) : (
                <>
                  <Text style={styles.eta}>{formatDuration(state.timeRemainingMs)}</Text>
                  <Text style={styles.summary} numberOfLines={1}>
                    {formatEta(state.etaEpochMs)} arrival ·{' '}
                    {formatDistance(state.distanceRemainingM)}
                  </Text>
                </>
              )}
              {/* The measured part of the time beside it — only ever the
                  traffic still ahead, so it disappears as the queue is driven
                  through, and it explains an ETA that moved without the driver
                  doing anything. */}
              {formatTrafficDelay(state.trafficDelayMs) ? (
                <Text style={styles.trafficDelay} numberOfLines={1}>
                  {formatTrafficDelay(state.trafficDelayMs)}
                </Text>
              ) : null}
            </View>
            <View style={[styles.progressTrack, landscape && styles.progressTrackCompact]}>
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

      {/* These map-view controls are part of the guidance layout, rather than
          a second absolutely-positioned overlay. The card, controls and
          driving actions therefore share one collision boundary. Portrait
          uses the familiar right-edge stack; landscape turns it into one
          compact row directly below the guidance card. */}
      {moving ? (
        <View
          style={[
            styles.mapControlsSlot,
            landscape ? styles.mapControlsSlotLandscape : styles.mapControlsSlotPortrait,
          ]}
        >
          <View
            style={[
              styles.mapControlGroup,
              landscape && styles.mapControlGroupLandscape,
              exploring && styles.mapControlGroupExplorer,
            ]}
          >
            <Pressable
              style={styles.mapControlButton}
              onPress={onToggleFollowMode}
              testID="toggle-orientation"
              accessibilityRole="button"
              accessibilityLabel={
                followMode === 'course' ? 'Switch to north-up' : 'Switch to course-up'
              }
            >
              {followMode === 'north' ? (
                <Text style={styles.orientText}>N</Text>
              ) : (
                <NavArrowIcon notchColor={theme.surfaceOverlay} />
              )}
            </Pressable>
            {guiding ? (
              <>
                <View
                  style={[styles.mapControlDivider, landscape && styles.mapControlDividerLandscape]}
                />
                <Pressable
                  style={[
                    styles.mapControlButton,
                    navCam.overview && styles.mapControlButtonActive,
                  ]}
                  onPress={navCam.toggleOverview}
                  testID="toggle-overview"
                  accessibilityRole="button"
                  accessibilityLabel={
                    navCam.overview ? 'Back to follow view' : 'Show route overview'
                  }
                  accessibilityState={{ selected: navCam.overview }}
                >
                  <MapOverviewIcon />
                </Pressable>
                <View
                  style={[styles.mapControlDivider, landscape && styles.mapControlDividerLandscape]}
                />
                <Pressable
                  style={styles.mapControlButton}
                  onPress={onAddStop}
                  testID="nav-add-stop"
                  accessibilityRole="button"
                  accessibilityLabel="Add a stop"
                >
                  <Svg width={22} height={22} viewBox="0 0 24 24">
                    <Path
                      d="M12 5v14M5 12h14"
                      fill="none"
                      stroke={theme.text}
                      strokeWidth={1.9}
                      strokeLinecap="round"
                    />
                  </Svg>
                </Pressable>
              </>
            ) : null}
          </View>
        </View>
      ) : (
        <View style={styles.mapControlsSpacer} />
      )}

      <View style={[styles.actionRow, landscape && styles.actionRowLandscape]}>
        {moving && !canDeclareArrival ? (
          <View style={styles.speedGroup} accessibilityLabel="Navigation widgets">
            {shownWidgets.map((widget) => {
              const display = widgetValue(widget, nav);
              return (
                <View style={styles.speedDial} key={widget}>
                  <Text style={styles.speedValue}>{display.value}</Text>
                  <Text style={styles.speedUnit}>{display.unit}</Text>
                </View>
              );
            })}
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
          {guiding ? (
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
            accessibilityLabel={
              nav.phase === 'arrived' ? 'Done' : exploring ? 'End Explorer mode' : 'End navigation'
            }
          >
            <Text style={styles.stopText}>{nav.phase === 'arrived' ? 'Done' : 'End'}</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // Position and width come from the shared navigation viewport. Card, view
  // controls and driving actions deliberately live in one layout tree.
  wrap: { position: 'absolute', alignItems: 'stretch' },
  card: {
    width: '100%',
    backgroundColor: theme.surfaceOverlay,
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 12,
    elevation: 7,
  },
  // Landscape screens are short — the card gives back every dp it can.
  cardCompact: { borderRadius: 16, paddingHorizontal: 12, paddingTop: 10, paddingBottom: 8 },
  guidanceRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 14 },
  turnPanel: {
    width: 60,
    height: 60,
    borderRadius: 17,
    backgroundColor: theme.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  turnPanelCompact: { width: 48, height: 48, borderRadius: 14 },
  maneuverText: { flex: 1, minWidth: 0, gap: 4, paddingTop: 1 },
  distanceTo: { color: theme.accent, fontSize: 17, fontWeight: '800', lineHeight: 20 },
  distanceToCompact: { fontSize: 15, lineHeight: 18 },
  maneuver: { color: theme.text, fontSize: 20, fontWeight: '700', lineHeight: 24 },
  maneuverCompact: { fontSize: 17, lineHeight: 21 },
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
  lanesScrollCompact: { marginTop: 7, marginLeft: 62 },
  lanes: { flexGrow: 1, gap: 5 },
  laneCompact: { minWidth: 28, maxWidth: 40, height: 36 },
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
  thenRowCompact: { minHeight: 28, marginTop: 7, marginLeft: 62, paddingVertical: 3 },
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
  tripRowCompact: { marginTop: 8, paddingTop: 7 },
  summaryCompact: { color: theme.textMuted, fontSize: 13, fontWeight: '600' },
  etaInline: { color: theme.text, fontSize: 15, fontWeight: '800' },
  eta: { flexShrink: 0, color: theme.text, fontSize: 19, fontWeight: '800', lineHeight: 22 },
  summary: { flexShrink: 1, color: theme.textMuted, fontSize: 13, fontWeight: '600' },
  // Warning-coloured, like the planner's: the part of the ETA the road decided
  // rather than the router. Pushed to the end of the row and never shrunk —
  // "+12 min traffic" clipped to "+12 min" would read as the time remaining.
  trafficDelay: {
    flexShrink: 0,
    marginLeft: 'auto',
    color: theme.warning,
    fontSize: 13,
    fontWeight: '700',
  },
  progressTrack: {
    height: 3,
    borderRadius: 2,
    backgroundColor: theme.accentFaint,
    marginTop: 9,
    overflow: 'hidden',
  },
  progressTrackCompact: { marginTop: 6 },
  progressFill: { height: 3, borderRadius: 2, backgroundColor: theme.accent },
  reroute: { color: theme.warning, fontSize: 13, fontWeight: '600', marginTop: 8, marginLeft: 74 },
  // Walking modes: off-route is an offer ("Reroute?"), never a silent
  // recalculation — with the bearing back to the track alongside, which is
  // the half that still works offline.
  offRouteRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    marginTop: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: 'rgba(255, 196, 107, 0.14)',
  },
  offRouteText: { color: theme.warning, fontSize: 13, fontWeight: '600', flexShrink: 1 },
  offRouteButton: {
    backgroundColor: theme.accent,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 6,
  },
  offRouteButtonText: { color: '#fff', fontSize: 13, fontWeight: '700' },
  // The faster-route watch found a better line: an offer, never a silent swap.
  fasterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: theme.surfaceActive,
  },
  fasterText: { flex: 1, color: theme.accent, fontSize: 13, fontWeight: '600' },
  fasterSwitch: {
    backgroundColor: theme.accent,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 6,
  },
  fasterSwitchText: { color: '#fff', fontSize: 13, fontWeight: '700' },
  fasterDismiss: { color: theme.textMuted, fontSize: 16, paddingHorizontal: 2 },
  error: { color: theme.danger, fontSize: 15, fontWeight: '600' },
  mapControlsSlot: { flex: 1, paddingTop: 10 },
  mapControlsSlotPortrait: { minHeight: 106, alignItems: 'flex-end' },
  mapControlsSlotLandscape: { minHeight: 58, alignItems: 'flex-start' },
  mapControlsSpacer: { flex: 1 },
  mapControlGroup: {
    width: 48,
    borderRadius: 24,
    backgroundColor: theme.surfaceOverlay,
    overflow: 'hidden',
    elevation: 5,
  },
  mapControlGroupLandscape: { width: 144, flexDirection: 'row' },
  mapControlGroupExplorer: { width: 48 },
  mapControlButton: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
  mapControlButtonActive: { backgroundColor: theme.surfaceActive },
  mapControlDivider: {
    height: StyleSheet.hairlineWidth,
    marginHorizontal: 10,
    backgroundColor: theme.border,
  },
  mapControlDividerLandscape: {
    width: StyleSheet.hairlineWidth,
    height: 28,
    marginHorizontal: 0,
    marginVertical: 10,
  },
  orientText: { fontSize: 18, fontWeight: '800', color: theme.accent },
  // No bar behind the controls — every control is its own floating chip, so the
  // map shows through the gaps between them.
  actionRow: {
    flexShrink: 0,
    maxWidth: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  actionRowLandscape: { minHeight: 46 },
  actionSpacer: { flex: 1 },
  actionButtons: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  speedGroup: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  // The driver's own speed: a round dial mirroring the posted-limit sign beside it.
  speedDial: {
    width: 46,
    height: 46,
    borderRadius: 23,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.surfaceOverlay,
    elevation: 5,
  },
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
    width: 46,
    height: 46,
    borderRadius: 23,
    borderWidth: 5,
    borderColor: '#d81e05',
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 5,
  },
  speedLimitValue: { color: '#111', fontWeight: '800', fontSize: 17 },
  muteButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.surfaceOverlay,
    elevation: 5,
  },
  stop: {
    minHeight: 44,
    justifyContent: 'center',
    backgroundColor: theme.danger,
    borderRadius: 22,
    paddingHorizontal: 18,
    elevation: 5,
  },
  // Completing the trip, not abandoning it — green against the red End beside it.
  arrived: {
    minHeight: 44,
    justifyContent: 'center',
    backgroundColor: '#1e8e3e',
    borderRadius: 22,
    paddingHorizontal: 16,
    elevation: 5,
  },
  stopText: { color: '#fff', fontWeight: '700', fontSize: 15 },
});
