import type { NavController } from '@atlas/app-hooks';
import {
  haversineM,
  identifyOverlays,
  POI_LAYER_IDS,
  type LatLng,
  type OverlayIdentifyGroup,
} from '@atlas/core';
import { viaInsertIndex } from '@atlas/routing';
import type { MapRef } from '@maplibre/maplibre-react-native';
import type { PlaceRecord } from '@atlas/storage';
import { useCallback, useRef } from 'react';
import type { RefObject } from 'react';

import { STATSKOG_JAKTFELT_ID } from '../layers/useHuntingFields';
import type { ActiveOverlay } from '../layers/useOverlays';
import { SPEED_CAMERAS_ID } from '../layers/useSpeedCameras';
import type { RoutePlanner } from '../routing/useRoute';
import type { DestinationTarget } from '../ui/DestinationCard';
import {
  HUNT_FIELDS_FILL_LAYER_ID,
  NAV_PREVIEW_LAYER_IDS,
  PLAN_LINE_LAYER_ID,
  SPEED_CAMERA_LAYER_IDS,
} from './MapScene';

/** Finger-sized query box for layer hit-tests (a 1 px point is too strict). */
const TAP_PADDING_PX = 12;
/** How close a tap must land to a saved pin to count as hitting it. */
const PIN_TAP_PX = 36;

type Pixel = { x: number; y: number };
type PixelBounds = [[number, number], [number, number]];

export interface MapPressHandlers {
  /** Every tap on the map, in whichever mode the app is currently in. */
  onMapPress: (at: LatLng, pixel: Pixel) => void;
  /** Long-press outside route planning: pick any point as a destination. */
  onPickPoint: (at: LatLng) => void;
}

export interface MapPressOptions {
  mapRef: RefObject<MapRef | null>;
  nav: NavController;
  route: RoutePlanner;
  places: PlaceRecord[];
  /** Overlays currently drawn — the identify-capable ones answer map taps. */
  overlays: ActiveOverlay[];
  /** Atlas server the identify requests go to. */
  origin: string;
  menuOpen: boolean;
  closeMenu: () => void;
  pickDestination: (target: DestinationTarget) => void;
  /** Report what the overlays say is under the tap (web parity, §Android queue). */
  showIdentify: (at: LatLng, groups: OverlayIdentifyGroup[]) => void;
  /**
   * The numbered "best spots" markers, when the shortlist is open, and what to
   * do with a tap on one. Hit-tested by distance like the saved pins rather
   * than by a layer query, for the same reason: touches on small round targets
   * want a finger-sized tolerance, not a pixel-exact one.
   */
  spots?: readonly { readonly id: string; readonly position: LatLng }[];
  pickSpot?: (id: string) => void;
}

const coordName = (p: LatLng) => `${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}`;

type QueriedFeature = { properties?: Record<string, unknown> | null };

/**
 * A tapped Statskog jaktfelt polygon as an identify group for the card: the
 * field name is the heading, the species it is opened for and Statskog's
 * remarks are the rows (web parity with useHuntingFieldsLayer's popup). Local
 * hit-test, not a server round trip — the coverage is already on the client.
 */
function huntingFieldGroup(hits: QueriedFeature[] | undefined): OverlayIdentifyGroup | null {
  const props = hits?.[0]?.properties;
  if (!props) return null;
  const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const name = str(props['Feltnavn']);
  const properties: Record<string, string> = {};
  const species = str(props['Art']);
  const remarks = str(props['Merknad']);
  if (species) properties['Species'] = species;
  if (remarks) properties['Remarks'] = remarks;
  return { title: name ?? 'Hunting field', properties };
}

/**
 * A tapped ATK camera as an identify group (web parity with
 * useSpeedCameraLayer's popup): the heading says *which kind* of enforcement it
 * is, because a fixed camera and an average-speed section are driven
 * differently, and the row is Vegvesen's own name for it. Also a local
 * hit-test — the coverage is on the client already.
 */
function speedCameraGroup(hits: QueriedFeature[] | undefined): OverlayIdentifyGroup | null {
  const props = hits?.[0]?.properties;
  if (!props) return null;
  const point = props['kind'] === 'point';
  const name =
    typeof props['name'] === 'string' && props['name'].trim() ? props['name'].trim() : null;
  return {
    title: point ? 'Speed camera' : 'Average speed control',
    properties: name ? { Name: name } : {},
  };
}

const boxAround = ({ x, y }: Pixel): PixelBounds => [
  [x - TAP_PADDING_PX, y - TAP_PADDING_PX],
  [x + TAP_PADDING_PX, y + TAP_PADDING_PX],
];

/**
 * One handler for every map tap: dismiss the ☰ menu if it's open; in the
 * route-choice preview, switch to the tapped choice; while planning, a tap on
 * the routed line inserts a via into that leg and any other tap appends a stop;
 * otherwise hit-test the saved pins, then the basemap POIs.
 *
 * Pins are picked here at the map level, rather than by the Marker views that
 * draw them, because touches on Marker child views are not delivered reliably
 * on-device — the map press always is.
 */
export function useMapPress({
  mapRef,
  nav,
  route,
  places,
  overlays,
  origin,
  menuOpen,
  closeMenu,
  pickDestination,
  showIdentify,
  spots,
  pickSpot,
}: MapPressOptions): MapPressHandlers {
  // Identify is a network round trip, so a second tap can land before the first
  // answers. Only the newest tap's answer may reach the card — otherwise the
  // rows would describe a point the user has already moved away from.
  const tapSeq = useRef(0);
  const onMapPress = useCallback(
    ({ lat, lng }: LatLng, pixel: Pixel) => {
      const pixelBounds = boxAround(pixel);
      if (menuOpen) {
        closeMenu();
        return;
      }
      if (nav.phase === 'preview') {
        // A tap on one of the drawn route choices makes it the selection.
        void (async () => {
          const hits = await mapRef.current
            ?.queryRenderedFeatures(pixelBounds, { layers: NAV_PREVIEW_LAYER_IDS })
            .catch(() => undefined);
          const index = hits?.[0]?.properties?.['index'] as number | undefined;
          if (typeof index === 'number') nav.selectPreview(index);
        })();
        return;
      }
      if (route.active) {
        void (async () => {
          // Tap on the selected line: insert a via there (web parity — the
          // shared viaInsertIndex picks the leg the tapped point belongs to).
          const path = route.paths?.[route.selectedPath];
          if (path && !route.roundTrip && route.waypoints.length >= 2) {
            const hits = await mapRef.current
              ?.queryRenderedFeatures(pixelBounds, { layers: [PLAN_LINE_LAYER_ID] })
              .catch(() => undefined);
            if (hits && hits.length > 0) {
              const at = { lat, lng };
              route.insertWaypoint(
                viaInsertIndex(
                  path.points,
                  route.waypoints.map((w) => w.pos),
                  at,
                ),
                at,
              );
              return;
            }
          }
          route.addWaypoint({ lat, lng });
        })();
        return;
      }
      void (async () => {
        const zoom = await mapRef.current?.getZoom();
        if (zoom === undefined) return;
        // Asked in parallel with the local hit-tests below: the pin/POI card
        // opens immediately and the overlay rows drop into it when they land.
        // Not mid-trip, though — a tap there asks "stop here?", and lake-depth
        // rows would only delay that card while burning a network round trip.
        const guiding = nav.phase === 'navigating' || nav.phase === 'rerouting';
        const tap = ++tapSeq.current;
        if (!guiding) {
          // The vector overlays answer locally (their features are drawn on the
          // client), everything else via the backend identify. Asked together so
          // a single tap that lands on several shows them all, in one card.
          const vectorOn = (id: string) => overlays.some((o) => o.meta.id === id && o.meta.vector);
          const query = (active: boolean, layers: string[]) =>
            active
              ? mapRef.current
                  ?.queryRenderedFeatures(pixelBounds, { layers })
                  .catch(() => undefined)
              : undefined;
          void (async () => {
            const [serverGroups, huntHits, cameraHits] = await Promise.all([
              identifyOverlays(
                origin,
                overlays.map((o) => o.meta),
                { lat, lng },
                zoom,
                // Same variant the tiles are drawn with, so a species-filtered
                // layer never answers with what it is not drawing.
                (meta) => overlays.find((o) => o.meta.id === meta.id)?.options,
              ),
              query(vectorOn(STATSKOG_JAKTFELT_ID), [HUNT_FIELDS_FILL_LAYER_ID]),
              query(vectorOn(SPEED_CAMERAS_ID), SPEED_CAMERA_LAYER_IDS),
            ]);
            // Local groups lead: they are what the user aimed at, and the
            // server rows are ambient context for the same point.
            const groups = [
              speedCameraGroup(cameraHits),
              huntingFieldGroup(huntHits),
              ...serverGroups,
            ].filter((group): group is OverlayIdentifyGroup => group !== null);
            if (tap === tapSeq.current) showIdentify({ lat, lng }, groups);
          })();
        }
        // Ground size of one screen pixel at this zoom (512px tiles) makes the
        // tap tolerance a constant ~36 px at any zoom level.
        const metersPerPx = (78271.5 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom;
        // A numbered spot wins over anything under it: the user is looking at
        // the shortlist and aimed at one of its markers.
        if (spots?.length && pickSpot) {
          let bestSpot: { id: string; position: LatLng } | undefined;
          let bestSpotM = Infinity;
          for (const spot of spots) {
            const d = haversineM({ lat, lng }, spot.position);
            if (d < bestSpotM) {
              bestSpotM = d;
              bestSpot = spot;
            }
          }
          if (bestSpot && bestSpotM <= PIN_TAP_PX * metersPerPx) {
            pickSpot(bestSpot.id);
            return;
          }
        }
        let best: PlaceRecord | undefined;
        let bestM = Infinity;
        for (const place of places) {
          const d = haversineM({ lat, lng }, { lat: place.lat, lng: place.lng });
          if (d < bestM) {
            bestM = d;
            best = place;
          }
        }
        if (best && bestM <= PIN_TAP_PX * metersPerPx) {
          pickDestination({
            lat: best.lat,
            lng: best.lng,
            name: best.name,
            address: best.address || undefined,
            canSave: false,
            placeId: best.id,
          });
          return;
        }
        // No pin hit — try the basemap POIs (name/class popup, web parity).
        const pois = await mapRef.current
          ?.queryRenderedFeatures(pixelBounds, { layers: POI_LAYER_IDS })
          .catch(() => undefined);
        const poi = pois?.[0];
        if (!poi) return;
        const props = (poi.properties ?? {}) as Record<string, unknown>;
        const name = (props['name'] ?? props['name:latin']) as string | undefined;
        if (!name) return;
        const kind = [props['class'], props['subclass']]
          .filter((v): v is string => typeof v === 'string' && v !== name)
          .join(' · ');
        // Anchor on the POI's own coordinate when it has one, not the tap.
        const [poiLng, poiLat] =
          poi.geometry?.type === 'Point' ? (poi.geometry.coordinates as number[]) : [lng, lat];
        pickDestination({
          lat: poiLat ?? lat,
          lng: poiLng ?? lng,
          name,
          detail: kind || undefined,
          canSave: true,
        });
      })();
    },
    [
      mapRef,
      menuOpen,
      closeMenu,
      nav,
      route,
      places,
      overlays,
      origin,
      pickDestination,
      showIdentify,
      spots,
      pickSpot,
    ],
  );

  const onPickPoint = useCallback(
    (at: LatLng) => {
      // `unnamed`: the heading is the coordinate, not something the user chose —
      // saving this opens the editor so the pin gets a name.
      pickDestination({
        lat: at.lat,
        lng: at.lng,
        name: coordName(at),
        canSave: true,
        unnamed: true,
      });
    },
    [pickDestination],
  );

  return { onMapPress, onPickPoint };
}
