import { fmtClock, matchPlacesByName, type LatLng, type SearchResult } from '@atlas/core';
import {
  pathViaLabels,
  ROUTING_PROFILES,
  routePathToTrackData,
  type RoutePath,
} from '@atlas/routing';
import type { PlaceRecord } from '@atlas/storage';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Keyboard, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import type { LocalPack } from '../regions/packs';
import type { RoutePlanner } from '../routing/useRoute';
import type { TransitPlan } from '../routing/useTransit';
import { geoSearch, type SearchBias } from '../search/geoSearch';
import { ElevationChart } from './ElevationChart';
import { TransitResults } from './TransitResults';

function fmtKm(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
}

function fmtDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const min = Math.floor((total % 3600) / 60);
  return h > 0 ? `${h} h ${min} min` : `${min} min`;
}

const fmtEta = (timeMs: number): string => fmtClock(Date.now() + timeMs);

/** Alternative chip: the fastest shows its duration, others their extra minutes. */
function altChipLabel(paths: RoutePath[], i: number, vias: (string | null)[]): string {
  const extraMin = Math.round((paths[i]!.timeMs - paths[0]!.timeMs) / 60000);
  const head =
    i === 0 ? fmtDuration(paths[0]!.timeMs) : extraMin < 1 ? '+<1 min' : `+${extraMin} min`;
  const via = vias[i];
  return via ? `${head} via ${via}` : head;
}

/** Waypoint label, matching the map markers: A, B, C… (⟳ for a round trip). */
function waypointLabel(index: number, roundTrip: boolean, count: number): string {
  if (roundTrip || count === 1) return '⟳';
  return index < 26 ? String.fromCharCode(65 + index) : String(index + 1);
}

/**
 * What a stop row says it is. Lettered markers match the map pins and are right
 * for a multi-stop road route, but they are a riddle on the two-stop journey
 * people actually plan — "A" does not tell you it is where you are leaving
 * from. So the ends are named outright whenever there are only two of them,
 * which is also the only shape transit supports.
 */
function stopRole(index: number, count: number, roundTrip: boolean): string | null {
  if (roundTrip || count !== 2) return null;
  return index === 0 ? 'From' : 'To';
}

/** What a stop is called: its looked-up name, or coordinates when it has none. */
function stopTitle(w: { pos: LatLng; name?: string }): string {
  return w.name ?? `${w.pos.lat.toFixed(4)}, ${w.pos.lng.toFixed(4)}`;
}

interface StopHit {
  name: string;
  label: string;
  position: LatLng;
  /** True for the user's saved places — listed first, marked with a star. */
  saved: boolean;
}

/** Search box that adds a stop by name: saved places first, then addresses. */
function StopSearch({
  packs,
  places,
  getBias,
  placeholder,
  onPick,
}: {
  packs: LocalPack[];
  places: PlaceRecord[];
  /** Current map centre, to bias geocoder results towards the viewport. */
  getBias: SearchBias;
  /** Says which end this box fills, so the box is not a mystery slot. */
  placeholder: string;
  /** The hit's name rides along: a stop the user chose by name should keep it. */
  onPick: (position: LatLng, name: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<StopHit[]>([]);
  const generation = useRef(0);

  useEffect(() => {
    const q = query.trim();
    const gen = ++generation.current;
    if (q.length < 2) {
      setHits([]);
      return;
    }
    const timer = setTimeout(() => {
      void (async () => {
        const saved: StopHit[] = matchPlacesByName(places, q, 4).map((p) => ({
          name: p.name,
          label: 'Saved place',
          position: { lat: p.lat, lng: p.lng },
          saved: true,
        }));
        const { results } = await geoSearch(packs, q, getBias);
        const remote: StopHit[] = results.map((r: SearchResult) => ({
          name: r.name,
          label: r.label,
          position: r.position,
          saved: false,
        }));
        if (gen === generation.current) setHits([...saved, ...remote].slice(0, 6));
      })();
    }, 300);
    return () => clearTimeout(timer);
  }, [query, packs, places, getBias]);

  return (
    <View>
      <TextInput
        style={styles.stopInput}
        placeholder={placeholder}
        value={query}
        onChangeText={setQuery}
        autoCorrect={false}
        testID="route-stop-search"
      />
      {hits.length > 0 ? (
        <View style={styles.stopResults}>
          {hits.map((hit, i) => (
            <Pressable
              key={`${hit.position.lat}/${hit.position.lng}/${i}`}
              style={styles.stopResult}
              testID={`route-stop-result-${i}`}
              onPress={() => {
                Keyboard.dismiss();
                onPick(hit.position, hit.name);
                setQuery('');
                setHits([]);
              }}
            >
              <Text style={styles.stopResultName} numberOfLines={1}>
                {hit.saved ? '★ ' : ''}
                {hit.name}
              </Text>
              {hit.label ? (
                <Text style={styles.stopResultLabel} numberOfLines={1}>
                  {hit.label}
                </Text>
              ) : null}
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}

/**
 * Route-planning panel — the mobile counterpart of the web RoutePanel
 * (apps/web/src/routing/RoutePanel.tsx). Bottom-docked (not modal) so the map
 * stays tappable to add stops. Profile, round trip, stop search (addresses +
 * saved places), ordered stops (reorder with ▲/▼ since there's no drag on the
 * map list), reverse/optimize/clear, result stats, alternatives, and GPX
 * export via the OS share sheet.
 */
export function RoutePanel({
  route,
  transit,
  packs,
  places,
  getBias,
  onExport,
  onNavigate,
  getMyLocation,
  bottomInset = 0,
}: {
  route: RoutePlanner;
  /** Public transport for this plan — a travel mode beside the road profiles. */
  transit: TransitPlan;
  /** Downloaded packs — the stop search falls back to their FTS index offline. */
  packs: LocalPack[];
  /** Saved places, offered in the stop search alongside geocoder results. */
  places: PlaceRecord[];
  /** Current map centre, to bias the stop search towards the viewport. */
  getBias: SearchBias;
  /** Share the selected path as GPX; App owns the build+share. */
  onExport: (path: RoutePath) => void;
  /**
   * Start turn-by-turn to the last stop in the current profile. This panel is
   * the only place a travel mode is chosen, so it is also the only place
   * guidance starts from — the place card just points here.
   */
  onNavigate: (destination: LatLng) => void;
  /** A GPS fix for the "My location" shortcut, or null when unavailable. */
  getMyLocation: () => Promise<LatLng | null>;
  bottomInset?: number;
}) {
  const transitMode = transit.enabled;
  const path = route.paths?.[route.selectedPath] ?? null;
  // "via …" labels distinguishing the alternatives (needs instructions).
  const vias = useMemo(() => (route.paths ? pathViaLabels(route.paths) : []), [route.paths]);
  const [profileOpen, setProfileOpen] = useState(false);
  // Server routes carry elevation (DEM); offline-pack routes don't — no chart then.
  const hasElevation = path?.points.some((p) => p.ele !== undefined) ?? false;
  const profileData = useMemo(
    () => (path && hasElevation ? routePathToTrackData(path, 'route') : null),
    [path, hasElevation],
  );

  const [locating, setLocating] = useState(false);
  const [locateFailed, setLocateFailed] = useState(false);
  const stops = route.waypoints;
  // Which end the *search box* fills: the first stop is the start, anything
  // after it extends the route, which in transit mode means the destination.
  // The My-location button is deliberately not governed by this — see below.
  const nextRole = stops.length === 0 ? 'start' : 'destination';

  /**
   * Put the current position at the front of the plan. Always the start, never
   * the destination: "navigate to where I already am" is not a journey anyone
   * plans, and a control whose meaning flips with the stop count is worse than
   * one that does a single predictable thing.
   */
  const addMyLocation = async () => {
    setLocating(true);
    setLocateFailed(false);
    try {
      const here = await getMyLocation();
      if (!here) {
        setLocateFailed(true);
        return;
      }
      if (stops.length === 0) route.addWaypoint(here, 'My location');
      else route.insertWaypoint(0, here, 'My location');
    } finally {
      setLocating(false);
    }
  };

  // Guidance needs somewhere to go; the last stop is it.
  const destination = stops.length > 0 ? stops[stops.length - 1]!.pos : null;

  return (
    <View style={styles.panel}>
      {/* The header stays out of the scroller so the close button is always
          reachable, however long the journey board below it grows. */}
      <View style={styles.headerRow}>
        <Text style={styles.heading}>{transitMode ? 'Public transport' : 'Route'}</Text>
        {route.loading ? <Text style={styles.muted}>Routing…</Text> : null}
        <Pressable style={styles.closeX} onPress={route.stop} testID="route-close">
          <Text style={styles.closeXText}>✕</Text>
        </Pressable>
      </View>

      {/* Everything below scrolls. Without this the panel clipped at its own
          max height and a journey board of five options was simply unreachable
          — the results existed but could not be read. `handled` keeps a tap on
          a search result working while the keyboard is still up. */}
      <ScrollView
        style={styles.body}
        contentContainerStyle={[styles.bodyContent, { paddingBottom: bottomInset + 12 }]}
        keyboardShouldPersistTaps="handled"
        testID="route-scroll"
      >
        <View style={styles.chipRow}>
          {ROUTING_PROFILES.map((p) => (
            <Pressable
              key={p.id}
              style={[styles.chip, !transitMode && p.id === route.profile && styles.chipSelected]}
              onPress={() => {
                transit.setEnabled(false);
                route.setProfile(p.id);
              }}
              testID={`route-profile-${p.id}`}
            >
              <Text style={styles.chipText}>
                {p.icon} {p.label}
              </Text>
            </Pressable>
          ))}
          {/* Transit is a travel mode, not a fifth routing profile — and it is
            offered only where the national planner can actually answer. */}
          {transit.offered ? (
            <Pressable
              style={[styles.chip, transitMode && styles.chipSelected]}
              onPress={() => transit.setEnabled(true)}
              testID="route-profile-transit"
            >
              <Text style={styles.chipText}>🚌 Transit</Text>
            </Pressable>
          ) : null}
        </View>

        <View style={styles.roundRow}>
          {/* A timetable has no notion of a loop, so the whole round-trip control
            stands down in transit mode rather than sitting there inert. */}
          {!transitMode ? (
            <Pressable
              style={[styles.chip, route.roundTrip && styles.chipSelected]}
              onPress={() => route.setRoundTrip(!route.roundTrip)}
              testID="route-roundtrip"
            >
              <Text style={styles.chipText}>Round trip</Text>
            </Pressable>
          ) : null}
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

        <StopSearch
          packs={packs}
          places={places}
          getBias={getBias}
          placeholder={
            nextRole === 'start'
              ? 'Start: address or saved place'
              : 'Destination: address or saved place'
          }
          onPick={(position, name) => route.addWaypoint(position, name)}
        />

        <View style={styles.sourceRow}>
          <Pressable
            style={[styles.chip, locating && styles.chipBusy]}
            disabled={locating}
            onPress={() => void addMyLocation()}
            testID="route-my-location"
          >
            <Text style={styles.chipText}>{locating ? 'Locating…' : '◎ My location as start'}</Text>
          </Pressable>
          <Text style={styles.hint}>or tap the map</Text>
        </View>
        {/* A silent no-op would read as a dead button; say why nothing happened. */}
        {locateFailed ? (
          <Text style={styles.muted}>
            No location fix — check location permission, or tap the map.
          </Text>
        ) : null}

        {route.waypoints.length > 0 ? (
          <View style={styles.wpList}>
            {route.waypoints.map((w, i) => (
              <View key={w.id} style={styles.wpRow}>
                {stopRole(i, route.waypoints.length, route.roundTrip) ? (
                  <Text style={styles.wpRole}>
                    {stopRole(i, route.waypoints.length, route.roundTrip)}
                  </Text>
                ) : (
                  <Text style={styles.wpLabel}>
                    {waypointLabel(i, route.roundTrip, route.waypoints.length)}
                  </Text>
                )}
                <Text style={styles.wpName} numberOfLines={1}>
                  {stopTitle(w)}
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
          </View>
        ) : (
          <Text style={styles.muted}>
            {route.roundTrip
              ? 'Set the starting point above, or tap the map.'
              : 'Add a start and a destination above, or tap the map.'}
          </Text>
        )}

        {/* Via points cannot be honoured by a timetable, so say so rather than
          quietly planning between the ends only. */}
        {transitMode && route.waypoints.length > 2 ? (
          <Text style={styles.muted}>
            Public transport is planned between the first and last stop — stops in between are
            ignored.
          </Text>
        ) : null}

        {/* This panel is the only travel-mode picker in the app, so guidance
          starts here. Transit has no turn-by-turn, so it shows the board below
          instead of a button that would promise directions it cannot give. */}
        {!transitMode ? (
          <Pressable
            style={[styles.navigate, !destination && styles.buttonDisabled]}
            disabled={!destination}
            onPress={() => destination && onNavigate(destination)}
            testID="route-navigate"
          >
            <Text style={styles.navigateText}>Start navigation</Text>
          </Pressable>
        ) : null}

        <View style={styles.actionRow}>
          <Pressable
            style={[styles.button, styles.buttonQuiet]}
            disabled={transitMode || route.roundTrip || route.waypoints.length < 2}
            onPress={route.reverse}
          >
            <Text style={styles.buttonQuietText}>Reverse</Text>
          </Pressable>
          <Pressable
            style={[styles.button, styles.buttonQuiet]}
            disabled={transitMode || route.roundTrip || route.waypoints.length < 4}
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
          {/* A journey is legs and times, not a track — there is nothing to export
            as GPX, so the button goes dead rather than writing a lie. */}
          <Pressable
            style={[
              styles.button,
              styles.buttonQuiet,
              (!path || transitMode) && styles.buttonDisabled,
            ]}
            disabled={!path || transitMode}
            onPress={() => path && onExport(path)}
            testID="route-export"
          >
            <Text style={styles.buttonQuietText}>Export GPX</Text>
          </Pressable>
        </View>

        {transitMode ? <TransitResults transit={transit} /> : null}

        {!transitMode && route.error ? <Text style={styles.error}>{route.error}</Text> : null}
        {!transitMode && path ? (
          <View style={styles.statsRow}>
            <Text style={styles.stats}>
              {fmtKm(path.distanceM)} · {fmtDuration(path.timeMs)} · ETA {fmtEta(path.timeMs)} · ↗{' '}
              {Math.round(path.ascentM)} m ↘ {Math.round(path.descentM)} m
            </Text>
            {profileData ? (
              <Pressable
                style={[styles.chip, profileOpen && styles.chipSelected]}
                onPress={() => setProfileOpen((o) => !o)}
                testID="route-profile-toggle"
              >
                <Text style={styles.chipText}>Profile</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
        {!transitMode && profileOpen && profileData ? <ElevationChart data={profileData} /> : null}
        {!transitMode && route.paths && route.paths.length > 1 ? (
          <View style={styles.chipRow}>
            {route.paths.map((p, i) => (
              <Pressable
                key={i}
                style={[styles.chip, i === route.selectedPath && styles.chipSelected]}
                onPress={() => route.selectPath(i)}
                testID={`route-alt-${i}`}
              >
                <Text style={styles.chipText}>
                  {altChipLabel(route.paths!, i, vias)} · {fmtKm(p.distanceM)}
                </Text>
              </Pressable>
            ))}
          </View>
        ) : null}
      </ScrollView>
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
    paddingHorizontal: 16,
    paddingTop: 16,
    elevation: 12,
    // Taller than the old 60 %: a journey board carries five options with legs
    // expanded under them. It scrolls either way, but at 60 % it scrolled
    // almost immediately, which reads as a broken panel rather than a full one.
    maxHeight: '85%',
  },
  body: { flexShrink: 1 },
  bodyContent: { gap: 8, paddingTop: 8 },
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
  // No maxHeight any more: the panel's own scroller owns the overflow, and a
  // nested one here would fight it for the gesture.
  wpList: {},
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
  wpRole: {
    minWidth: 44,
    paddingHorizontal: 8,
    height: 26,
    borderRadius: 13,
    backgroundColor: '#1a73e8',
    color: '#fff',
    textAlign: 'center',
    lineHeight: 26,
    fontSize: 12,
    fontWeight: '700',
  },
  wpName: { flexGrow: 1, flexShrink: 1, fontSize: 14, color: '#223' },
  sourceRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  chipBusy: { opacity: 0.6 },
  hint: { fontSize: 12, color: '#889' },
  navigate: {
    backgroundColor: '#1a73e8',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
  navigateText: { color: '#fff', fontWeight: '700', fontSize: 15 },
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
  statsRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  stats: { fontSize: 14, color: '#111', fontWeight: '600', flexShrink: 1 },
  stopInput: {
    borderWidth: 1,
    borderColor: '#cdd3dd',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
    fontSize: 14,
    color: '#111',
  },
  stopResults: {
    borderWidth: 1,
    borderColor: '#e2e6ee',
    borderRadius: 8,
    marginTop: 4,
    paddingVertical: 2,
  },
  stopResult: { paddingHorizontal: 10, paddingVertical: 6 },
  stopResultName: { fontSize: 14, color: '#111', fontWeight: '600' },
  stopResultLabel: { fontSize: 11, color: '#778' },
});
