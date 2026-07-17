import {
  bboxOutlinesFeatureCollection,
  lineStringFeature,
  markerScaleForZoom,
  type LatLng,
} from '@atlas/core';
import {
  Camera,
  GeoJSONSource,
  Layer,
  Map as MapLibreMap,
  Marker,
  UserLocation,
  ViewAnnotation,
  type CameraRef,
  type MapRef,
} from '@maplibre/maplibre-react-native';
import { maneuverArrowsGeoJSON } from '@atlas/navigation';
import type { PlaceRecord } from '@atlas/storage';
import { useCallback, useMemo, useState, type RefObject } from 'react';
import { StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import type { NavController } from '../nav/useNavigation';
import type { LocalPack } from '../regions/packs';
import type { RoutePlanner } from '../routing/useRoute';
import type { DestinationTarget } from '../ui/DestinationCard';
import { PlacePin } from '../ui/icons';
import type { TrackGeometry } from '../useTrackGeometry';

/** Dashed rectangles showing what the downloaded offline packs cover. */
function packOutlinesGeoJSON(packs: LocalPack[]) {
  return bboxOutlinesFeatureCollection(
    packs.map((p) => ({ name: p.manifest.name, bbox: p.manifest.bbox })),
  );
}

/** Layer id of the planned-route line — App hit-tests taps on it to insert vias. */
export const PLAN_LINE_LAYER_ID = 'atlas-plan-line';

/** Layer ids of the nav route-choice preview — App hit-tests taps to switch choice. */
export const NAV_PREVIEW_LAYER_IDS = ['atlas-nav-preview-alt', 'atlas-nav-preview-sel'];

/** All route choices as one collection; `index` rides on each feature for tap pick. */
function previewRoutesGeoJSON(paths: { points: LatLng[] }[], selected: number) {
  return {
    type: 'FeatureCollection' as const,
    features: paths
      .map((path, index) => ({
        type: 'Feature' as const,
        properties: { index, selected: index === selected },
        geometry: {
          type: 'LineString' as const,
          coordinates: path.points.map((p) => [p.lng, p.lat]),
        },
      }))
      // Selected drawn last so it wins overlaps with the muted alternatives.
      .sort((a, b) => Number(a.properties.selected) - Number(b.properties.selected)),
  };
}

/** The default boot view (Oslo) when no camera has been persisted yet. */
export const DEFAULT_VIEW = { center: { lat: 59.91, lng: 10.75 }, zoom: 10 };

interface MapSceneProps {
  mapRef: RefObject<MapRef | null>;
  cameraRef: RefObject<CameraRef | null>;
  mapStyle: string;
  topInset: number;
  bottomInset: number;
  packs: LocalPack[];
  /** Geometry of the visible tracks (see useTrackGeometry). */
  trackGeo: TrackGeometry;
  nav: NavController;
  route: RoutePlanner;
  /** Picked destination awaiting the travel-mode card (red pin). */
  destination: DestinationTarget | null;
  visiblePlaces: PlaceRecord[];
  showPuck: boolean;
  /** Boot camera (persisted last view, falling back to DEFAULT_VIEW). */
  initialView: { center: LatLng; zoom: number };
  /** Every map tap (menu dismissal, plan stops, pin/POI hit-tests live in the app). */
  onMapPress: (point: LatLng, pixel: { x: number; y: number }) => void;
  /** Long-press outside route planning: pick the point as a destination. */
  onPickPoint: (point: LatLng) => void;
  /** The camera moved (persist-last-view + search bias read the latest value). */
  onViewChange: (view: { center: LatLng; zoom: number }) => void;
  /** A manual pan/zoom/rotate gesture (the nav follow camera pauses on it). */
  onUserGesture: () => void;
  /** The red destination pin was dragged to a new point. */
  onDestinationMoved: (point: LatLng) => void;
}

/**
 * The full-screen MapLibre scene: basemap, overlay line sources (pack
 * outlines, tracks, active nav route, planned route), the camera and every
 * marker. Interaction *policy* stays in App — the scene only reports presses.
 */
export function MapScene({
  mapRef,
  cameraRef,
  mapStyle,
  topInset,
  bottomInset,
  packs,
  trackGeo,
  nav,
  route,
  destination,
  visiblePlaces,
  showPuck,
  initialView,
  onMapPress,
  onPickPoint,
  onViewChange,
  onUserGesture,
  onDestinationMoved,
}: MapSceneProps) {
  const win = useWindowDimensions();
  // The follow camera itself lives in useNavCamera (App drives it through
  // cameraRef) — the scene only renders the puck and reports gestures.
  const following = nav.phase === 'navigating' || nav.phase === 'rerouting';

  // On-map turn arrows for the active route; turns already passed are hidden
  // by the alongM filter below rather than by rebuilding the geometry.
  const navArrows = useMemo(
    () => (nav.activePath ? maneuverArrowsGeoJSON(nav.activePath) : null),
    [nav.activePath],
  );
  // Quantized so the per-fix re-render only changes the filter/gradient when
  // the values move visibly.
  const traveledM = Math.round((nav.state?.traveledM ?? 0) / 10) * 10;
  const routeProgress = Math.min(
    0.999,
    Math.max(0.001, Math.round((nav.state?.routeProgress ?? 0) * 200) / 200),
  );

  const planning = route.active;
  // The routed line to draw while planning (selected path, primary or alt).
  const planPath = route.paths?.[route.selectedPath] ?? null;

  // Zoom-proportional pin size (web parity, see markerScaleForZoom). Quantized
  // to 0.05 steps so the continuous region events only re-render on real change.
  const [markerScale, setMarkerScale] = useState(() => markerScaleForZoom(10));
  const onRegionChange = useCallback((zoom: number) => {
    setMarkerScale(Math.round(markerScaleForZoom(zoom) * 20) / 20);
  }, []);
  // Scaling about the bottom-centre keeps the tail tip on the anchored coordinate.
  const pinScaleStyle = useMemo(
    () => ({ transform: [{ scale: markerScale }], transformOrigin: '50% 100%' }),
    [markerScale],
  );

  return (
    <MapLibreMap
      ref={mapRef}
      style={styles.map}
      mapStyle={mapStyle}
      // Edge-to-edge: the map draws behind the system nav bar, so lift the
      // MapLibre attribution ornament clear of it, left of the bottom-right
      // locate button. The MapLibre logo watermark is off (attribution stays).
      logo={false}
      attributionPosition={{ bottom: bottomInset + 8, right: 64 }}
      // Track the zoom for zoom-proportional pin sizes; a user-driven move
      // additionally pauses the nav follow camera (free look-around).
      onRegionIsChanging={(e) => {
        onRegionChange(e.nativeEvent.zoom);
        if (e.nativeEvent.userInteraction) onUserGesture();
      }}
      onRegionDidChange={(e) => {
        onRegionChange(e.nativeEvent.zoom);
        const [lng, lat] = e.nativeEvent.center;
        onViewChange({ center: { lat, lng }, zoom: e.nativeEvent.zoom });
      }}
      // The scale bar was lost in the maplibre-react-native v11 upgrade (the
      // default flipped to off). Android's native ScaleBarPlugin only anchors
      // top-left, so bottom-centre is expressed as top/left margins computed
      // from the window size; the native side adds the status-bar inset to
      // the top margin, so subtract it here. The bar keeps the middle of the
      // bottom edge, between the menu cluster and the locate button.
      scaleBar
      scaleBarPosition={{
        top: Math.max(0, Math.round(win.height - bottomInset - 88 - topInset)),
        left: Math.round(win.width * 0.3),
      }}
      // While planning a route, a tap drops a stop; otherwise a tap dismisses
      // the ☰ menu or picks a saved pin (see App.onMapPress). Long-press picks
      // any point as a destination. Both gestures add a stop in plan mode so it
      // feels the same as the web map click.
      onPress={(e) => {
        const [lng, lat] = e.nativeEvent.lngLat;
        const [x, y] = e.nativeEvent.point;
        onMapPress({ lat, lng }, { x, y });
      }}
      onLongPress={(e) => {
        const [lng, lat] = e.nativeEvent.lngLat;
        if (planning) {
          route.addWaypoint({ lat, lng });
          return;
        }
        onPickPoint({ lat, lng });
      }}
    >
      {/* Coverage of downloaded offline packs, so blank areas are explicable. */}
      {packs.length > 0 ? (
        <GeoJSONSource id="atlas-pack-outlines" data={packOutlinesGeoJSON(packs)}>
          <Layer
            type="line"
            id="atlas-pack-outlines-line"
            paint={{
              'line-color': '#1a73e8',
              'line-width': 1.5,
              'line-opacity': 0.45,
              'line-dasharray': [2, 2],
            }}
          />
        </GeoJSONSource>
      ) : null}
      {/* Saved/imported tracks (visible ones), drawn under the routes. */}
      {trackGeo.features.length > 0 ? (
        <GeoJSONSource id="atlas-tracks" data={trackGeo}>
          <Layer
            type="line"
            id="atlas-tracks-line"
            paint={{ 'line-color': '#2a78d6', 'line-width': 4, 'line-opacity': 0.9 }}
          />
        </GeoJSONSource>
      ) : null}
      {nav.routeCoords.length > 1 ? (
        <GeoJSONSource id="atlas-route" data={lineStringFeature(nav.routeCoords)} lineMetrics>
          <Layer
            type="line"
            id="atlas-route-line"
            layout={{ 'line-cap': 'round', 'line-join': 'round' }}
            paint={{
              'line-width': 6,
              'line-opacity': 0.85,
              // The stretch already driven greys out behind the car.
              'line-gradient': ['step', ['line-progress'], '#98a2b3', routeProgress, '#2b6cff'],
            }}
          />
        </GeoJSONSource>
      ) : null}
      {/* Turn arrows over the route (web-style white-on-blue): every remaining
          maneuver gets a short arrow across the turn plus an oriented head, so
          the turn is visible on the map itself, not only in the banner. */}
      {navArrows && navArrows.features.length > 0 ? (
        <GeoJSONSource id="atlas-nav-arrows" data={navArrows}>
          <Layer
            type="line"
            id="atlas-nav-arrows-casing"
            filter={[
              'all',
              ['==', ['get', 'kind'], 'body'],
              ['>', ['get', 'alongM'], traveledM - 10],
            ]}
            layout={{ 'line-cap': 'round', 'line-join': 'round' }}
            paint={{ 'line-color': '#16324f', 'line-width': 9, 'line-opacity': 0.9 }}
          />
          <Layer
            type="line"
            id="atlas-nav-arrows-line"
            filter={[
              'all',
              ['==', ['get', 'kind'], 'body'],
              ['>', ['get', 'alongM'], traveledM - 10],
            ]}
            layout={{ 'line-cap': 'round', 'line-join': 'round' }}
            paint={{ 'line-color': '#ffffff', 'line-width': 5 }}
          />
          {/* Arrowhead: the proven '›' glyph (see the plan-route chevrons)
              rotated from east-pointing to the tip's exit bearing. */}
          <Layer
            type="symbol"
            id="atlas-nav-arrows-head"
            filter={[
              'all',
              ['==', ['get', 'kind'], 'tip'],
              ['>', ['get', 'alongM'], traveledM - 10],
            ]}
            layout={{
              'text-field': '›',
              'text-font': ['Noto Sans Bold'],
              'text-size': 26,
              'text-rotate': ['-', ['get', 'bearingDeg'], 90],
              'text-rotation-alignment': 'map',
              'text-allow-overlap': true,
              'text-ignore-placement': true,
            }}
            paint={{
              'text-color': '#ffffff',
              'text-halo-color': '#16324f',
              'text-halo-width': 2,
            }}
          />
        </GeoJSONSource>
      ) : null}
      {/* Route choices before guidance starts: muted alternatives under the
          selected line; a tap on a grey line switches to it (App hit-tests
          NAV_PREVIEW_LAYER_IDS and calls nav.selectPreview). */}
      {nav.phase === 'preview' && nav.previewPaths ? (
        <GeoJSONSource
          id="atlas-nav-preview"
          data={previewRoutesGeoJSON(nav.previewPaths, nav.previewIndex)}
        >
          <Layer
            type="line"
            id="atlas-nav-preview-alt"
            filter={['!', ['to-boolean', ['get', 'selected']]]}
            paint={{ 'line-color': '#8f8f9d', 'line-width': 5, 'line-opacity': 0.8 }}
          />
          <Layer
            type="line"
            id="atlas-nav-preview-sel"
            filter={['to-boolean', ['get', 'selected']]}
            paint={{ 'line-color': '#2b6cff', 'line-width': 6, 'line-opacity': 0.9 }}
          />
        </GeoJSONSource>
      ) : null}
      {/* Planned route (route-planning panel): distinct colour from navigation. */}
      {planning && planPath ? (
        <GeoJSONSource
          id="atlas-plan"
          data={lineStringFeature(planPath.points.map((p) => [p.lng, p.lat]))}
        >
          <Layer
            type="line"
            id="atlas-plan-line"
            paint={{ 'line-color': '#7c3aed', 'line-width': 6, 'line-opacity': 0.85 }}
          />
          {/* Travel-direction chevrons — the only cue to which way a round
              trip runs. keep-upright must stay off or right-to-left segments
              would flip the glyph and point it backwards. */}
          <Layer
            type="symbol"
            id="atlas-plan-arrows"
            layout={{
              'symbol-placement': 'line',
              'symbol-spacing': 80,
              'text-field': '›',
              'text-font': ['Noto Sans Bold'],
              'text-size': 20,
              'text-offset': [0, -0.12],
              'text-keep-upright': false,
              'text-allow-overlap': true,
              'text-ignore-placement': true,
            }}
            paint={{ 'text-color': '#ffffff' }}
          />
        </GeoJSONSource>
      ) : null}
      {/* Waypoints are draggable (long-press, then drag — MapLibre Native's
          annotation drag gesture); releasing re-routes through the new point.
          ViewAnnotation, not Marker: only annotations support native dragging. */}
      {planning
        ? route.waypoints.map((w, i) => (
            <ViewAnnotation
              key={w.id}
              id={`waypoint-${w.id}`}
              lngLat={[w.pos.lng, w.pos.lat]}
              anchor="bottom"
              draggable
              onDragEnd={(e) => {
                const [lng, lat] = e.nativeEvent.lngLat;
                route.moveWaypointTo(w.id, { lat, lng });
              }}
            >
              <View style={styles.wpMarker}>
                <Text style={styles.wpMarkerText}>
                  {route.roundTrip || route.waypoints.length === 1
                    ? '⟳'
                    : i < 26
                      ? String.fromCharCode(65 + i)
                      : String(i + 1)}
                </Text>
              </View>
            </ViewAnnotation>
          ))
        : null}
      <Camera
        ref={cameraRef}
        initialViewState={{
          center: [initialView.center.lng, initialView.center.lat],
          zoom: initialView.zoom,
        }}
      />
      {following || showPuck ? <UserLocation heading={following} animated /> : null}
      {nav.destination ? (
        <Marker lngLat={[nav.destination.lng, nav.destination.lat]} anchor="bottom">
          <View style={pinScaleStyle}>
            <PlacePin color="#16324f" icon="🏁" />
          </View>
        </Marker>
      ) : destination ? (
        // Draggable (long-press + drag) so a picked point can be fine-tuned;
        // full-size on purpose: the annotation renders to a bitmap, so the
        // zoom-proportional transform the Markers use wouldn't refresh it.
        <ViewAnnotation
          id="destination-pin"
          lngLat={[destination.lng, destination.lat]}
          anchor="bottom"
          draggable
          onDragEnd={(e) => {
            const [lng, lat] = e.nativeEvent.lngLat;
            onDestinationMoved({ lat, lng });
          }}
        >
          <PlacePin color="#d33939" />
        </ViewAnnotation>
      ) : null}
      {/* Saved places as colour-badged teardrop pins (web-parity markers).
          The marker view itself never handles touches (they aren't delivered
          reliably) — taps fall through to the map, and App.onMapPress hit-tests
          the pins to open the destination card (Navigate / Edit). */}
      {visiblePlaces.map((place) => (
        <Marker key={place.id} lngLat={[place.lng, place.lat]} anchor="bottom">
          <View pointerEvents="none" testID={`place-pin-${place.id}`} style={pinScaleStyle}>
            <PlacePin color={place.color} icon={place.icon} />
          </View>
        </Marker>
      ))}
    </MapLibreMap>
  );
}

const styles = StyleSheet.create({
  map: { flex: 1 },
  wpMarker: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: '#7c3aed',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: '#fff',
  },
  wpMarkerText: { color: '#fff', fontWeight: '800', fontSize: 13 },
});
