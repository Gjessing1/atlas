import type { NavController } from '@atlas/app-hooks';
import {
  bboxOutlinesFeatureCollection,
  lineStringFeature,
  markerScaleForZoom,
  waypointLabel,
  type BBox,
  type LatLng,
} from '@atlas/core';
import {
  Camera,
  GeoJSONSource,
  Layer,
  Map as MapLibreMap,
  Marker,
  RasterSource,
  UserLocation,
  ViewAnnotation,
  type CameraRef,
  type MapRef,
} from '@maplibre/maplibre-react-native';
import { maneuverArrowsGeoJSON, navLineProgress } from '@atlas/navigation';
import type { PlaceRecord } from '@atlas/storage';
import { useCallback, useMemo, useState, type RefObject } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { HuntingFields } from '../layers/useHuntingFields';
import type { OverlayLabelData } from '../layers/useOverlayLabels';
import type { ActiveOverlay } from '../layers/useOverlays';
import type { SpeedCameras } from '../layers/useSpeedCameras';
import type { VectorOverlayData } from '../layers/useVectorOverlay';
import { spotsFeatureCollection, type PotentialSpot } from '@atlas/potential';
import { isRideMode, type TransitTrip } from '@atlas/transit';
import type { LocalPack } from '../regions/packs';
import type { RoutePlanner } from '../routing/useRoute';
import type { TransitPlan } from '../routing/useTransit';
import type { DestinationTarget } from '../ui/DestinationCard';
import { PlacePin } from '../ui/icons';
import { useSideInsets } from '../ui/insets';
import { MapCompass } from './MapCompass';
import { ScaleBar } from './ScaleBar';
import type { TrackGeometry } from '../useTrackGeometry';

/** Dashed rectangles showing what the downloaded offline packs cover. */
function packOutlinesGeoJSON(packs: LocalPack[]) {
  return bboxOutlinesFeatureCollection(
    packs.map((p) => ({ name: p.manifest.name, bbox: p.manifest.bbox })),
  );
}

/** Translucent rectangle while the user chooses a custom offline region. */
function selectedRegionGeoJSON(bbox: BBox) {
  const { sw, ne } = bbox;
  return {
    type: 'FeatureCollection' as const,
    features: [
      {
        type: 'Feature' as const,
        properties: {},
        geometry: {
          type: 'Polygon' as const,
          coordinates: [
            [
              [sw.lng, sw.lat],
              [ne.lng, sw.lat],
              [ne.lng, ne.lat],
              [sw.lng, ne.lat],
              [sw.lng, sw.lat],
            ],
          ],
        },
      },
    ],
  };
}

/** Layer id of the planned-route line — App hit-tests taps on it to insert vias. */
export const PLAN_LINE_LAYER_ID = 'atlas-plan-line';

/** Fill layer of the Statskog jaktfelt overlay — tapped for the field's identify card. */
export const HUNT_FIELDS_FILL_LAYER_ID = 'atlas-jaktfelt-fill';

/**
 * Layers of the ATK speed-camera overlay a tap can land on — the dot and the
 * average-speed line (its white casing is the wider target, so it is listed
 * too). Order matters: a point camera sitting on a section should identify as
 * the camera.
 */
export const SPEED_CAMERA_LAYER_IDS = [
  'atlas-cameras-point',
  'atlas-cameras-section',
  'atlas-cameras-section-casing',
];

/** Regobs marker layers hit-tested for exact observation time and details. */
export const ICE_OBSERVATION_LAYER_IDS = [
  'atlas-ice-observations-symbol',
  'atlas-ice-observations-dot',
];

/**
 * The numbered "best spots" discs. Drawn last of the overlay sources so they
 * sit above the derived surface they came from — a marker in the ramp's own hot
 * colour is invisible on top of it without the white halo *and* the ordering.
 */
export const SPOT_LAYER_ID = 'atlas-spots-disc';

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

/**
 * The selected journey as one collection: each leg carries its own colour and
 * whether it is a walk, so rides draw in the line's official colour and walks
 * draw dashed. A journey has no single geometry, so this is per-leg by nature.
 */
function transitLegsGeoJSON(trip: TransitTrip) {
  return {
    type: 'FeatureCollection' as const,
    features: trip.legs
      .filter((leg) => leg.points.length > 1)
      .map((leg) => ({
        type: 'Feature' as const,
        properties: {
          walk: !isRideMode(leg.mode),
          // No official colour means "we were not told one" — fall back to the
          // planned-route purple rather than inventing a brand colour.
          colour: leg.line?.colour ?? '#7c3aed',
        },
        geometry: {
          type: 'LineString' as const,
          coordinates: leg.points.map((p) => [p.lng, p.lat]),
        },
      })),
  };
}

/** Boarding/alighting points — where the traveller actually changes vehicle. */
function transitStopsGeoJSON(trip: TransitTrip) {
  return {
    type: 'FeatureCollection' as const,
    features: trip.legs
      .filter((leg) => isRideMode(leg.mode))
      .map((leg) => ({
        type: 'Feature' as const,
        properties: {},
        geometry: {
          type: 'Point' as const,
          coordinates: [leg.from.position.lng, leg.from.position.lat],
        },
      })),
  };
}

/** The default boot view (Oslo) when no camera has been persisted yet. */
export const DEFAULT_VIEW = { center: { lat: 59.91, lng: 10.75 }, zoom: 10 };

interface MapSceneProps {
  mapRef: RefObject<MapRef | null>;
  cameraRef: RefObject<CameraRef | null>;
  mapStyle: string;
  bottomInset: number;
  /** Native attribution button, kept outside whichever nav region is active. */
  attributionPosition: { top: number; left: number };
  packs: LocalPack[];
  /** Enabled catalog overlays (WMS rasters proxied by the backend). */
  overlays: ActiveOverlay[];
  /** Per-overlay label GeoJSON for the current viewport (see useOverlayLabels). */
  overlayLabels: OverlayLabelData;
  /** Statskog hunting-fields coverage to draw (null = overlay off / not loaded). */
  huntingFields: HuntingFields | null;
  /** Rolling Regobs markers for the current viewport. */
  iceObservations: VectorOverlayData | null;
  /** ATK speed-camera coverage to draw (null = overlay off / not loaded). */
  speedCameras: SpeedCameras | null;
  /** Numbered "best spots in view" markers; empty while the shortlist is closed. */
  spots: readonly PotentialSpot[];
  /** Geometry of the visible tracks (see useTrackGeometry). */
  trackGeo: TrackGeometry;
  /** First corner and completed rectangle while drawing a custom offline region. */
  offlineRegionCorner: LatLng | null;
  offlineRegionBbox: BBox | null;
  nav: NavController;
  route: RoutePlanner;
  /** Public transport plan — draws the selected journey instead of a road line. */
  transit: TransitPlan;
  /** Picked destination awaiting the travel-mode card (red pin). */
  destination: DestinationTarget | null;
  visiblePlaces: PlaceRecord[];
  showPuck: boolean;
  /** App is drawing its own nav puck — hide the native one. */
  suppressPuck: boolean;
  /**
   * Snapped position to draw the map-anchored nav dot at, for the stretches of
   * a trip when the follow camera isn't framing it (paused pan, overview) and
   * the screen-fixed chevron would therefore point at the wrong place. Null
   * whenever App is drawing the chevron instead.
   */
  navDot: LatLng | null;
  /** Boot camera (persisted last view, falling back to DEFAULT_VIEW). */
  initialView: { center: LatLng; zoom: number };
  /**
   * Whether the idle map chrome (locate, map setup row) is showing. The
   * reset-to-north compass joins that stack, so it comes and goes with it —
   * during navigation the guidance rail owns map orientation instead.
   */
  showIdleChrome: boolean;
  /**
   * True while the app is showing as a picture-in-picture window. Nothing but
   * the map itself belongs in a window that size, so the native attribution
   * button (the only map ornament that survives navigation) goes too — the full
   * app one tap away still carries it.
   */
  inPip: boolean;
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
  bottomInset,
  attributionPosition,
  packs,
  overlays,
  overlayLabels,
  huntingFields,
  iceObservations,
  speedCameras,
  spots,
  trackGeo,
  offlineRegionCorner,
  offlineRegionBbox,
  nav,
  route,
  transit,
  destination,
  visiblePlaces,
  showPuck,
  suppressPuck,
  navDot,
  initialView,
  showIdleChrome,
  inPip,
  onMapPress,
  onPickPoint,
  onViewChange,
  onUserGesture,
  onDestinationMoved,
}: MapSceneProps) {
  // The follow camera itself lives in useNavCamera (App drives it through
  // cameraRef) — the scene only renders the puck and reports gestures.
  const following = nav.phase === 'navigating' || nav.phase === 'rerouting';
  // The trip isn't over until the traveller taps Done: the arrival card stays
  // up while they finish the last few metres on foot or hunt for the entrance,
  // and a position marker that vanishes the moment we say "you have arrived"
  // is exactly when it is missed. The trip's own fix watch stays up through
  // arrival too, so `navDot` normally carries this and the native puck is only
  // the fallback for a trip that never got a position at all.
  const locating = following || showPuck || nav.phase === 'arrived';

  // On-map turn arrows for the active route; turns already passed are hidden
  // by the alongM filter below rather than by rebuilding the geometry.
  const navArrows = useMemo(
    () => (nav.activePath ? maneuverArrowsGeoJSON(nav.activePath) : null),
    [nav.activePath],
  );
  // Arrow filters can move in coarse metre steps. The route colour boundary
  // cannot: rounding by a percentage of the whole route made it jump tens or
  // hundreds of metres ahead on long trips. The core's display progress also
  // follows its latency-compensated puck, so the grey trail ends underneath it.
  const traveledM = Math.round((nav.state?.traveledM ?? 0) / 10) * 10;
  const routeProgress = navLineProgress(nav.state);

  const planning = route.active;
  // The map itself stays edge-to-edge under the system bars, but the controls
  // drawn on top of it start inside the landscape navigation bar (0 in portrait).
  const side = useSideInsets();
  // In transit mode the road line stands down so the map shows one answer.
  const transitTrip = transit.enabled ? transit.trip : null;
  // The routed line to draw while planning (selected path, primary or alt).
  const planPath = route.paths?.[route.selectedPath] ?? null;

  // Zoom-proportional pin size (web parity, see markerScaleForZoom). Quantized
  // to 0.05 steps so the continuous region events only re-render on real change.
  const [markerScale, setMarkerScale] = useState(() => markerScaleForZoom(10));
  // Scale-bar inputs, quantized for the same reason: zoom to 0.25 (the rounded
  // bar length only changes at whole steps anyway) and latitude to 1°, across
  // which cos(lat) moves well under a percent.
  const [scaleAt, setScaleAt] = useState({ lat: DEFAULT_VIEW.center.lat, zoom: 10 });
  // Which way the camera faces, for the reset-to-north compass. Quantized to
  // 2°, like the values above, so a rotate gesture re-renders the scene a few
  // times instead of on every frame; below 2° the map reads as north-up and the
  // compass takes itself away.
  const [bearing, setBearing] = useState(0);
  const onRegionChange = useCallback((zoom: number, lat: number, mapBearing: number) => {
    setMarkerScale(Math.round(markerScaleForZoom(zoom) * 20) / 20);
    setScaleAt((cur) => {
      const next = { lat: Math.round(lat), zoom: Math.round(zoom * 4) / 4 };
      return next.lat === cur.lat && next.zoom === cur.zoom ? cur : next;
    });
    setBearing((cur) => {
      const next = (Math.round(mapBearing / 2) * 2 + 360) % 360;
      return next === cur ? cur : next;
    });
  }, []);
  // Reset to north, keeping the view otherwise exactly as it is: the centre is
  // read back and handed to the same centre-anchored camera stop the locate
  // button uses (a stop with no centre at all is a less-travelled path in the
  // native camera queue, and this control must not move the map sideways).
  const faceNorth = useCallback(() => {
    void (async () => {
      const center = await mapRef.current?.getCenter().catch(() => undefined);
      if (!center) return;
      cameraRef.current?.easeTo({ center, bearing: 0, pitch: 0, duration: 400 });
    })();
  }, [cameraRef, mapRef]);
  // Scaling about the bottom-centre keeps the tail tip on the anchored coordinate.
  const pinScaleStyle = useMemo(
    () => ({ transform: [{ scale: markerScale }], transformOrigin: '50% 100%' }),
    [markerScale],
  );

  return (
    <View style={styles.map}>
      <MapLibreMap
        ref={mapRef}
        style={styles.map}
        mapStyle={mapStyle}
        // Keep the attribution control in the quiet top-left map corner. At
        // the bottom it competed with Atlas's menu, scale and locate controls.
        // The MapLibre logo watermark is off (attribution remains available).
        logo={false}
        attribution={!inPip}
        attributionPosition={attributionPosition}
        // Track the zoom for zoom-proportional pin sizes; a user-driven move
        // additionally pauses the nav follow camera (free look-around).
        onRegionIsChanging={(e) => {
          onRegionChange(e.nativeEvent.zoom, e.nativeEvent.center[1], e.nativeEvent.bearing);
          if (e.nativeEvent.userInteraction) onUserGesture();
        }}
        onRegionDidChange={(e) => {
          const [lng, lat] = e.nativeEvent.center;
          onRegionChange(e.nativeEvent.zoom, lat, e.nativeEvent.bearing);
          onViewChange({ center: { lat, lng }, zoom: e.nativeEvent.zoom });
        }}
        // The native ScaleBarPlugin is off for good: it reads metric vs imperial
        // from the device locale with no way to override through this library, so
        // an en-US phone showed feet. Atlas draws its own metric bar instead —
        // see ScaleBar below, positioned where this one used to sit.
        scaleBar={false}
        // The native compass ornament is off for the same kind of reason: it
        // only appears in a screen corner (top-right by default, i.e. behind
        // the navigation banner for a whole trip) and is drawn from a fixed
        // bitmap that ignores light/dark. MapCompass below is the Atlas one.
        compass={false}
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
        {/* Catalog overlays (hillshade, depths, trails, …): mounted first so
          they sit under every Atlas line/marker layer. maxzoom from the
          catalog caps requests — the map overzooms beyond it instead of
          hammering limited-depth upstreams. Vector overlays (the jaktfelt
          polygons) draw as their own GeoJSON source below, not as rasters. */}
        {overlays
          .filter((overlay) => !overlay.meta.vector)
          .map((overlay) => (
            <RasterSource
              // Keyed on the *variant* id, not the layer id: switching species
              // has to remount the source, or the native source keeps serving
              // the tiles it already loaded under the old filter.
              key={overlay.sourceId}
              id={overlay.sourceId}
              tiles={[overlay.tileUrlTemplate]}
              tileSize={256}
              maxzoom={overlay.meta.maxzoom}
              minzoom={overlay.meta.minzoom ?? 0}
              attribution={overlay.meta.attribution}
            >
              <Layer
                type="raster"
                id={`${overlay.sourceId}-layer`}
                paint={{ 'raster-opacity': overlay.opacity }}
              />
            </RasterSource>
          ))}
        {/* Attribute labels drawn over the raster — the number a tile can't
          carry (a surveyed lake's max depth). Mounted after the rasters so
          they read on top, and only while the overlay itself is on. */}
        {overlays.map((overlay) => {
          const labels = overlay.meta.labels;
          const data = labels ? overlayLabels[overlay.meta.id] : undefined;
          if (!labels || !data || data.features.length === 0) return null;
          return (
            <GeoJSONSource
              key={`labels-${overlay.meta.id}`}
              id={`atlas-overlay-labels-${overlay.meta.id}`}
              data={data}
            >
              <Layer
                type="symbol"
                id={`atlas-overlay-labels-${overlay.meta.id}-layer`}
                minzoom={labels.minzoom}
                layout={{
                  'text-field': ['get', 'label'],
                  'text-font': ['Noto Sans Bold'],
                  'text-size': 13,
                  // Sits below the anchor so it reads under the basemap's own
                  // lake name rather than through it — both are centred on the
                  // same water, and overlap-forcing alone stacked them.
                  'text-offset': [0, 1.4],
                  // Always drawn: added after the basemap's symbol layers, so
                  // with collision on it would lose placement and flicker.
                  'text-allow-overlap': true,
                  'text-ignore-placement': true,
                }}
                paint={{
                  'text-color': '#0b3d63',
                  'text-halo-color': '#ffffff',
                  'text-halo-width': 1.6,
                }}
              />
            </GeoJSONSource>
          );
        })}
        {/* Statskog storviltjaktfelt: state-forest big-game hunting fields as a
          faint rust fill with a firmer outline and the field name at closer
          zooms, the Fish & Hunt signature overlay. Drawn above the rasters but
          under the tracks/routes; a tap on the fill opens the field's identify
          card (see useMapPress → HUNT_FIELDS_FILL_LAYER_ID). */}
        {huntingFields ? (
          <GeoJSONSource id="atlas-jaktfelt" data={huntingFields.data}>
            <Layer
              type="fill"
              id={HUNT_FIELDS_FILL_LAYER_ID}
              paint={{ 'fill-color': '#c2410c', 'fill-opacity': 0.12 * huntingFields.opacity }}
            />
            <Layer
              type="line"
              id="atlas-jaktfelt-outline"
              layout={{ 'line-join': 'round' }}
              paint={{
                'line-color': '#c2410c',
                'line-width': ['interpolate', ['linear'], ['zoom'], 7, 1, 12, 2],
                'line-opacity': 0.9 * huntingFields.opacity,
              }}
            />
            <Layer
              type="symbol"
              id="atlas-jaktfelt-label"
              minzoom={9}
              layout={{
                'text-field': ['get', 'Feltnavn'],
                'text-font': ['Noto Sans Bold'],
                'text-size': 12,
                'text-max-width': 8,
                'text-optional': true,
              }}
              paint={{
                'text-color': '#7c2d12',
                'text-halo-color': '#ffffff',
                'text-halo-width': 1.4,
                'text-opacity': huntingFields.opacity,
              }}
            />
          </GeoJSONSource>
        ) : null}
        {/* Regobs ice observations: symbol = report kind, colour = age. Kept
          separate from the static weakened-ice raster so the map never makes
          an old hydropower hazard polygon look like a current field report. */}
        {iceObservations ? (
          <GeoJSONSource id="atlas-ice-observations" data={iceObservations.data}>
            <Layer
              type="circle"
              id="atlas-ice-observations-dot"
              minzoom={7}
              paint={{
                'circle-radius': ['interpolate', ['linear'], ['zoom'], 7, 7, 12, 10, 16, 12],
                'circle-color': ['get', 'markerColor'],
                'circle-stroke-width': 2,
                'circle-stroke-color': '#ffffff',
                'circle-opacity': iceObservations.opacity,
                'circle-stroke-opacity': iceObservations.opacity,
              }}
            />
            <Layer
              type="symbol"
              id="atlas-ice-observations-symbol"
              minzoom={7}
              layout={{
                'text-field': ['get', 'symbol'],
                'text-font': ['Noto Sans Bold'],
                'text-size': ['interpolate', ['linear'], ['zoom'], 7, 10, 12, 13, 16, 15],
                'text-allow-overlap': true,
                'text-ignore-placement': true,
              }}
              paint={{
                'text-color': '#ffffff',
                'text-halo-color': 'rgba(0,0,0,0.18)',
                'text-halo-width': 0.7,
                'text-opacity': iceObservations.opacity,
              }}
            />
          </GeoJSONSource>
        ) : null}
        {/* ATK speed cameras (web useSpeedCameraLayer's twin, same enforcement
          amber): fixed point cameras as dots, average-speed sections as lines
          with a white casing so they read over any road colour, names once
          zoomed in enough to be worth reading. This is the *map* layer — the
          spoken/visual warnings while navigating come from the pack's own
          camera tables (offlineNvdb) and work with no network. A tap on either
          opens the identify card (see useMapPress → SPEED_CAMERA_LAYER_IDS). */}
        {speedCameras ? (
          <GeoJSONSource id="atlas-cameras" data={speedCameras.data}>
            <Layer
              type="line"
              id="atlas-cameras-section-casing"
              filter={['==', ['get', 'kind'], 'section']}
              layout={{ 'line-cap': 'round', 'line-join': 'round' }}
              paint={{
                'line-color': '#ffffff',
                'line-width': 7,
                'line-opacity': 0.85 * speedCameras.opacity,
              }}
            />
            <Layer
              type="line"
              id="atlas-cameras-section"
              filter={['==', ['get', 'kind'], 'section']}
              layout={{ 'line-cap': 'round', 'line-join': 'round' }}
              paint={{
                'line-color': '#d97706',
                'line-width': 4,
                'line-opacity': speedCameras.opacity,
              }}
            />
            <Layer
              type="symbol"
              id="atlas-cameras-section-label"
              filter={['==', ['get', 'kind'], 'section']}
              minzoom={9}
              layout={{
                'symbol-placement': 'line',
                'text-field': ['coalesce', ['get', 'name'], 'Average speed control'],
                'text-font': ['Noto Sans Bold'],
                'text-size': 12,
                'text-offset': [0, 1],
              }}
              paint={{
                'text-color': '#8a4b04',
                'text-halo-color': '#ffffff',
                'text-halo-width': 1.4,
                'text-opacity': speedCameras.opacity,
              }}
            />
            <Layer
              type="circle"
              id="atlas-cameras-point"
              filter={['==', ['get', 'kind'], 'point']}
              paint={{
                'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, 3.5, 10, 6, 14, 8],
                'circle-color': '#d97706',
                'circle-stroke-width': 2,
                'circle-stroke-color': '#ffffff',
                'circle-opacity': speedCameras.opacity,
                'circle-stroke-opacity': speedCameras.opacity,
              }}
            />
            <Layer
              type="symbol"
              id="atlas-cameras-point-label"
              filter={['==', ['get', 'kind'], 'point']}
              minzoom={11}
              layout={{
                'text-field': ['get', 'name'],
                'text-font': ['Noto Sans Regular'],
                'text-size': 11.5,
                'text-offset': [0, 1.1],
                'text-anchor': 'top',
                'text-optional': true,
              }}
              paint={{
                'text-color': '#8a4b04',
                'text-halo-color': '#ffffff',
                'text-halo-width': 1.4,
                'text-opacity': speedCameras.opacity,
              }}
            />
          </GeoJSONSource>
        ) : null}
        {/* The numbered "best spots in view" markers (§N5 → E6). The numbers come
        from the shared `spotsFeatureCollection`, not from this file: a marker and
        its row in the sheet are the same recommendation, and numbering them
        per-client would break the only link between the two halves of it. */}
        {spots.length > 0 ? (
          <GeoJSONSource id="atlas-spots" data={spotsFeatureCollection(spots)}>
            <Layer
              type="circle"
              id="atlas-spots-halo"
              paint={{
                'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 13, 14, 18],
                'circle-color': '#ffffff',
                'circle-opacity': 0.9,
              }}
            />
            <Layer
              type="circle"
              id={SPOT_LAYER_ID}
              paint={{
                // The band's own colour, so a spot reads as the hot end of the
                // ramp it was found on.
                'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 10.5, 14, 15],
                'circle-color': ['get', 'color'],
                'circle-stroke-width': 1.5,
                'circle-stroke-color': '#ffffff',
              }}
            />
            <Layer
              type="symbol"
              id="atlas-spots-number"
              layout={{
                'text-field': ['get', 'label'],
                'text-font': ['Noto Sans Bold'],
                'text-size': ['interpolate', ['linear'], ['zoom'], 10, 12, 14, 15],
                'text-allow-overlap': true,
                'text-ignore-placement': true,
              }}
              paint={{ 'text-color': '#ffffff' }}
            />
          </GeoJSONSource>
        ) : null}
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
        {offlineRegionBbox ? (
          <GeoJSONSource
            id="atlas-offline-region-selection"
            data={selectedRegionGeoJSON(offlineRegionBbox)}
          >
            <Layer
              type="fill"
              id="atlas-offline-region-selection-fill"
              paint={{ 'fill-color': '#7c3aed', 'fill-opacity': 0.18 }}
            />
            <Layer
              type="line"
              id="atlas-offline-region-selection-line"
              paint={{ 'line-color': '#7c3aed', 'line-width': 3, 'line-dasharray': [2, 1] }}
            />
          </GeoJSONSource>
        ) : null}
        {/* Saved/imported tracks (visible ones), drawn under the routes. */}
        {trackGeo.features.length > 0 ? (
          <GeoJSONSource id="atlas-tracks" data={trackGeo}>
            <Layer
              type="fill"
              id="atlas-track-areas-fill"
              filter={['==', ['get', 'featureKind'], 'area']}
              paint={{ 'fill-color': '#c2410c', 'fill-opacity': 0.16 }}
            />
            <Layer
              type="line"
              id="atlas-tracks-line"
              filter={['==', ['get', 'featureKind'], 'line']}
              paint={{
                'line-color': ['case', ['==', ['get', 'recordKind'], 'area'], '#c2410c', '#2a78d6'],
                'line-width': 4,
                'line-opacity': 0.9,
              }}
            />
          </GeoJSONSource>
        ) : null}
        {nav.routeCoords.length > 1 ? (
          <GeoJSONSource id="atlas-route" data={lineStringFeature(nav.routeCoords)} lineMetrics>
            {/* Google-style solid blue with a darker casing; the line-gradient
              greys out the stretch already driven behind the car. */}
            <Layer
              type="line"
              id="atlas-route-casing"
              layout={{ 'line-cap': 'round', 'line-join': 'round' }}
              paint={{
                'line-width': 11,
                'line-gradient': ['step', ['line-progress'], '#7d8590', routeProgress, '#1557b0'],
              }}
            />
            <Layer
              type="line"
              id="atlas-route-line"
              layout={{ 'line-cap': 'round', 'line-join': 'round' }}
              paint={{
                'line-width': 7,
                'line-gradient': ['step', ['line-progress'], '#aab2bd', routeProgress, '#4285f4'],
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
        {planning && planPath && !transitTrip ? (
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
        {/* The selected public transport journey: rides in the line's own
          colour, walks dashed, boarding points ringed. Drawn instead of the
          planned road line, never alongside it. */}
        {planning && transitTrip ? (
          <>
            <GeoJSONSource id="atlas-transit" data={transitLegsGeoJSON(transitTrip)}>
              <Layer
                type="line"
                id="atlas-transit-walk"
                filter={['to-boolean', ['get', 'walk']]}
                paint={{
                  'line-color': '#5f6773',
                  'line-width': 4,
                  'line-opacity': 0.9,
                  'line-dasharray': [1, 1.6],
                }}
              />
              <Layer
                type="line"
                id="atlas-transit-ride"
                filter={['!', ['to-boolean', ['get', 'walk']]]}
                paint={{
                  'line-color': ['get', 'colour'],
                  'line-width': 6,
                  'line-opacity': 0.95,
                }}
              />
            </GeoJSONSource>
            <GeoJSONSource id="atlas-transit-stops" data={transitStopsGeoJSON(transitTrip)}>
              <Layer
                type="circle"
                id="atlas-transit-stop-dots"
                paint={{
                  'circle-radius': 5,
                  'circle-color': '#ffffff',
                  'circle-stroke-color': '#1a1a1a',
                  'circle-stroke-width': 2,
                }}
              />
            </GeoJSONSource>
          </>
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
                  {/* The panel's row and this pin must say the same thing, so
                    both read the one label function. */}
                  <Text style={styles.wpMarkerText}>
                    {waypointLabel(i, route.roundTrip, route.waypoints.length)}
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
        {!suppressPuck && locating ? <UserLocation heading={following} animated /> : null}
        {/* Map-anchored nav dot: the honest marker while the follow camera is
            paused or in overview. Directionless on purpose — the map carries
            whatever bearing the user left it at, so an arrow drawn here would
            be rotated twice and point at a road we aren't on. */}
        {navDot ? (
          <Marker lngLat={[navDot.lng, navDot.lat]} anchor="center">
            <View style={styles.navDot} />
          </Marker>
        ) : null}
        {offlineRegionCorner && !offlineRegionBbox ? (
          <Marker lngLat={[offlineRegionCorner.lng, offlineRegionCorner.lat]} anchor="center">
            <View style={styles.regionCorner} />
          </Marker>
        ) : null}
        {/* Via stops still ahead on a multi-stop trip: dots on the line,
            quieter than the destination flag; each disappears once passed. */}
        {nav.destination
          ? nav.viaPoints.slice(nav.state?.viasPassed ?? 0).map((via, i) => (
              <Marker key={`nav-via-${i}`} lngLat={[via.lng, via.lat]} anchor="center">
                <View style={styles.navVia} />
              </Marker>
            ))
          : null}
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

      {/* Sits where the native bar used to: middle of the bottom edge, between
          the menu cluster and the locate button. Hidden during turn-by-turn —
          dead weight on a driving screen. */}
      {nav.phase === 'idle' ? (
        <ScaleBar
          lat={scaleAt.lat}
          zoom={scaleAt.zoom}
          bottom={bottomInset + 88}
          left={side.left + 20}
        />
      ) : null}

      {/* Directly above App's locate button (bottom + 24, height 44), sharing
          its right edge — one bottom-right stack rather than a control that
          floats mid-map. */}
      {showIdleChrome && bearing !== 0 ? (
        <MapCompass
          bearing={bearing}
          bottom={bottomInset + 78}
          right={side.right + 12}
          onPress={faceNorth}
        />
      ) : null}
    </View>
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
  navDot: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: '#1a73e8',
    borderWidth: 3,
    borderColor: '#fff',
    elevation: 4,
  },
  navVia: {
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: '#1557b0',
    borderWidth: 3,
    borderColor: '#fff',
    elevation: 3,
  },
  regionCorner: {
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: '#7c3aed',
    borderWidth: 3,
    borderColor: '#fff',
    elevation: 4,
  },
});
