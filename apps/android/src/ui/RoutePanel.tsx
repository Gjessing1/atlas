import {
  altChipLabel,
  detourLabel,
  fmtDuration,
  fmtEta,
  fmtKm,
  modeTimeLabel,
  stopHitKey,
  stopRole,
  stopTitle,
  waypointLabel,
  type LatLng,
} from '@atlas/core';
import { useAlongRouteSearch, useStopSearch, type StopGeocodeFn } from '@atlas/app-hooks';
import {
  pathViaLabels,
  ROUTING_PROFILES,
  routePathToTrackData,
  type RoutePath,
  type RoutePreferences,
} from '@atlas/routing';
import type { PlaceRecord } from '@atlas/storage';
import type { TransitTrip } from '@atlas/transit';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BackHandler,
  Keyboard,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import type { LocalPack } from '../regions/packs';
import type { RoutePlanner } from '../routing/useRoute';
import type { TransitPlan } from '../routing/useTransit';
import { geoSearch, type SearchBias } from '../search/geoSearch';
import { BottomSheet, type BottomSheetHandle } from './BottomSheet';
import { ElevationChart } from './ElevationChart';
import { PROFILE_ICON, TramIcon } from './modeIcons';
import { theme } from './theme';
import { TransitResults } from './TransitResults';

/**
 * Geocoding for the stop searches: the server's Photon proxy when reachable,
 * the downloaded packs' FTS index when it isn't — so a stop can be searched
 * for with no network at all. Viewport bias applies only to the free stop
 * search; an along-route search is already constrained by the route's bbox.
 */
function useGeocode(packs: LocalPack[], getBias: SearchBias): StopGeocodeFn {
  return useCallback(
    async ({ text, bbox, limit }) => {
      const { results } = await geoSearch(packs, text, bbox ? undefined : getBias, { bbox, limit });
      return results;
    },
    [packs, getBias],
  );
}

/** Search box that adds a stop by name: saved places first, then addresses. */
function StopSearch({
  places,
  geocode,
  placeholder,
  initialQuery = '',
  autoFocus = false,
  onPick,
  onCancel,
}: {
  places: PlaceRecord[];
  geocode: StopGeocodeFn;
  /** Says which end this box fills, so the box is not a mystery slot. */
  placeholder: string;
  /**
   * Pre-filled text when editing an existing stop. It is *selected* rather than
   * appended to, so the first keystroke replaces "My location" instead of
   * having to be backspaced away.
   */
  initialQuery?: string;
  autoFocus?: boolean;
  /** The hit's name rides along: a stop the user chose by name should keep it. */
  onPick: (position: LatLng, name: string) => void;
  /** Present when this box is editing an existing stop — leaves it unchanged. */
  onCancel?: () => void;
}) {
  const { query, setQuery, hits, reset } = useStopSearch({
    geocode,
    places,
    initialQuery,
    debounceMs: 300,
  });

  return (
    <View style={styles.stopSearch}>
      <View style={styles.stopInputRow}>
        <TextInput
          style={[styles.stopInput, styles.stopInputGrow]}
          placeholder={placeholder}
          value={query}
          onChangeText={setQuery}
          autoCorrect={false}
          disableFullscreenUI
          autoFocus={autoFocus}
          selectTextOnFocus
          testID="route-stop-search"
        />
        {onCancel ? (
          <Pressable
            style={styles.iconButton}
            onPress={() => {
              Keyboard.dismiss();
              onCancel();
            }}
            testID="route-stop-cancel"
          >
            <Text style={styles.iconText}>✕</Text>
          </Pressable>
        ) : null}
      </View>
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
                reset();
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

/** Offline-capable POI/saved-place search constrained to the selected route. */
function AlongRouteSearch({
  route,
  path,
  places,
  geocode,
}: {
  route: RoutePlanner;
  path: RoutePath;
  places: PlaceRecord[];
  geocode: StopGeocodeFn;
}) {
  const [open, setOpen] = useState(false);
  const { query, setQuery, hits, loading, reset } = useAlongRouteSearch({
    geocode,
    places,
    path,
    estimateDetours: route.estimateDetours,
    active: open,
    debounceMs: 300,
  });

  return (
    <View style={styles.alongSearch}>
      <Pressable
        style={[styles.alongToggle, open && styles.alongToggleSelected]}
        onPress={() => setOpen((value) => !value)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        testID="route-along-toggle"
      >
        <Text style={styles.alongToggleText}>Search along route</Text>
      </Pressable>
      {open ? (
        <>
          <TextInput
            style={styles.stopInput}
            placeholder="Fuel, food, or a saved place…"
            value={query}
            onChangeText={setQuery}
            autoCorrect={false}
            disableFullscreenUI
            autoFocus
            testID="route-along-search"
          />
          {loading ? <Text style={styles.hint}>Finding the smallest detours…</Text> : null}
          {!loading && query.trim().length >= 2 && hits.length === 0 ? (
            <Text style={styles.hint}>No matches near this route.</Text>
          ) : null}
          {hits.length > 0 ? (
            <View style={styles.stopResults}>
              {hits.map((hit, index) => (
                <Pressable
                  key={stopHitKey(hit)}
                  style={styles.stopResult}
                  testID={`route-along-result-${index}`}
                  onPress={() => {
                    Keyboard.dismiss();
                    route.insertWaypoint(hit.insertIndex, hit.position, hit.name);
                    setOpen(false);
                    reset();
                  }}
                >
                  <Text style={styles.stopResultName} numberOfLines={1}>
                    {hit.saved ? '★ ' : ''}
                    {hit.name}
                  </Text>
                  <Text style={styles.stopResultLabel} numberOfLines={1}>
                    {hit.label ? `${hit.label} · ` : ''}
                    {detourLabel(hit.extraTimeMs)} detour
                  </Text>
                </Pressable>
              ))}
            </View>
          ) : null}
        </>
      ) : null}
    </View>
  );
}

const CUSTOM_OPTIONS: readonly {
  key: keyof RoutePreferences;
  label: string;
  profiles: readonly string[];
}[] = [
  {
    key: 'avoidFerries',
    label: 'Avoid ferries',
    profiles: ['car', 'bike', 'foot', 'hike', 'run'],
  },
  { key: 'avoidHighways', label: 'Avoid highways', profiles: ['car'] },
  { key: 'avoidTolls', label: 'Avoid toll roads', profiles: ['car'] },
  { key: 'avoidHills', label: 'Flatter ways', profiles: ['bike', 'foot', 'hike', 'run'] },
  { key: 'preferTrails', label: 'Prefer trails', profiles: ['bike', 'hike', 'run'] },
];

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
  onShowTransitTrip,
  getMyLocation,
  locatingOrigin = false,
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
   * Start turn-by-turn to the last stop in the current profile, via the plan's
   * intermediate stops. This panel is the only place a travel mode is chosen,
   * so it is also the only place guidance starts from — the place card just
   * points here.
   */
  onNavigate: (destination: LatLng, viaPoints: LatLng[]) => void;
  /** Collapse the planner and frame this selected journey on the map. */
  onShowTransitTrip: (trip: TransitTrip) => void;
  /** A GPS fix for the "My location" shortcut, or null when unavailable. */
  getMyLocation: () => Promise<LatLng | null>;
  /** Directions opened before its automatic current-position lookup finished. */
  locatingOrigin?: boolean;
  bottomInset?: number;
}) {
  const sheetRef = useRef<BottomSheetHandle>(null);
  const geocode = useGeocode(packs, getBias);
  // True once a transit journey has been sent to the map (the panel collapsed
  // to a peek to uncover it). Back then re-opens the panel — returning to the
  // journey card — before a second Back closes the planner, instead of the
  // first Back throwing the whole plan away.
  const [tripOnMap, setTripOnMap] = useState(false);
  const transitMode = transit.enabled;
  const path = route.paths?.[route.selectedPath] ?? null;
  // Trip times sit under the mode icons only for a point-to-point plan, where
  // comparing modes makes sense; a loop or a single stop has nothing to compare.
  const showModeTimes = !route.roundTrip && route.waypoints.length >= 2;
  // Transit's chip time comes from its own board, not a costing; the board is
  // asked as soon as the plan has two ends, so this fills in alongside the
  // other modes rather than only after transit is picked.
  const transitTimeMs = transit.trips?.[0]?.durationMs;
  // "via …" labels distinguishing the alternatives (needs instructions).
  const vias = useMemo(() => (route.paths ? pathViaLabels(route.paths) : []), [route.paths]);
  const [profileOpen, setProfileOpen] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  // Server routes carry elevation (DEM); offline-pack routes don't — no chart then.
  const hasElevation = path?.points.some((p) => p.ele !== undefined) ?? false;
  const profileData = useMemo(
    () => (path && hasElevation ? routePathToTrackData(path, 'route') : null),
    [path, hasElevation],
  );

  const [locating, setLocating] = useState(false);
  const [locateFailed, setLocateFailed] = useState(false);
  /** Waypoint id whose search box is open for re-pointing, or null. */
  const [editing, setEditing] = useState<number | null>(null);
  const stops = route.waypoints;
  // A stop that disappears (cleared, removed, reversed away) must not leave an
  // orphaned editor bound to an id that no longer exists.
  useEffect(() => {
    if (editing !== null && !stops.some((w) => w.id === editing)) setEditing(null);
  }, [editing, stops]);

  // Leaving transit mode drops the "a trip is on the map" state so Back doesn't
  // spend a press re-opening a panel the user is no longer looking at a trip in.
  useEffect(() => {
    if (!transitMode) setTripOnMap(false);
  }, [transitMode]);

  // Back handling for the planner: while a journey is peeked open on the map,
  // the first Back brings the panel back up (the journey card the user came
  // from); otherwise Back closes the planner instead of falling through to
  // Android backgrounding the whole app. route.stop is read through a ref so
  // this only re-subscribes when the two-step state flips.
  const stopRef = useRef(route.stop);
  stopRef.current = route.stop;
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (tripOnMap) {
        setTripOnMap(false);
        sheetRef.current?.snapTo('half');
        return true;
      }
      stopRef.current();
      return true;
    });
    return () => sub.remove();
  }, [tripOnMap]);
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
    <BottomSheet
      ref={sheetRef}
      visible
      mode="map"
      onClose={route.stop}
      initialSnap="half"
      peekHeight={188}
      bottomInset={bottomInset}
      testID="route-sheet"
    >
      {/* The header stays out of the scroller so the close button is always
          reachable, however long the journey board below it grows. */}
      <View style={styles.headerRow}>
        <Text style={styles.heading}>{transitMode ? 'Public transport' : 'Route'}</Text>
        {locatingOrigin ? (
          <Text style={styles.muted}>Getting location…</Text>
        ) : route.loading ? (
          <Text style={styles.muted}>Routing…</Text>
        ) : null}
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
        contentContainerStyle={styles.bodyContent}
        keyboardShouldPersistTaps="handled"
        testID="route-scroll"
      >
        {/* Icon-only, the way every maps app picks a travel mode: five labelled
          chips wrapped onto two rows and read as a paragraph, where five glyphs
          read as one control. The accessibility label carries the word the chip
          no longer shows. */}
        <View style={styles.modeRow}>
          {ROUTING_PROFILES.map((p) => {
            const Icon = PROFILE_ICON[p.id];
            const on = !transitMode && p.id === route.profile;
            return (
              <Pressable
                key={p.id}
                style={[styles.modeTab, on && styles.modeTabSelected]}
                onPress={() => {
                  transit.setEnabled(false);
                  route.setProfile(p.id);
                }}
                accessibilityRole="button"
                accessibilityLabel={p.label}
                accessibilityState={{ selected: on }}
                testID={`route-profile-${p.id}`}
              >
                <Icon color={on ? theme.accent : theme.icon} />
                {showModeTimes ? (
                  <Text style={[styles.modeTime, on && styles.modeTimeSelected]}>
                    {modeTimeLabel(route.modeTimes[p.id])}
                  </Text>
                ) : null}
              </Pressable>
            );
          })}
          {/* Transit is a travel mode, not a fifth routing profile — and it is
            offered only where the national planner can actually answer. */}
          {transit.offered ? (
            <Pressable
              style={[styles.modeTab, transitMode && styles.modeTabSelected]}
              onPress={() => transit.setEnabled(true)}
              accessibilityRole="button"
              accessibilityLabel="Public transport"
              accessibilityState={{ selected: transitMode }}
              testID="route-profile-transit"
            >
              <TramIcon color={transitMode ? theme.accent : theme.icon} />
              {showModeTimes && transitTimeMs !== undefined ? (
                <Text style={[styles.modeTime, transitMode && styles.modeTimeSelected]}>
                  {fmtDuration(transitTimeMs)}
                </Text>
              ) : null}
            </Pressable>
          ) : null}
        </View>

        {!transitMode ? (
          <>
            <Pressable
              style={[styles.customToggle, customOpen && styles.chipSelected]}
              onPress={() => setCustomOpen((open) => !open)}
              accessibilityRole="button"
              accessibilityState={{ expanded: customOpen }}
              testID="route-customize"
            >
              <Text style={styles.chipText}>
                Customize {ROUTING_PROFILES.find((p) => p.id === route.profile)?.label}
              </Text>
            </Pressable>
            {customOpen ? (
              <View style={styles.customOptions}>
                {CUSTOM_OPTIONS.filter((option) => option.profiles.includes(route.profile)).map(
                  (option) => (
                    <Pressable
                      key={option.key}
                      style={[styles.chip, route.preferences[option.key] && styles.chipSelected]}
                      onPress={() =>
                        route.setPreference(option.key, !route.preferences[option.key])
                      }
                      accessibilityRole="checkbox"
                      accessibilityState={{ checked: route.preferences[option.key] }}
                      testID={`route-option-${option.key}`}
                    >
                      <Text style={styles.chipText}>{option.label}</Text>
                    </Pressable>
                  ),
                )}
              </View>
            ) : null}
          </>
        ) : null}

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

        {/* While a stop is being re-pointed, the add-a-stop box stands down —
          two open search boxes with two different meanings is how you end up
          appending a stop you meant to replace. */}
        {editing === null ? (
          <StopSearch
            places={places}
            geocode={geocode}
            placeholder={
              nextRole === 'start'
                ? 'Start: address or saved place'
                : stops.length >= 2
                  ? 'Add a stop'
                  : 'Destination: address or saved place'
            }
            onPick={(position, name) => route.addWaypoint(position, name)}
          />
        ) : null}

        {!route.roundTrip && !transitMode && path && stops.length >= 2 ? (
          <AlongRouteSearch route={route} path={path} places={places} geocode={geocode} />
        ) : null}

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
                {/* A stop that cannot be changed without deleting it is the
                  thing every other maps app lets you tap. Editing in place also
                  keeps the stop's position in the order, which delete-then-add
                  does not. */}
                {editing === w.id ? (
                  <View style={styles.wpEdit}>
                    <StopSearch
                      places={places}
                      geocode={geocode}
                      placeholder="Change this stop"
                      initialQuery={w.name ?? ''}
                      autoFocus
                      onPick={(position, name) => {
                        route.replaceWaypoint(w.id, position, name);
                        setEditing(null);
                      }}
                      onCancel={() => setEditing(null)}
                    />
                  </View>
                ) : (
                  <Pressable
                    style={styles.wpNameTap}
                    onPress={() => setEditing(w.id)}
                    accessibilityRole="button"
                    accessibilityLabel={`Change ${stopTitle(w)}`}
                    testID={`route-wp-edit-${w.id}`}
                  >
                    <Text style={styles.wpName} numberOfLines={1}>
                      {stopTitle(w)}
                    </Text>
                  </Pressable>
                )}
                {editing === w.id ? null : !route.roundTrip ? (
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
                {editing === w.id ? null : (
                  <Pressable
                    style={styles.iconButton}
                    onPress={() => route.removeWaypoint(w.id)}
                    testID={`route-wp-remove-${w.id}`}
                  >
                    <Text style={styles.iconText}>✕</Text>
                  </Pressable>
                )}
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
            // Guidance replaces the planned origin with the live position, so
            // the stops between first and last ride along as via points.
            onPress={() =>
              destination &&
              onNavigate(
                destination,
                stops.slice(1, -1).map((w) => w.pos),
              )
            }
            testID="route-navigate"
          >
            <Text style={styles.navigateText}>Start navigation</Text>
          </Pressable>
        ) : null}

        {/* Each action appears only once it can do something, rather than sitting
          there greyed out: Reverse needs two ends, Optimize a tour to shorten,
          Export a computed track, and Clear something to act on. With no stops
          the whole row is gone rather than a strip of dead buttons. */}
        {route.waypoints.length > 0 ? (
          <View style={styles.actionRow}>
            {/* Reverse works in transit mode too — swapping the ends is the
              commonest thing anyone does to a journey ("now get me home"), and
              unlike Optimize it means something to a timetable. */}
            {!route.roundTrip && route.waypoints.length >= 2 ? (
              <Pressable style={[styles.button, styles.buttonQuiet]} onPress={route.reverse}>
                <Text style={styles.buttonQuietText}>Reverse</Text>
              </Pressable>
            ) : null}
            {!transitMode && !route.roundTrip && route.waypoints.length >= 4 ? (
              <Pressable style={[styles.button, styles.buttonQuiet]} onPress={route.optimize}>
                <Text style={styles.buttonQuietText}>Optimize</Text>
              </Pressable>
            ) : null}
            <Pressable style={[styles.button, styles.buttonQuiet]} onPress={route.clear}>
              <Text style={styles.buttonQuietText}>Clear</Text>
            </Pressable>
            {/* A journey is legs and times, not a track — nothing to export as
              GPX, so the button is simply absent rather than dead. */}
            {path && !transitMode ? (
              <Pressable
                style={[styles.button, styles.buttonQuiet]}
                onPress={() => onExport(path)}
                testID="route-export"
              >
                <Text style={styles.buttonQuietText}>Export GPX</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}

        {transitMode ? (
          <TransitResults
            transit={transit}
            onShowMap={(trip, index) => {
              transit.select(index);
              Keyboard.dismiss();
              sheetRef.current?.snapTo('peek');
              setTripOnMap(true);
              onShowTransitTrip(trip);
            }}
          />
        ) : null}

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
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  body: { flex: 1 },
  bodyContent: { gap: 8, paddingTop: 8 },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  heading: { fontSize: 15, fontWeight: '700', color: theme.text, flexGrow: 1 },
  muted: { fontSize: 13, color: theme.textMuted },
  closeX: { paddingHorizontal: 6, paddingVertical: 2 },
  closeXText: { fontSize: 18, color: theme.text },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: {
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: theme.surfaceMuted,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  chipSelected: { borderColor: theme.accent, backgroundColor: theme.surfaceActive },
  chipText: { fontSize: 13, color: theme.text, fontWeight: '600' },
  customToggle: {
    alignSelf: 'flex-start',
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: theme.surfaceMuted,
  },
  customOptions: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  // Icon-only mode picker: equal-width tabs under a shared rule, with the
  // selected one underlined rather than filled — a filled pill at this size
  // fights the line badges further down the panel for attention.
  modeRow: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: theme.border,
    marginBottom: 4,
  },
  modeTab: {
    flexGrow: 1,
    alignItems: 'center',
    paddingVertical: 9,
    borderBottomWidth: 3,
    borderBottomColor: 'transparent',
    // Pulls the tab's own underline over the row's hairline rule.
    marginBottom: -1,
  },
  modeTabSelected: { borderBottomColor: theme.accent },
  // Trip time under each mode icon, so the picker reads "24 min / 1 h 10"
  // before a mode is chosen. Muted so the icon leads.
  modeTime: { marginTop: 2, fontSize: 10, color: theme.textMuted },
  modeTimeSelected: { color: theme.accent },
  roundRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  kmInput: {
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    minWidth: 60,
    fontSize: 15,
    color: theme.text,
  },
  // No maxHeight any more: the panel's own scroller owns the overflow, and a
  // nested one here would fight it for the gesture.
  wpList: {},
  wpRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6 },
  wpLabel: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: theme.accent,
    color: theme.onAccent,
    textAlign: 'center',
    lineHeight: 26,
    fontWeight: '700',
  },
  wpRole: {
    minWidth: 44,
    paddingHorizontal: 8,
    height: 26,
    borderRadius: 13,
    backgroundColor: theme.accent,
    color: theme.onAccent,
    textAlign: 'center',
    lineHeight: 26,
    fontSize: 12,
    fontWeight: '700',
  },
  // The tap target is the row-wide box, not just the glyph-width text: a stop
  // called "5" was otherwise a two-character target.
  wpNameTap: { flexGrow: 1, flexShrink: 1, paddingVertical: 4 },
  wpName: { fontSize: 14, color: theme.text },
  wpEdit: { flexGrow: 1, flexShrink: 1 },
  sourceRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  chipBusy: { opacity: 0.6 },
  hint: { fontSize: 12, color: theme.textMuted },
  navigate: {
    backgroundColor: theme.accent,
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
  navigateText: { color: theme.onAccent, fontWeight: '700', fontSize: 15 },
  iconButton: { paddingHorizontal: 6, paddingVertical: 2 },
  iconText: { fontSize: 16, color: theme.text },
  iconDisabled: { color: theme.textMuted },
  actionRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  button: {
    backgroundColor: theme.accent,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  buttonDisabled: { opacity: 0.5 },
  buttonText: { color: theme.onAccent, fontWeight: '600' },
  buttonQuiet: { backgroundColor: theme.surfaceMuted },
  buttonQuietText: { color: theme.text, fontWeight: '600' },
  error: { fontSize: 13, color: theme.danger },
  statsRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  stats: { fontSize: 14, color: theme.text, fontWeight: '600', flexShrink: 1 },
  stopSearch: { flexGrow: 1 },
  stopInputRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  stopInputGrow: { flexGrow: 1, flexShrink: 1 },
  stopInput: {
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
    fontSize: 14,
    color: theme.text,
  },
  stopResults: {
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 8,
    marginTop: 4,
    paddingVertical: 2,
  },
  stopResult: { paddingHorizontal: 10, paddingVertical: 6 },
  stopResultName: { fontSize: 14, color: theme.text, fontWeight: '600' },
  stopResultLabel: { fontSize: 11, color: theme.textMuted },
  alongSearch: { alignItems: 'stretch', gap: 4 },
  alongToggle: {
    alignSelf: 'flex-start',
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: theme.surfaceActive,
    borderWidth: 1,
    borderColor: theme.border,
  },
  alongToggleSelected: { borderColor: theme.accent },
  alongToggleText: { fontSize: 13, color: theme.text, fontWeight: '600' },
});
