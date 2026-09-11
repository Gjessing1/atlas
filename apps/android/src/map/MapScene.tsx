import type { NavController } from '@atlas/app-hooks';
import {
  bboxOutlinesFeatureCollection,
  exploreResultsFeatureCollection,
  lineStringFeature,
  markerScaleForZoom,
  routeDeltaLabel,
  savedStandFeatures,
  waypointLabel,
  type BBox,
  type LatLng,
  type SearchResult,
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
import { useCallback, useMemo, useRef, useState, type RefObject } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { HuntingFields } from '../layers/useHuntingFields';
import type { OverlayLabelData } from '../layers/useOverlayLabels';
import type { ActiveOverlay } from '../layers/useOverlays';
import type { SatelliteLayerData } from '../layers/useSatellites';
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

/** Live DATEX markers hit-tested for their verbatim NPRA message. */
export const TRAFFIC_LAYER_IDS = ['atlas-traffic-symbol', 'atlas-traffic-dot'];

/** Measured congestion corridors hit-tested for their travel time. */
export const TRAFFIC_FLOW_LAYER_IDS = ['atlas-traffic-flow-line'];

/** Live Entur vehicles hit-tested for line, delay and occupancy. */
export const TRANSIT_VEHICLE_LAYER_IDS = [
  'atlas-transit-vehicles-label',
  'atlas-transit-vehicles-dot',
];

/** Regobs marker layers hit-tested for exact observation time and details. */
export const ICE_OBSERVATION_LAYER_IDS = [
  'atlas-ice-observations-symbol',
  'atlas-ice-observations-dot',
];

/** Moving satellite dots hit-tested by useMapPress. */
export const SATELLITE_LAYER_IDS = [
  'atlas-satellites-label',
  'atlas-satellites-dot',
  'atlas-starlink-label',
  'atlas-starlink-dot',
];

/**
 * The numbered "best spots" discs. Drawn last of the overlay sources so they
 * sit above the derived surface they came from — a marker in the ramp's own hot
 * colour is invisible on top of it without the white halo *and* the ordering.
 */
export const SPOT_LAYER_ID = 'atlas-spots-disc';

/** Numbered nearby-result discs; App hit-tests these with a finger-sized radius. */
export const EXPLORE_RESULT_LAYER_ID = 'atlas-explore-results-disc';

/** Layer ids of the nav route-choice preview — App hit-tests taps to switch choice. */
export const NAV_PREVIEW_LAYER_IDS = ['atlas-nav-preview-alt', 'atlas-nav-preview-sel'];

/** Grey in-drive route branches and their relative-time badges. */
export const NAV_ALTERNATIVE_LAYER_IDS = [
  'atlas-nav-alternatives-casing',
  'atlas-nav-alternatives-line',
  'atlas-nav-alternatives-label',
];

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

function navigationAlternativesGeoJSON(alternatives: NavController['routeAlternatives']) {
  return {
    type: 'FeatureCollection' as const,
    features: alternatives.flatMap((alternative, index) => [
      {
        type: 'Feature' as const,
        properties: { kind: 'line', index },
        geometry: {
          type: 'LineString' as const,
          coordinates: alternative.path.points.map((point) => [point.lng, point.lat]),
        },
      },
      {
        type: 'Feature' as const,
        properties: { kind: 'label', index, label: routeDeltaLabel(alternative.deltaMs) },
        geometry: {
          type: 'Point' as const,
          coordinates: [alternative.labelAt.lng, alternative.labelAt.lat],
        },
      },
    ]),
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

/** The measure tool's cyan — deliberately neither the route purple nor the
 *  enforcement amber, and the same value the web tool draws with. */
const MEASURE_COLOR = '#0e7490';

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
  /** Stations + naked-eye catalog, propagated on the device. */
  satellites: SatelliteLayerData;
  /** Starlink constellation, kept behind its own catalog switch. */
  starlink: SatelliteLayerData;
  /** ATK speed-camera coverage to draw (null = overlay off / not loaded). */
  speedCameras: SpeedCameras | null;
  /** Live DATEX traffic markers (null when the layer is off/offline). */
  traffic: VectorOverlayData | null;
  /** Measured corridor congestion (null when the layer is off/offline). */
  trafficFlow: VectorOverlayData | null;
  /** Live public-transport vehicles in the current viewport. */
  transitVehicles: VectorOverlayData | null;
  /** Numbered "best spots in view" markers; empty while the shortlist is closed. */
  spots: readonly PotentialSpot[];
  /** Numbered category-browse results, retained while the picked card is open. */
  exploreResults: readonly SearchResult[];
  /** The measure tool's ruler/rings while it is open, else null. */
  measure: GeoJSON.FeatureCollection | null;
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
  /** Full-screen map rectangle used as Android's PiP transition source. */
  onMapRect?: (rect: { x: number; y: number; width: number; height: number }) => void;
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
  satellites,
  starlink,
  speedCameras,
  traffic,
  trafficFlow,
  transitVehicles,
  spots,
  exploreResults,
  measure,
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
  onMapRect,
  onMapPress,
  onPickPoint,
  onViewChange,
  onUserGesture,
  onDestinationMoved,
}: MapSceneProps) {
  const mapViewportRef = useRef<View>(null);
  const measureMapViewport = useCallback(() => {
    requestAnimationFrame(() => {
      mapViewportRef.current?.measureInWindow((x, y, width, height) => {
        if (width > 0 && height > 0) onMapRect?.({ x, y, width, height });
      });
    });
  }, [onMapRect]);
  // The follow camera itself lives in useNavCamera (App drives it through
  // cameraRef) — the scene only renders the puck and reports gestures.
  const following =
    nav.phase === 'exploring' || nav.phase === 'navigating' || nav.phase === 'rerouting';
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
  // cannot: rounding or using the guidance layer's real-metre fraction can
  // move it far ahead on long/northbound trips. The core instead supplies the
  // exact MapLibre line metric at its puck, so grey ends underneath it.
  const traveledM = Math.round((nav.state?.traveledM ?? 0) / 10) * 10;
  const routeProgress = navLineProgress(nav.state);

  const planning = route.active;
  // The map itself stays edge-to-edge under the system bars, but the controls
  // drawn on top of it start inside the landscape navigation bar (0 in portrait).
  const side = useSideInsets();
  // In transit mode the road line stands down so the map shows one answer.
  const transitTrip = transit.guidanceTrip ?? (transit.enabled ? transit.trip : null);
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
  // Memoised because it is a source's `data`: rebuilding the collection on every
  // render of the place list would re-upload the geometry on every render too.
  const savedStands = useMemo(
    () => savedStandFeatures(visiblePlaces.filter((place) => place.stand)),
    [visiblePlaces],
  );

  return (
    <View ref={mapViewportRef} style={styles.map} onLayout={measureMapViewport}>
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
        {!inPip
          ? overlays
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
              ))
          : null}
        {/* Attribute labels drawn over the raster — the number a tile can't
          carry (a surveyed lake's max depth). Mounted after the rasters so
          they read on top, and only while the overlay itself is on. */}
        {!inPip
          ? overlays.map((overlay) => {
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
            })
          : null}
        {/* Statskog storviltjaktfelt: state-forest big-game hunting fields as a
          faint rust fill with a firmer outline and the field name at closer
          zooms, the Fish & Hunt signature overlay. Drawn above the rasters but
          under the tracks/routes; a tap on the fill opens the field's identify
          card (see useMapPress → HUNT_FIELDS_FILL_LAYER_ID). */}
        {!inPip && huntingFields ? (
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
        {!inPip && iceObservations ? (
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
        {/* Orbital elements arrive only on refresh; every position between
          them is propagated here on the device. Yellow is sunlit, slate is in
          shadow, purple is a batch launched days ago and still flying nose to
          tail (bright sunlit, dim in shadow — hue carries the train so
          brightness can keep carrying the light), and the selected object's
          cyan track is the one the pass sheet is describing. */}
        {!inPip
          ? [satellites, starlink].map((satelliteLayer) =>
              satelliteLayer.active && satelliteLayer.data ? (
                <GeoJSONSource
                  key={satelliteLayer.layerId}
                  id={`atlas-${satelliteLayer.layerId}`}
                  data={satelliteLayer.data}
                >
                  {/* Under the track and dots: the ground this object can
                    currently be seen from. Selection blue, never recoloured by
                    whether the user is inside it — colour on this layer means
                    sunlight, and the sheet says the personal half in words. */}
                  <Layer
                    type="fill"
                    id={`atlas-${satelliteLayer.layerId}-footprint`}
                    filter={['==', ['get', 'footprint'], true]}
                    paint={{
                      'fill-color': '#38bdf8',
                      'fill-opacity': 0.12 * satelliteLayer.opacity,
                    }}
                  />
                  <Layer
                    type="line"
                    id={`atlas-${satelliteLayer.layerId}-footprint-edge`}
                    filter={['==', ['get', 'footprint'], true]}
                    layout={{ 'line-cap': 'round', 'line-join': 'round' }}
                    paint={{
                      'line-color': '#38bdf8',
                      'line-width': 1.5,
                      'line-opacity': 0.7 * satelliteLayer.opacity,
                    }}
                  />
                  <Layer
                    type="line"
                    id={`atlas-${satelliteLayer.layerId}-track`}
                    filter={['==', ['get', 'track'], true]}
                    layout={{ 'line-cap': 'round', 'line-join': 'round' }}
                    paint={{
                      'line-color': ['case', ['get', 'selected'], '#38bdf8', '#fbbf24'],
                      'line-width': [
                        'interpolate',
                        ['linear'],
                        ['zoom'],
                        2,
                        ['case', ['get', 'selected'], 2, 1],
                        8,
                        ['case', ['get', 'selected'], 3, 2],
                      ],
                      'line-opacity': [
                        'case',
                        ['get', 'selected'],
                        0.85 * satelliteLayer.opacity,
                        0.45 * satelliteLayer.opacity,
                      ],
                      'line-dasharray': [2, 2],
                    }}
                  />
                  <Layer
                    type="circle"
                    id={`atlas-${satelliteLayer.layerId}-dot`}
                    // Both clauses matter: a circle layer draws one circle per
                    // *vertex*, so without the footprint exclusion the ring
                    // would come out as a necklace of stray dots.
                    filter={[
                      'all',
                      ['!=', ['get', 'track'], true],
                      ['!=', ['get', 'footprint'], true],
                    ]}
                    paint={{
                      // A fresh train is a group like the stations are, and
                      // sizes between them and an anonymous object: two dozen
                      // 2 px dots would be a colour nobody ever sees.
                      'circle-radius': [
                        'interpolate',
                        ['linear'],
                        ['zoom'],
                        2,
                        [
                          'case',
                          ['get', 'selected'],
                          7,
                          ['get', 'station'],
                          5,
                          ['get', 'train'],
                          3,
                          2,
                        ],
                        8,
                        [
                          'case',
                          ['get', 'selected'],
                          11,
                          ['get', 'station'],
                          9,
                          ['get', 'train'],
                          6,
                          4,
                        ],
                      ],
                      'circle-color': ['get', 'color'],
                      'circle-stroke-width': [
                        'case',
                        ['get', 'selected'],
                        3,
                        ['get', 'station'],
                        2,
                        0,
                      ],
                      'circle-stroke-color': ['case', ['get', 'selected'], '#38bdf8', '#ffffff'],
                      'circle-opacity': satelliteLayer.opacity,
                      'circle-stroke-opacity': satelliteLayer.opacity,
                    }}
                  />
                  <Layer
                    type="symbol"
                    id={`atlas-${satelliteLayer.layerId}-label`}
                    filter={[
                      'all',
                      ['!=', ['get', 'track'], true],
                      ['!=', ['get', 'footprint'], true],
                      ['==', ['get', 'station'], true],
                    ]}
                    layout={{
                      'text-field': ['get', 'name'],
                      'text-font': ['Noto Sans Bold'],
                      'text-size': 12,
                      'text-offset': [0, 1.2],
                      'text-anchor': 'top',
                      'text-allow-overlap': false,
                    }}
                    paint={{
                      'text-color': '#f8fafc',
                      'text-halo-color': 'rgba(15,23,42,0.85)',
                      'text-halo-width': 1.2,
                      'text-opacity': satelliteLayer.opacity,
                    }}
                  />
                </GeoJSONSource>
              ) : null,
            )
          : null}
        {/* ATK speed cameras (web useSpeedCameraLayer's twin, same enforcement
          amber): fixed point cameras as dots, average-speed sections as lines
          with a white casing so they read over any road colour, names once
          zoomed in enough to be worth reading. This is the *map* layer — the
          spoken/visual warnings while navigating come from the pack's own
          camera tables (offlineNvdb) and work with no network. A tap on either
          opens the identify card (see useMapPress → SPEED_CAMERA_LAYER_IDS). */}
        {!inPip && speedCameras ? (
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
        {/* How the measured corridors are running. Drawn before the incident
          markers so those stay on top, and offset right of the direction of
          travel: every corridor has a reverse twin over the same road (median
          13 m apart), so without the offset one direction hides the other. */}
        {!inPip && trafficFlow ? (
          <GeoJSONSource id="atlas-traffic-flow" data={trafficFlow.data}>
            <Layer
              type="line"
              id="atlas-traffic-flow-line"
              minzoom={6}
              layout={{ 'line-cap': 'round', 'line-join': 'round' }}
              paint={{
                'line-color': ['get', 'color'],
                // Thinner and fainter where NPRA has no reading: the line has
                // to be visible (its absence would read as "no corridor here")
                // without competing with the corridors that measured something.
                // The `case` goes inside the zoom stops because a `zoom`
                // expression may only be the direct input of a top-level
                // interpolate — wrapping it in a multiply is rejected outright.
                'line-width': [
                  'interpolate',
                  ['linear'],
                  ['zoom'],
                  6,
                  ['case', ['==', ['get', 'level'], 'unmeasured'], 1.4, 2.5],
                  11,
                  ['case', ['==', ['get', 'level'], 'unmeasured'], 2.2, 4],
                  16,
                  ['case', ['==', ['get', 'level'], 'unmeasured'], 3.8, 7],
                ],
                'line-offset': ['interpolate', ['linear'], ['zoom'], 6, 1.5, 11, 2.5, 16, 4.5],
                'line-opacity': [
                  'case',
                  ['==', ['get', 'level'], 'unmeasured'],
                  trafficFlow.opacity * 0.5,
                  trafficFlow.opacity,
                ],
              }}
            />
          </GeoJSONSource>
        ) : null}
        {/* Participating Entur realtime feeds, refreshed in the settled viewport. */}
        {!inPip && transitVehicles ? (
          <GeoJSONSource id="atlas-transit-vehicles" data={transitVehicles.data}>
            <Layer
              type="circle"
              id="atlas-transit-vehicles-dot"
              minzoom={8}
              paint={{
                'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 4, 12, 7, 16, 9],
                'circle-color': ['get', 'markerColor'],
                'circle-stroke-color': '#ffffff',
                'circle-stroke-width': 2,
                'circle-opacity': transitVehicles.opacity,
                'circle-stroke-opacity': transitVehicles.opacity,
              }}
            />
            <Layer
              type="symbol"
              id="atlas-transit-vehicles-label"
              minzoom={10}
              layout={{
                'text-field': ['get', 'line'],
                'text-font': ['Noto Sans Bold'],
                'text-size': ['interpolate', ['linear'], ['zoom'], 10, 10, 15, 12],
                'text-offset': [0, 1.35],
                'text-anchor': 'top',
                'text-optional': true,
              }}
              paint={{
                'text-color': '#172033',
                'text-halo-color': '#ffffff',
                'text-halo-width': 1.5,
                'text-opacity': transitVehicles.opacity,
              }}
            />
          </GeoJSONSource>
        ) : null}
        {/* Live DATEX II closures, works and incidents. NPRA message text is
          shown verbatim by the tap card; marker colour/type is shared with web. */}
        {!inPip && traffic ? (
          <GeoJSONSource id="atlas-traffic" data={traffic.data}>
            <Layer
              type="circle"
              id="atlas-traffic-dot"
              minzoom={6}
              paint={{
                'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 5, 11, 8, 16, 11],
                'circle-color': ['get', 'markerColor'],
                'circle-stroke-color': '#ffffff',
                'circle-stroke-width': 2,
                'circle-opacity': traffic.opacity,
                'circle-stroke-opacity': traffic.opacity,
              }}
            />
            <Layer
              type="symbol"
              id="atlas-traffic-symbol"
              minzoom={6}
              layout={{
                'text-field': ['get', 'symbol'],
                'text-font': ['Noto Sans Bold'],
                'text-size': ['interpolate', ['linear'], ['zoom'], 6, 10, 11, 14, 16, 17],
                'text-allow-overlap': true,
                'text-ignore-placement': true,
              }}
              paint={{ 'text-color': '#ffffff', 'text-opacity': traffic.opacity }}
            />
          </GeoJSONSource>
        ) : null}
        {/* The numbered "best spots in view" markers (FISH-HUNT-ENGINE.md § UX). The numbers come
        from the shared `spotsFeatureCollection`, not from this file: a marker and
        its row in the sheet are the same recommendation, and numbering them
        per-client would break the only link between the two halves of it. */}
        {!inPip && spots.length > 0 ? (
          <GeoJSONSource id="atlas-spots" data={spotsFeatureCollection(spots)}>
            <Layer
              type="line"
              id="atlas-spots-lanes"
              filter={['==', ['get', 'kind'], 'lane']}
              paint={{
                'line-color': '#ffffff',
                'line-width': 2,
                'line-opacity': 0.72,
              }}
            />
            <Layer
              type="line"
              id="atlas-spots-aim"
              filter={['==', ['get', 'kind'], 'aim']}
              paint={{
                'line-color': '#f59e0b',
                'line-width': 3,
                'line-opacity': 0.95,
                'line-dasharray': [2, 1.5],
              }}
            />
            <Layer
              type="circle"
              id="atlas-spots-halo"
              filter={['==', ['get', 'kind'], 'spot']}
              paint={{
                'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 13, 14, 18],
                'circle-color': '#ffffff',
                'circle-opacity': 0.9,
              }}
            />
            <Layer
              type="circle"
              id={SPOT_LAYER_ID}
              filter={['==', ['get', 'kind'], 'spot']}
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
              filter={['==', ['get', 'kind'], 'spot']}
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
        {!inPip && exploreResults.length > 0 ? (
          <GeoJSONSource
            id="atlas-explore-results"
            data={exploreResultsFeatureCollection(exploreResults)}
          >
            <Layer
              type="circle"
              id="atlas-explore-results-halo"
              paint={{
                'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 13, 14, 18],
                'circle-color': '#ffffff',
                'circle-opacity': 0.92,
              }}
            />
            <Layer
              type="circle"
              id={EXPLORE_RESULT_LAYER_ID}
              paint={{
                'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 10.5, 14, 15],
                'circle-color': '#0e7490',
                'circle-stroke-color': '#ffffff',
                'circle-stroke-width': 1.5,
              }}
            />
            <Layer
              type="symbol"
              id="atlas-explore-results-number"
              layout={{
                'text-field': ['get', 'label'],
                'text-font': ['Noto Sans Bold'],
                'text-size': ['interpolate', ['linear'], ['zoom'], 8, 11, 14, 14],
                'text-allow-overlap': true,
                'text-ignore-placement': true,
              }}
              paint={{ 'text-color': '#ffffff' }}
            />
          </GeoJSONSource>
        ) : null}
        {/* Coverage of downloaded offline packs, so blank areas are explicable. */}
        {!inPip && packs.length > 0 ? (
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
        {!inPip && offlineRegionBbox ? (
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
        {!inPip && trackGeo.features.length > 0 ? (
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
        {!inPip && nav.routeAlternatives.length > 0 ? (
          <GeoJSONSource
            id="atlas-nav-alternatives"
            data={navigationAlternativesGeoJSON(nav.routeAlternatives)}
          >
            <Layer
              type="line"
              id="atlas-nav-alternatives-casing"
              filter={['==', ['get', 'kind'], 'line']}
              layout={{ 'line-cap': 'round', 'line-join': 'round' }}
              paint={{ 'line-color': '#ffffff', 'line-width': 9, 'line-opacity': 0.9 }}
            />
            <Layer
              type="line"
              id="atlas-nav-alternatives-line"
              filter={['==', ['get', 'kind'], 'line']}
              layout={{ 'line-cap': 'round', 'line-join': 'round' }}
              paint={{ 'line-color': '#7d8590', 'line-width': 5, 'line-opacity': 0.95 }}
            />
            <Layer
              type="symbol"
              id="atlas-nav-alternatives-label"
              filter={['==', ['get', 'kind'], 'label']}
              layout={{
                'text-field': ['get', 'label'],
                'text-font': ['Noto Sans Bold'],
                'text-size': 13,
                'text-allow-overlap': true,
                'text-ignore-placement': true,
              }}
              paint={{
                'text-color': '#374151',
                'text-halo-color': '#ffffff',
                'text-halo-width': 5,
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
                'line-width': inPip ? 7 : 11,
                'line-gradient': ['step', ['line-progress'], '#7d8590', routeProgress, '#1557b0'],
              }}
            />
            <Layer
              type="line"
              id="atlas-route-line"
              layout={{ 'line-cap': 'round', 'line-join': 'round' }}
              paint={{
                'line-width': inPip ? 4 : 7,
                'line-gradient': ['step', ['line-progress'], '#aab2bd', routeProgress, '#4285f4'],
              }}
            />
          </GeoJSONSource>
        ) : null}
        {/* Turn arrows over the route (web-style white-on-blue): every remaining
          maneuver gets a short arrow across the turn plus an oriented head, so
          the turn is visible on the map itself, not only in the banner. */}
        {!inPip && navArrows && navArrows.features.length > 0 ? (
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
        {!inPip && nav.phase === 'preview' && nav.previewPaths ? (
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
        {!inPip && planning && planPath && !transitTrip ? (
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
        {!inPip && transitTrip ? (
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
        {/* The measure tool's ruler and range rings, in a cyan distinct from the
          route purple and the enforcement amber. Mounted last of the sources so
          a measurement is always readable over whatever it is measuring, and
          filtered on the same `kind` properties the web tool uses — both scenes
          draw one `measureFeatures()` collection. */}
        {!inPip && measure ? (
          <GeoJSONSource id="atlas-measure" data={measure}>
            <Layer
              type="fill"
              id="atlas-measure-ring-fill"
              filter={['==', ['get', 'kind'], 'ring']}
              paint={{ 'fill-color': MEASURE_COLOR, 'fill-opacity': 0.08 }}
            />
            <Layer
              type="line"
              id="atlas-measure-ring-line"
              filter={['==', ['get', 'kind'], 'ring']}
              layout={{ 'line-join': 'round' }}
              paint={{
                'line-color': MEASURE_COLOR,
                'line-width': 1.8,
                'line-dasharray': [3, 2],
              }}
            />
            <Layer
              type="line"
              id="atlas-measure-path"
              filter={['==', ['get', 'kind'], 'path']}
              layout={{ 'line-cap': 'round', 'line-join': 'round' }}
              paint={{ 'line-color': MEASURE_COLOR, 'line-width': 3 }}
            />
            <Layer
              type="circle"
              id="atlas-measure-points"
              filter={['==', ['get', 'kind'], 'point']}
              paint={{
                'circle-radius': 5,
                'circle-color': '#ffffff',
                'circle-stroke-color': MEASURE_COLOR,
                'circle-stroke-width': 2.5,
              }}
            />
            <Layer
              type="symbol"
              id="atlas-measure-labels"
              filter={['==', ['get', 'kind'], 'label']}
              layout={{
                'text-field': ['get', 'text'],
                'text-font': ['Noto Sans Bold'],
                'text-size': 12.5,
                'text-offset': [0, -1.2],
                'text-anchor': 'bottom',
                // A measure tool must always show its numbers: nearby rings
                // (100/200 m) and dense vertices otherwise lose their labels
                // to symbol collision.
                'text-allow-overlap': true,
                'text-ignore-placement': true,
              }}
              paint={{
                'text-color': MEASURE_COLOR,
                'text-halo-color': '#ffffff',
                'text-halo-width': 1.6,
              }}
            />
          </GeoJSONSource>
        ) : null}
        {/* Waypoints are draggable (long-press, then drag — MapLibre Native's
          annotation drag gesture); releasing re-routes through the new point.
          ViewAnnotation, not Marker: only annotations support native dragging. */}
        {!inPip && planning
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
            <View style={[styles.navDot, inPip && styles.navDotPip]} />
          </Marker>
        ) : null}
        {!inPip && offlineRegionCorner && !offlineRegionBbox ? (
          <Marker lngLat={[offlineRegionCorner.lng, offlineRegionCorner.lat]} anchor="center">
            <View style={styles.regionCorner} />
          </Marker>
        ) : null}
        {/* Via stops still ahead on a multi-stop trip: dots on the line,
            quieter than the destination flag; each disappears once passed. */}
        {!inPip && nav.destination
          ? nav.viaPoints.slice(nav.state?.viasPassed ?? 0).map((via, i) => (
              <Marker key={`nav-via-${i}`} lngLat={[via.lng, via.lat]} anchor="center">
                <View style={styles.navVia} />
              </Marker>
            ))
          : null}
        {!inPip ? (
          nav.destination ? (
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
          ) : null
        ) : null}
        {/* A saved stand's own rose, so which way it faces is visible on the map
          that planned it. Deliberately dimmer and thinner than the live
          shortlist above: both are on screen while planning a new area with last
          season's stands visible, and a proposal being considered must not read
          as a decision already made. Geometry comes from the shared
          `savedStandFeatures` — the same builder the web map and the card use. */}
        {!inPip && savedStands.features.length > 0 ? (
          <GeoJSONSource id="atlas-saved-stands" data={savedStands}>
            <Layer
              type="line"
              id="atlas-saved-stands-lanes"
              filter={['==', ['get', 'kind'], 'lane']}
              paint={{ 'line-color': '#ffffff', 'line-width': 1.5, 'line-opacity': 0.4 }}
            />
            <Layer
              type="line"
              id="atlas-saved-stands-aim"
              filter={['==', ['get', 'kind'], 'aim']}
              paint={{
                'line-color': '#f59e0b',
                'line-width': 2,
                'line-opacity': 0.55,
                'line-dasharray': [2, 1.5],
              }}
            />
          </GeoJSONSource>
        ) : null}
        {/* Saved places as colour-badged teardrop pins (web-parity markers).
          The marker view itself never handles touches (they aren't delivered
          reliably) — taps fall through to the map, and App.onMapPress hit-tests
          the pins to open the destination card (Navigate / Edit). */}
        {!inPip
          ? visiblePlaces.map((place) => (
              <Marker key={place.id} lngLat={[place.lng, place.lat]} anchor="bottom">
                <View pointerEvents="none" testID={`place-pin-${place.id}`} style={pinScaleStyle}>
                  <PlacePin color={place.color} icon={place.icon} />
                </View>
              </Marker>
            ))
          : null}
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
  navDotPip: {
    width: 14,
    height: 14,
    borderRadius: 7,
    borderWidth: 2,
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
