import {
  altChipLabel,
  fmtDistanceM,
  fmtDuration,
  fmtEta,
  fmtKm,
  modeTimeLabel,
  stopAlongLabel,
  stopRole,
  stopTitle,
  waypointLabel,
  type LatLng,
} from '@atlas/core';
import {
  routeStopCategories,
  useRouteStops,
  useStopSearch,
  type FetchNearbyFn,
  type StopGeocodeFn,
} from '@atlas/app-hooks';
import type { TrackData } from '@atlas/gpx';
import {
  pathViaLabels,
  routeActionsFor,
  routeOptionsFor,
  routeOptionsSummary,
  ROUTING_PROFILES,
  type RouteActionInfo,
  type RouteActionKey,
  routePathToTrackData,
  routeSurfaceBreakdown,
  type RoutePath,
  vehicleChipLabel,
} from '@atlas/routing';
import type { CollectionRecord, PlaceRecord } from '@atlas/storage';
import { formatRoadWeatherWarning, formatTrafficDelay } from '@atlas/traffic';
import type { TransitTrip } from '@atlas/transit';
import { useEffect, useMemo, useRef, useState } from 'react';
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
import type { SearchBias } from '../search/geoSearch';
import { BottomSheet, type BottomSheetHandle } from './BottomSheet';
import { ElevationChart } from './ElevationChart';
import { flattenFolders } from './folders';
import { useGeocode } from './useGeocode';
import {
  CarIcon,
  MoreIcon,
  PROFILE_ICON,
  ROUTE_ACTION_ICON,
  SlidersIcon,
  TramIcon,
} from './modeIcons';
import { theme } from './theme';
import { TransitResults } from './TransitResults';

/** Search box that adds a stop by name: saved places first, then addresses. */
function StopSearch({
  places,
  geocode,
  placeholder,
  initialQuery = '',
  autoFocus = false,
  transit,
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
  transit: boolean;
  /** The hit's name rides along: a stop the user chose by name should keep it. */
  onPick: (position: LatLng, name: string, transitStopId?: string) => void;
  /** Present when this box is editing an existing stop — leaves it unchanged. */
  onCancel?: () => void;
}) {
  const { query, setQuery, hits, reset, statusText } = useStopSearch({
    geocode,
    places,
    initialQuery,
    debounceMs: 300,
    transit,
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
      {hits.length > 0 || statusText ? (
        <View style={styles.stopResults}>
          {statusText ? <Text style={styles.stopStatus}>{statusText}</Text> : null}
          {hits.map((hit, i) => (
            <Pressable
              key={`${hit.position.lat}/${hit.position.lng}/${i}`}
              style={styles.stopResult}
              testID={`route-stop-result-${i}`}
              onPress={() => {
                Keyboard.dismiss();
                onPick(hit.position, hit.name, hit.transitStopId);
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

/**
 * Stops on the route, browsed by category — the planner's twin of the mid-drive
 * AddStopSheet (rules in `useRouteStops`). Chips instead of a text box: a
 * geocoder ranking names had no idea what a route was, so "cafe" returned
 * whatever happened to share the letters, while what a planner wants is the
 * category laid out in route order with the detour spelled out.
 */
function AlongRouteStops({
  route,
  path,
  fetchNearby,
  onPicked,
}: {
  route: RoutePlanner;
  path: RoutePath;
  fetchNearby: FetchNearbyFn;
  /** Close the browser once a stop has joined the plan. */
  onPicked: () => void;
}) {
  // Always open: the disclosure that used to live here is now the toolbar's
  // "Stops along route" button, which is where a driver looks for it.
  // Kept as a constant so useRouteStops keeps its "only search while the
  // panel is showing" contract.
  const open = true;
  const waypoints = useMemo(() => route.waypoints.map((w) => w.pos), [route.waypoints]);
  const { category, setCategory, hits, status } = useRouteStops({
    path,
    waypoints,
    profile: route.profile,
    active: open,
    fetchNearby,
  });
  const categories = routeStopCategories(route.profile);

  return (
    <View style={styles.alongSearch} testID="route-along-panel">
      <View style={styles.alongCategories}>
        {categories.map((item) => (
          <Pressable
            key={item.id}
            style={[styles.alongCategory, category === item.id && styles.alongCategoryOn]}
            onPress={() => setCategory(item.id)}
            accessibilityRole="tab"
            accessibilityState={{ selected: category === item.id }}
            testID={`route-along-${item.id}`}
          >
            <Text style={styles.alongCategoryText}>{item.label}</Text>
          </Pressable>
        ))}
      </View>
      {status === 'loading' ? <Text style={styles.hint}>Looking along the route…</Text> : null}
      {status === 'error' ? <Text style={styles.hint}>Search unavailable right now.</Text> : null}
      {status === 'ready' && hits.length === 0 ? (
        <Text style={styles.hint}>Nothing in this category along this route.</Text>
      ) : null}
      {hits.length > 0 ? (
        <View style={styles.stopResults}>
          {hits.map((hit, index) => (
            <Pressable
              key={`${hit.name}/${hit.position.lat}/${hit.position.lng}`}
              style={styles.stopResult}
              testID={`route-along-result-${index}`}
              onPress={() => {
                Keyboard.dismiss();
                route.insertWaypoint(hit.insertIndex, hit.position, hit.name);
                onPicked();
              }}
            >
              <Text style={styles.stopResultName} numberOfLines={1}>
                {hit.name}
              </Text>
              <Text style={styles.stopResultLabel} numberOfLines={1}>
                {stopAlongLabel(hit.alongM)}
                {/* Only worth saying when it is a real detour. */}
                {hit.offRouteM > 250 ? ` · ${fmtDistanceM(hit.offRouteM)} off route` : ''}
                {hit.label ? ` · ${hit.label}` : ''}
              </Text>
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
  collections,
  getBias,
  fetchNearby,
  onExport,
  onShareLink,
  onSaveTrack,
  onNavigate,
  onOpenVehicleSettings,
  onShowTransitTrip,
  onStartTransitGuidance,
  onMakeCommute,
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
  collections: CollectionRecord[];
  /** Current map centre, to bias the stop search towards the viewport. */
  getBias: SearchBias;
  /** Category POIs near a point — the same explore seam the mid-drive panel uses. */
  fetchNearby: FetchNearbyFn;
  /** Share the selected path as GPX; App owns the build+share. */
  onExport: (path: RoutePath) => void;
  /**
   * Share a link that reopens this plan (web's "Share" button, which copies the
   * URL its address bar already carries). App owns it because building the link
   * needs the live camera, which lives up there with the map.
   */
  onShareLink: () => void;
  onSaveTrack: (data: TrackData, name: string, collectionId: string | null) => Promise<boolean>;
  /**
   * Start turn-by-turn to the last stop in the current profile, via the plan's
   * intermediate stops. This panel is the only place a travel mode is chosen,
   * so it is also the only place guidance starts from — the place card just
   * points here.
   */
  onNavigate: (destination: LatLng, viaPoints: LatLng[]) => void;
  /** Start a destination-free live map in the selected travel mode. */
  /** Open Settings → Navigation, where the vehicle is described. */
  onOpenVehicleSettings: () => void;
  /** Collapse the planner and frame this selected journey on the map. */
  onShowTransitTrip: (trip: TransitTrip) => void;
  /** Start the timetable-driven passenger companion for one selected journey. */
  onStartTransitGuidance: (trip: TransitTrip) => void;
  /** Save this planner corridor and hand it to the commute board. */
  onMakeCommute?: () => void;
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
  const surfaces = useMemo(
    () => routeSurfaceBreakdown(path?.enrichment, path?.distanceM ?? 0),
    [path],
  );
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
  const [saveOpen, setSaveOpen] = useState(false);
  // The mode-dependent toolbar's fold, and the category browser one of its
  // buttons opens. Both live here rather than in their own components so the
  // toolbar can own what it shows.
  const [moreOpen, setMoreOpen] = useState(false);
  const [alongOpen, setAlongOpen] = useState(false);
  // The route's terms, folded away until asked for. Closed on every open of
  // the planner: the terms persist, so the common case is a plan under the
  // same ones as last time, and a fold that remembers being open would spend
  // the space this fold exists to give back.
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [saveName, setSaveName] = useState('Planned route');
  const [saveCollection, setSaveCollection] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  // Planner detail samples Kartverket heights where coverage is available.
  const hasElevation = path?.points.some((p) => p.ele !== undefined) ?? false;
  const profileData = useMemo(
    () => (path && hasElevation ? routePathToTrackData(path, 'route') : null),
    [path, hasElevation],
  );
  useEffect(() => setSaved(false), [path]);

  const [locating, setLocating] = useState(false);
  const [locateFailed, setLocateFailed] = useState(false);
  const folders = useMemo(() => flattenFolders(collections), [collections]);
  /** Waypoint id whose search box is open for re-pointing, or null. */
  const [editing, setEditing] = useState<number | null>(null);
  // What the driving plan is actually being costed for. Read from the merged
  // preferences rather than the setting, so the chip can only ever say what was
  // sent to the engine.
  const vehicleLabel = vehicleChipLabel(route.profile, route.preferences.vehicle);
  // What the collapsed options button says — shared with web, so one plan
  // cannot be described two ways.
  const optionsSummary = routeOptionsSummary(route.profile, route.preferences, route.roundTrip);

  const stops = route.waypoints;
  // A stop that disappears (cleared, removed, reversed away) must not leave an
  // orphaned editor bound to an id that no longer exists.
  useEffect(() => {
    if (editing !== null && !stops.some((w) => w.id === editing)) setEditing(null);
  }, [editing, stops]);

  // A cleared or shortened plan closes the stops browser. Without this, a fresh
  // plan re-opened it the moment it reached two stops — and firing an explore
  // request nobody asked for is worse than a panel that has to be re-opened.
  useEffect(() => {
    if (stops.length < 2) setAlongOpen(false);
  }, [stops.length]);

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

  /**
   * Whether each secondary action can currently act. Placement is the shared
   * descriptor's job (`routeActionsFor`); existence stays here, because it is
   * read off this panel's own state. An action that cannot act is absent from
   * both the visible row and the fold — never greyed out, and never a dead
   * entry behind "More".
   */
  const actionAvailable: Record<RouteActionKey, boolean> = {
    // Every one of these needs a computed path to act on, which a timetable
    // never produces: a journey is legs and times, not a track.
    alongRoute: Boolean(path) && !transitMode && !route.roundTrip && stops.length >= 2,
    saveTrack: Boolean(path) && !transitMode,
    exportGpx: Boolean(path) && !transitMode,
    // Reverse works in transit mode too — swapping the ends is the commonest
    // thing anyone does to a journey ("now get me home"), and unlike Optimize
    // it means something to a timetable.
    reverse: !route.roundTrip && stops.length >= 2,
    optimize: !transitMode && !route.roundTrip && stops.length >= 4,
    clear: stops.length > 0,
    share: stops.length > 0,
  };
  const toolbar = routeActionsFor(route.profile);
  const primaryActions = toolbar.primary.filter((action) => actionAvailable[action.key]);
  const moreActions = toolbar.more.filter((action) => actionAvailable[action.key]);

  /**
   * One toolbar button: the glyph, with the descriptor's sentence as its
   * TalkBack name.
   *
   * `labelled` is the fold under ⋯, which shows the words beside the glyph —
   * an icon-only row is only legible for the actions a mode leads with, and the
   * fold is where the unfamiliar ones live. A saved track is worth saying out
   * loud rather than drawing, since nothing else on the sheet reports it.
   */
  const renderAction = (action: RouteActionInfo, labelled = false) => {
    const press = {
      alongRoute: () => setAlongOpen((open) => !open),
      saveTrack: () => {
        setSaved(false);
        setSaveOpen((open) => !open);
      },
      exportGpx: () => path && onExport(path),
      reverse: route.reverse,
      optimize: route.optimize,
      clear: route.clear,
      // A link needs stops, not a routed path: it carries the plan and the
      // recipient's app routes it — including a transit journey, which reopens
      // as the same endpoints in transit mode.
      share: onShareLink,
    }[action.key];
    const lit = (action.key === 'alongRoute' && alongOpen) || (action.key === 'saveTrack' && saved);
    const label = action.key === 'saveTrack' && saved ? 'Saved as track' : action.label;
    const Icon = ROUTE_ACTION_ICON[action.key];
    return (
      <Pressable
        key={action.key}
        style={[
          labelled ? styles.iconAction : styles.iconOnly,
          styles.buttonQuiet,
          lit && styles.buttonQuietOn,
        ]}
        onPress={press}
        accessibilityRole="button"
        accessibilityLabel={label}
        testID={`route-action-${action.key}`}
      >
        <Icon color={theme.icon} size={18} />
        {labelled ? <Text style={styles.iconActionText}>{label}</Text> : null}
      </Pressable>
    );
  };

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
                : // A loop comes home to its start, so nothing entered after the
                  // first point is a destination — it is somewhere to go by way of.
                  route.roundTrip || stops.length >= 2
                  ? 'Add a stop'
                  : 'Destination: address or saved place'
            }
            transit={transitMode}
            onPick={(position, name, transitStopId) =>
              route.addWaypoint(position, name, transitStopId)
            }
          />
        ) : null}

        {/* One row for the two things that are neither a stop nor the answer:
          where the plan starts from, and the terms it is planned under.

          Both used to be bands of their own. "My location as start" sat beside
          an "or tap the map" reminder that the empty state below already gives,
          and the route's terms were a wrapping row of chips — five of them
          driving — parked above the stops, where a phone sheet has the least
          room and the user is doing something else. Folding them behind one
          button costs a tap for the rare change and gives the stops the space;
          the button still *names* the constraint when there is exactly one
          (`routeOptionsSummary`), so a plan under terms never looks like a plan
          under none. Web's twin (apps/web/src/routing/RoutePanel.tsx). */}
        <View style={styles.sourceRow}>
          <Pressable
            style={[styles.chip, locating && styles.chipBusy]}
            disabled={locating}
            onPress={() => void addMyLocation()}
            accessibilityRole="button"
            accessibilityLabel="Use my location as the start"
            testID="route-my-location"
          >
            <Text style={styles.chipText}>{locating ? 'Locating…' : '◎ My location'}</Text>
          </Pressable>
          {!transitMode ? (
            <Pressable
              style={[styles.chip, optionsSummary.count > 0 && styles.chipSelected]}
              onPress={() => setOptionsOpen((open) => !open)}
              accessibilityRole="button"
              accessibilityLabel={optionsSummary.ariaLabel}
              accessibilityState={{ expanded: optionsOpen }}
              testID="route-options"
            >
              <SlidersIcon color={theme.icon} size={14} />
              <Text style={styles.chipText}>{optionsSummary.label}</Text>
            </Pressable>
          ) : null}
          {/* Outside the fold, and only once a vehicle is described: the height
            a plan is costed for is the strongest thing the panel can say about
            it, and hiding it behind a tap would undo v0.173.0, which put it
            here because a motorhome driver had no reason to believe the feature
            existed. Unset, it is one more control and lives inside the fold. */}
          {!transitMode && vehicleLabel ? (
            <Pressable
              style={[styles.chip, styles.chipSelected]}
              onPress={onOpenVehicleSettings}
              accessibilityRole="button"
              accessibilityLabel={`Vehicle: ${vehicleLabel}. Change in settings`}
              testID="route-vehicle"
            >
              <CarIcon color={theme.icon} size={14} />
              <Text style={styles.chipText}>{vehicleLabel}</Text>
            </Pressable>
          ) : null}
        </View>

        {/* The fold: every term of the plan, as the chips that state it. Chips
          say the constraint they impose ("No ferries"), never the thing avoided
          — a lit chip reading "Ferries" is genuinely ambiguous about whether
          ferries are wanted or refused, and that is expensive on a route about
          to put a vehicle on a boat. */}
        {optionsOpen && !transitMode ? (
          <View style={styles.optionsFold} testID="route-options-fold">
            <View style={styles.optionsRow}>
              {routeOptionsFor(route.profile).map((option) => (
                <Pressable
                  key={option.key}
                  style={[styles.chip, route.preferences[option.key] && styles.chipSelected]}
                  onPress={() => route.setPreference(option.key, !route.preferences[option.key])}
                  accessibilityRole="checkbox"
                  // The full sentence rather than the chip's own words, unlike
                  // web: there is no hover here to carry it, so TalkBack is the
                  // only place "Paved" can be spelled out as what it does.
                  accessibilityLabel={option.label}
                  accessibilityState={{ checked: route.preferences[option.key] }}
                  testID={`route-option-${option.key}`}
                >
                  <Text style={styles.chipText}>{option.chipLabel}</Text>
                </Pressable>
              ))}
              <Pressable
                style={[styles.chip, route.roundTrip && styles.chipSelected]}
                onPress={() => route.setRoundTrip(!route.roundTrip)}
                accessibilityRole="checkbox"
                accessibilityLabel="Come back to the start instead of ending at a destination"
                accessibilityState={{ checked: route.roundTrip }}
                testID="route-roundtrip"
              >
                <Text style={styles.chipText}>Round trip</Text>
              </Pressable>
              {/* Driving only: a described vehicle changes both the road chosen
                and the arrival time, but it lives in Settings → Navigation,
                where a driver planning a trip has no reason to look. Reads
                `preferences.vehicle` — what will actually be sent to the engine
                — never the raw setting. */}
              {route.profile === 'car' && !vehicleLabel ? (
                <Pressable
                  style={styles.chip}
                  onPress={onOpenVehicleSettings}
                  accessibilityRole="button"
                  accessibilityLabel="Describe a taller or slower vehicle"
                  testID="route-vehicle"
                >
                  <CarIcon color={theme.icon} size={14} />
                  <Text style={styles.chipText}>Vehicle</Text>
                </Pressable>
              ) : null}
            </View>

            {/* The loop's length and direction, once there is a loop to
              describe — inert beside a switch that is off. */}
            {route.roundTrip ? (
              <View style={styles.roundRow}>
                <TextInput
                  style={styles.kmInput}
                  keyboardType="numeric"
                  value={String(route.roundTripKm)}
                  onChangeText={(t) => route.setRoundTripKm(Math.max(Number(t) || 1, 1))}
                  testID="route-roundtrip-km"
                />
                <Text style={styles.muted}>km</Text>
                {(
                  [
                    ['either', 'Either way'],
                    ['clockwise', 'Clockwise'],
                    ['counterclockwise', 'Counterclockwise'],
                  ] as const
                ).map(([direction, label]) => (
                  <Pressable
                    key={direction}
                    style={[
                      styles.chip,
                      route.roundTripDirection === direction && styles.chipSelected,
                    ]}
                    onPress={() => route.setRoundTripDirection(direction)}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: route.roundTripDirection === direction }}
                    testID={`route-roundtrip-${direction}`}
                  >
                    <Text style={styles.chipText}>{label}</Text>
                  </Pressable>
                ))}
                <Pressable
                  style={[styles.button, styles.buttonQuiet]}
                  onPress={route.newLoop}
                  disabled={route.waypoints.length === 0}
                >
                  <Text style={styles.buttonQuietText}>New loop</Text>
                </Pressable>
              </View>
            ) : null}
          </View>
        ) : null}
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
                      transit={transitMode}
                      onPick={(position, name, transitStopId) => {
                        route.replaceWaypoint(w.id, position, name, transitStopId);
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
                {/* Loops are reordered like any other plan: their stops are
                  visited in list order on the way round, so moving one changes
                  the trip. Only a single-stop loop has no order to change. */}
                {editing === w.id || route.waypoints.length < 2 ? null : (
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
                )}
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

        {!transitMode && route.error ? <Text style={styles.error}>{route.error}</Text> : null}

        {/* The answer, and the one thing you do with it, in the same block.
          Both used to be somewhere else: "Start navigation" was a full-width
          accent slab directly under the stops, and the distance/time/ETA the
          sheet was opened for sat last — under the slab, under six same-weight
          secondary buttons, well past the sheet's peek. So the loudest thing on
          screen was the commitment and the quietest was what you were
          committing to. Now the trip time leads, the rest of the numbers read
          under it, and Start is a button beside them rather than a band across
          them. Web's twin (apps/web/src/routing/RoutePanel.tsx). */}
        {!transitMode && (path || destination) ? (
          <View style={styles.result}>
            <View style={styles.summaryRow}>
              <View style={styles.summaryFigures}>
                {path ? (
                  <>
                    <Text style={styles.summaryTime}>{fmtDuration(path.timeMs)}</Text>
                    <Text style={styles.summaryDetail}>
                      {fmtKm(path.distanceM)} · ETA {fmtEta(path.timeMs)}
                      {/* The measured part of that time, named rather than
                          silently folded in — an ETA that moved for a reason
                          should say so. */}
                      {formatTrafficDelay(path.trafficDelayMs)
                        ? ` · ${formatTrafficDelay(path.trafficDelayMs)}`
                        : ''}
                    </Text>
                    {/* Climb on its own line rather than a fourth clause on the
                        one above: with Start beside it the detail line has no
                        room left, and the wrap read as a broken layout. */}
                    {path.ascentM > 0 || path.descentM > 0 ? (
                      <Text style={styles.summaryDetail}>
                        ↗ {Math.round(path.ascentM)} m ↘ {Math.round(path.descentM)} m
                      </Text>
                    ) : null}
                    {path.roadWeather?.warnings[0] ? (
                      <Text style={styles.weatherWarning}>
                        ⚠ {formatRoadWeatherWarning(path.roadWeather.warnings[0])} ·{' '}
                        {fmtKm(path.roadWeather.warnings[0].atM)} along route
                      </Text>
                    ) : null}
                  </>
                ) : (
                  <Text style={styles.summaryDetail}>
                    {route.loading
                      ? 'Routing…'
                      : // The place-card hand-off lands here with the
                        // destination alone, and no route can be drawn until
                        // there is a start. Say what Start will do rather than
                        // leaving the button beside an empty readout.
                        stops.length === 1
                        ? 'Guidance starts from where you are.'
                        : ''}
                  </Text>
                )}
              </View>
              {/* This panel is the app's only travel-mode picker, so guidance
                starts here. Transit has no turn-by-turn, so it shows the board
                below instead of a button that would promise directions it
                cannot give. The visible word is short because the block it sits
                in already says what is being started; the accessibility label
                keeps the full sentence. */}
              <Pressable
                style={[styles.navigate, !destination && styles.buttonDisabled]}
                disabled={!destination}
                accessibilityRole="button"
                accessibilityLabel="Start navigation"
                // Guidance replaces the planned origin with the live position,
                // so the stops between first and last ride along as via points.
                onPress={() =>
                  destination &&
                  onNavigate(
                    destination,
                    stops.slice(1, -1).map((w) => w.pos),
                  )
                }
                testID="route-navigate"
              >
                <Text style={styles.navigateText}>Start</Text>
              </Pressable>
            </View>
            {profileData ? (
              <Pressable
                style={[styles.chip, profileOpen && styles.chipSelected, styles.selfStart]}
                onPress={() => setProfileOpen((o) => !o)}
                testID="route-profile-toggle"
              >
                <Text style={styles.chipText}>Profile</Text>
              </Pressable>
            ) : null}
            {surfaces.length > 0 ? (
              <View style={styles.surfaceRow}>
                <Text style={styles.surfaceTitle}>Surface</Text>
                {surfaces.map((surface) => (
                  <Text key={surface.label} style={styles.surfaceText}>
                    {surface.label} {surface.percent}%
                  </Text>
                ))}
              </View>
            ) : null}
          </View>
        ) : null}
        {!transitMode && profileOpen && profileData ? (
          <ElevationChart data={profileData} enrichment={path?.enrichment} />
        ) : null}

        {/* Beside the result, not below the toolbar: an alternative is a choice
          about the answer, so it belongs where the answer is read. */}
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

        {/* One toolbar per travel mode (`routeActionsFor`, @atlas/routing), not
          the same six buttons at one weight for everyone: driving leads with
          the stops along the way, walking with the track it will keep and
          carry, and the rest fold under ⋯ — one tap away, never gone.
          Availability still decides existence: an action that cannot act is
          absent from both rows rather than folded into a menu of dead entries,
          so with no stops the whole toolbar is gone.

          Glyphs, since v0.175.0: these are the sheet's *secondary* actions, and
          six of them spelled out wrapped into two bands of text that outweighed
          the answer above them. Drawn, they are one short row, and Share looks
          like Share. The words survive as the TalkBack name and as the fold's
          own labels. */}
        {primaryActions.length > 0 || moreActions.length > 0 ? (
          <View style={styles.actionRow}>
            {primaryActions.map((action) => renderAction(action))}
            {moreActions.length > 0 ? (
              <Pressable
                style={[styles.iconOnly, styles.buttonQuiet, moreOpen && styles.buttonQuietOn]}
                onPress={() => setMoreOpen((open) => !open)}
                accessibilityRole="button"
                accessibilityLabel="More route actions"
                accessibilityState={{ expanded: moreOpen }}
                testID="route-more"
              >
                <MoreIcon color={theme.icon} size={18} />
              </Pressable>
            ) : null}
          </View>
        ) : null}
        {moreOpen && moreActions.length > 0 ? (
          <View style={[styles.actionRow, styles.actionRowMore]}>
            {moreActions.map((action) => renderAction(action, true))}
          </View>
        ) : null}

        {/* The category browser the toolbar's "Stops along route" opens: fuel,
          charging and rest areas on a drive, cafés and viewpoints on foot. */}
        {alongOpen && path && !route.roundTrip && !transitMode && stops.length >= 2 ? (
          <AlongRouteStops
            route={route}
            path={path}
            fetchNearby={fetchNearby}
            onPicked={() => setAlongOpen(false)}
          />
        ) : null}

        {saveOpen && path && !transitMode ? (
          <View style={styles.saveTrack}>
            <Text style={styles.fieldLabel}>Track name</Text>
            <TextInput
              style={styles.saveInput}
              value={saveName}
              onChangeText={setSaveName}
              autoFocus
              returnKeyType="done"
              testID="route-save-name"
            />
            <Text style={styles.fieldLabel}>Folder</Text>
            <View style={styles.chipRow}>
              <Pressable
                style={[styles.chip, saveCollection === null && styles.chipSelected]}
                onPress={() => setSaveCollection(null)}
                testID="route-save-folder-none"
              >
                <Text style={styles.chipText}>No folder</Text>
              </Pressable>
              {folders.map(({ folder, depth }) => (
                <Pressable
                  key={folder.id}
                  style={[styles.chip, saveCollection === folder.id && styles.chipSelected]}
                  onPress={() => setSaveCollection(folder.id)}
                  testID={`route-save-folder-${folder.id}`}
                >
                  <Text style={styles.chipText}>
                    {depth > 0 ? '└ ' : ''}📁 {folder.name}
                  </Text>
                </Pressable>
              ))}
            </View>
            <View style={styles.actionRow}>
              <Pressable
                style={[styles.button, !saveName.trim() || saving ? styles.buttonDisabled : null]}
                disabled={!saveName.trim() || saving}
                onPress={() => {
                  setSaving(true);
                  void onSaveTrack(
                    routePathToTrackData(path, saveName.trim()),
                    saveName.trim(),
                    saveCollection,
                  ).then((ok) => {
                    setSaving(false);
                    setSaved(ok);
                    if (ok) setSaveOpen(false);
                  });
                }}
                testID="route-save-confirm"
              >
                <Text style={styles.buttonText}>{saving ? 'Saving…' : 'Save'}</Text>
              </Pressable>
              <Pressable
                style={[styles.button, styles.buttonQuiet]}
                onPress={() => setSaveOpen(false)}
              >
                <Text style={styles.buttonQuietText}>Cancel</Text>
              </Pressable>
            </View>
          </View>
        ) : null}

        {transitMode ? (
          <TransitResults
            transit={transit}
            onStartGuidance={onStartTransitGuidance}
            onMakeCommute={onMakeCommute}
            onShowMap={(trip, index) => {
              transit.select(index);
              Keyboard.dismiss();
              sheetRef.current?.snapTo('peek');
              setTripOnMap(true);
              onShowTransitTrip(trip);
            }}
          />
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
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: theme.surfaceMuted,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  chipSelected: { borderColor: theme.accent, backgroundColor: theme.surfaceActive },
  chipText: { fontSize: 13, color: theme.text, fontWeight: '600' },
  /** The route's terms, one chip each — costing, loop and described vehicle. */
  optionsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  /* Framed and inset, so an open fold reads as belonging to the button that
     opened it rather than as a band of chrome the sheet always carries. */
  optionsFold: {
    gap: 8,
    padding: 10,
    borderRadius: 10,
    backgroundColor: theme.surfaceMuted,
  },
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
  roundRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
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
  saveTrack: {
    gap: 6,
    padding: 10,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 10,
    backgroundColor: theme.surfaceMuted,
  },
  fieldLabel: { fontSize: 12, color: theme.textMuted, fontWeight: '600' },
  saveInput: {
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
    backgroundColor: theme.surface,
    color: theme.text,
    fontSize: 14,
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
  /* The result and its one action, on one line: the trip time leads, the rest
     of the numbers read beneath it, and Start sits beside them. It replaced a
     full-width accent slab directly under the stops that was the loudest thing
     on the sheet while the numbers it was about sat last, below six secondary
     buttons and well past the peek. */
  result: { gap: 6 },
  summaryRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  summaryFigures: { flexGrow: 1, flexShrink: 1, gap: 1 },
  /** The one number the sheet was opened for, so the one number set in display size. */
  summaryTime: { fontSize: 24, fontWeight: '700', color: theme.text },
  summaryDetail: { fontSize: 13, color: theme.textMuted },
  weatherWarning: { fontSize: 13, lineHeight: 18, color: theme.warning, fontWeight: '600' },
  selfStart: { alignSelf: 'flex-start' },
  /* Still the only accent-filled control on the sheet — primary by being the
     one thing that is coloured, not by being the widest. */
  navigate: {
    flexShrink: 0,
    backgroundColor: theme.accent,
    borderRadius: 10,
    // Sized down from a full-width band, but not below a thumb: this is the one
    // control that gets pressed in a car, so it keeps Android's 48dp minimum.
    minHeight: 48,
    minWidth: 92,
    paddingVertical: 13,
    paddingHorizontal: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  navigateText: { color: theme.onAccent, fontWeight: '700', fontSize: 15 },
  iconButton: { paddingHorizontal: 6, paddingVertical: 2 },
  iconText: { fontSize: 16, color: theme.text },
  iconDisabled: { color: theme.textMuted },
  actionRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  /* Square glyph buttons at Android's 44dp minimum: these are pressed with a
     thumb, on a sheet, often in a moving vehicle. */
  iconOnly: {
    width: 44,
    height: 44,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  /* In the fold the glyph keeps its words — that is where the actions a mode
     does not lead with live, and a row of unfamiliar icons is not a menu. */
  iconAction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minHeight: 40,
    borderRadius: 10,
    paddingHorizontal: 12,
  },
  iconActionText: { color: theme.text, fontWeight: '600' },
  button: {
    backgroundColor: theme.accent,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  buttonDisabled: { opacity: 0.5 },
  buttonText: { color: theme.onAccent, fontWeight: '600' },
  buttonQuiet: { backgroundColor: theme.surfaceMuted },
  /** A toolbar button whose panel is open, e.g. the stops browser. */
  buttonQuietOn: { backgroundColor: theme.accentFaint },
  buttonQuietText: { color: theme.text, fontWeight: '600' },
  /* The fold under "More": indented and ruled, so it reads as belonging to the
     row above rather than as a second toolbar of equal standing. */
  actionRowMore: {
    paddingLeft: 10,
    borderLeftWidth: 2,
    // Not `theme.border`: on Android that resolves to colorForeground, a
    // full-contrast rule where web's --border is a hairline. A faint accent
    // reads as "these belong to the button above" in both themes.
    borderLeftColor: theme.accentFaint,
  },
  error: { fontSize: 13, color: theme.danger },
  surfaceRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingTop: 4 },
  surfaceTitle: { fontSize: 12, color: theme.text, fontWeight: '700' },
  surfaceText: { fontSize: 12, color: theme.textMuted },
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
  stopStatus: { fontSize: 11, color: theme.textMuted, paddingHorizontal: 10, paddingVertical: 6 },
  /* Opened from the toolbar's "Stops along route" rather than from a disclosure
     of its own, so it needs the frame that button no longer gives it. */
  alongSearch: {
    alignItems: 'stretch',
    gap: 4,
    padding: 8,
    borderRadius: 10,
    backgroundColor: theme.surfaceMuted,
  },
  alongCategories: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  alongCategory: {
    borderRadius: 14,
    paddingHorizontal: 10,
    paddingVertical: 5,
    backgroundColor: theme.surfaceMuted,
    borderWidth: 1,
    borderColor: theme.border,
  },
  alongCategoryOn: { borderColor: theme.accent, backgroundColor: theme.surfaceActive },
  alongCategoryText: { fontSize: 12, color: theme.text, fontWeight: '600' },
});
