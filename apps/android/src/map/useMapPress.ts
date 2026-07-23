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

import type { ActiveOverlay } from '../layers/useOverlays';
import type { RoutePlanner } from '../routing/useRoute';
import type { DestinationTarget } from '../ui/DestinationCard';
import { NAV_PREVIEW_LAYER_IDS, PLAN_LINE_LAYER_ID } from './MapScene';

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
}

const coordName = (p: LatLng) => `${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}`;

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
          void identifyOverlays(
            origin,
            overlays.map((o) => o.meta),
            { lat, lng },
            zoom,
          ).then((groups) => {
            if (tap === tapSeq.current) showIdentify({ lat, lng }, groups);
          });
        }
        // Ground size of one screen pixel at this zoom (512px tiles) makes the
        // tap tolerance a constant ~36 px at any zoom level.
        const metersPerPx = (78271.5 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom;
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
    ],
  );

  const onPickPoint = useCallback(
    (at: LatLng) => {
      pickDestination({ lat: at.lat, lng: at.lng, name: coordName(at), canSave: true });
    },
    [pickDestination],
  );

  return { onMapPress, onPickPoint };
}
