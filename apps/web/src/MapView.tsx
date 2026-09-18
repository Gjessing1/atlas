import {
  applyMapAppearance,
  markerScaleForZoom,
  outdoorTilesUrl,
  terrainTilesUrl,
  POI_LAYER_IDS,
  poiCategoryLabel,
  resolveStyleTemplate,
  type LatLng,
  type ColorScheme,
  type MapViewState,
  type MapStyleOverrides,
  type PlaceTarget,
} from '@atlas/core';
import type { PlaceRecord } from '@atlas/storage';
import maplibregl, { type MapMouseEvent, type StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { Protocol } from 'pmtiles';
import { useEffect, useRef, useState } from 'react';

// The current style template sources tiles from the backend's merged
// /api/tiles endpoint (local basemap + streamed world coverage); the pmtiles
// protocol is kept so older deployed templates (pmtiles://…) still render.
maplibregl.addProtocol('pmtiles', new Protocol().tile);

// Self-hosted style template written by infrastructure/tiles/fetch-map-assets.sh.
const STYLE_TEMPLATE_URL = '/assets/styles/liberty.json';
// Fallback so a fresh checkout without provisioned tiles still shows a map.
const FALLBACK_STYLE_URL = 'https://demotiles.maplibre.org/style.json';

const LONG_PRESS_MS = 600;

let templatePromise: Promise<string> | null = null;

async function loadStyle(
  colorScheme: ColorScheme,
  profile: string,
  custom: MapStyleOverrides,
  basemap: boolean,
  poi: boolean,
  terrain: boolean,
): Promise<string | StyleSpecification> {
  try {
    templatePromise ??= fetch(STYLE_TEMPLATE_URL).then(async (res) => {
      if (!res.ok) throw new Error(`style template: HTTP ${res.status}`);
      return res.text();
    });
    const template = await templatePromise;
    const origin = window.location.origin;
    const resolved = resolveStyleTemplate(template, origin);
    return JSON.parse(
      applyMapAppearance(resolved, {
        colorScheme,
        profile,
        custom,
        basemap,
        poi,
        // Unconditional: only the outdoor profiles bind it, and a server with
        // no archive answers empty rather than wrong (see outdoorTilesUrl).
        outdoorTiles: outdoorTilesUrl(origin),
        terrain,
        terrainTiles: terrainTilesUrl(origin),
      }),
    ) as StyleSpecification;
  } catch (err) {
    templatePromise = null;
    console.warn('Self-hosted style unavailable, using fallback style.', err);
    return FALLBACK_STYLE_URL;
  }
}

/**
 * A colour-badged teardrop marker element (Android PlacePin twin): an emoji
 * badge when an icon is given, a plain white dot otherwise (the dropped pin).
 */
function teardropElement(color: string, icon?: string, selected = false): HTMLElement {
  const el = document.createElement('div');
  el.className = `place-marker${selected ? ' place-marker-selected' : ''}`;
  // Inner wrapper scaled by --marker-scale (set per zoom on the map container);
  // MapLibre owns the root element's transform, so scaling must live one level in.
  const scale = document.createElement('div');
  scale.className = 'place-marker-scale';
  el.appendChild(scale);
  // The badge is a rotated teardrop; the emoji sits in a child that rotates back.
  const badge = document.createElement('div');
  badge.className = 'place-marker-badge';
  badge.style.setProperty('--place-color', color);
  if (icon) {
    const glyph = document.createElement('span');
    glyph.textContent = icon;
    badge.appendChild(glyph);
  } else {
    const dot = document.createElement('div');
    dot.className = 'place-marker-dot';
    badge.appendChild(dot);
  }
  scale.appendChild(badge);
  return el;
}

interface MapViewProps {
  /** Initial camera; typically decoded from the URL hash. */
  initialView: MapViewState;
  pin: LatLng | null;
  /** Currently open place card, highlighted directly on the map. */
  selected: LatLng | null;
  /** Saved places, drawn as colour-badged emoji markers. */
  places: PlaceRecord[];
  onPinChange: (pin: LatLng | null) => void;
  /** The user pointed at a spot (pin, saved place or POI) — App opens the place card. */
  onSelect: (target: PlaceTarget) => void;
  /** The user's own position, reported by the geolocate control. */
  onUserLocation: (at: LatLng) => void;
  onMapReady: (map: maplibregl.Map) => void;
  /** While `.current` is true, POI click popups are suppressed (route mode owns clicks). */
  suppressPoiClicks?: { readonly current: boolean };
  /** UI-resolved light/dark palette; applies to the basemap too. */
  colorScheme: ColorScheme;
  /** Curated activity profile; changes map emphasis without changing data. */
  profile: string;
  /** User-edited colours and label/POI scale. */
  customStyle: MapStyleOverrides;
  /**
   * Draw the vector basemap under the overlays. Off leaves one flat background
   * and the overlays alone on it — how a historic sheet or any raster with holes
   * in it is read honestly (see `MapAppearance.basemap`).
   */
  basemap: boolean;
  /** Draw OSM points of interest from the basemap and outdoor supplement. */
  poi: boolean;
  /** Web-only DEM mesh; Android intentionally keeps its native 2D renderer. */
  terrain: boolean;
  /** Incremented by the shared control grid to trigger MapLibre geolocation. */
  locateRequest: number;
}

export function MapView({
  initialView,
  pin,
  selected,
  places,
  onPinChange,
  onSelect,
  onUserLocation,
  onMapReady,
  suppressPoiClicks,
  colorScheme,
  profile,
  customStyle,
  basemap,
  poi,
  terrain,
  locateRequest,
}: MapViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<maplibregl.Map | null>(null);
  // The map is built once, so its handlers read the newest callbacks via refs.
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const onUserLocationRef = useRef(onUserLocation);
  onUserLocationRef.current = onUserLocation;
  const geolocateRef = useRef<maplibregl.GeolocateControl | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      // Set async below; start with an empty style to avoid a fetch waterfall.
      style: { version: 8, sources: {}, layers: [] },
      center: initialView.center,
      zoom: initialView.zoom,
    });
    // Location puck + accuracy circle with a locate/recenter button; keeps
    // following until the user pans away (web-nav prerequisite, Android parity).
    // Its stock button is hidden: App's grid owns the visible placement.
    const geolocate = new maplibregl.GeolocateControl({
      positionOptions: { enableHighAccuracy: true },
      trackUserLocation: true,
    });
    geolocateRef.current = geolocate;
    // Reported to App so the place card can say how far away a spot is. Only a
    // fix the user asked for counts — Atlas never geolocates on its own.
    geolocate.on('geolocate', (e) => {
      const { latitude, longitude } = (e as GeolocationPosition).coords;
      onUserLocationRef.current({ lat: latitude, lng: longitude });
    });
    map.addControl(geolocate, 'bottom-right');
    // `metric` is MapLibre's default too, but pinned deliberately: Atlas never
    // shows feet or miles, and that must not ride on a library default.
    map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');

    // (The shareable URL hash is written by useShareHash, which also knows
    // about the route plan; the map only reports its camera.)

    // Keep pin markers zoom-proportional: full size in close, half size zoomed
    // out (see markerScaleForZoom). Markers are DOM elements, so the scale is a
    // CSS var on the container that .place-marker-scale picks up.
    const applyMarkerScale = () => {
      containerRef.current?.style.setProperty(
        '--marker-scale',
        String(markerScaleForZoom(map.getZoom())),
      );
    };
    map.on('zoom', applyMarkerScale);
    applyMarkerScale();

    // Pin placement: right-click on desktop, long-press on touch devices.
    map.on('contextmenu', (e: MapMouseEvent) => {
      onPinChange({ lat: e.lngLat.lat, lng: e.lngLat.lng });
    });
    let longPressTimer: ReturnType<typeof setTimeout> | undefined;
    map.on('touchstart', (e) => {
      if (e.originalEvent.touches.length !== 1) return;
      const { lngLat } = e;
      longPressTimer = setTimeout(() => {
        onPinChange({ lat: lngLat.lat, lng: lngLat.lng });
      }, LONG_PRESS_MS);
    });
    const cancelLongPress = () => clearTimeout(longPressTimer);
    map.on('touchend', cancelLongPress);
    map.on('touchcancel', cancelLongPress);
    map.on('touchmove', cancelLongPress);
    map.on('move', cancelLongPress);

    // POIs from the vector tiles open the same card as pins and saved places.
    for (const layer of POI_LAYER_IDS) {
      map.on('click', layer, (e) => {
        if (suppressPoiClicks?.current) return;
        const feature = e.features?.[0];
        if (!feature) return;
        const props = feature.properties as Record<string, unknown>;
        const name = (props['name'] ?? props['name:latin']) as string | undefined;
        if (!name) return;
        onSelectRef.current({
          source: 'poi',
          // The feature's own geometry, not the click point: the card's
          // coordinates and its Navigate destination should be the POI.
          position:
            feature.geometry.type === 'Point'
              ? { lat: feature.geometry.coordinates[1]!, lng: feature.geometry.coordinates[0]! }
              : { lat: e.lngLat.lat, lng: e.lngLat.lng },
          name,
          category: poiCategoryLabel(props, name),
        });
      });
      map.on('mouseenter', layer, () => (map.getCanvas().style.cursor = 'pointer'));
      map.on('mouseleave', layer, () => (map.getCanvas().style.cursor = ''));
    }

    setMap(map);
    onMapReady(map);
    // Exposed for end-to-end tests and console debugging.
    (window as unknown as { __atlasMap?: maplibregl.Map }).__atlasMap = map;
    return () => {
      geolocateRef.current = null;
      setMap(null);
      map.remove();
    };
    // The map is created exactly once; interaction callbacks read refs/props via closures.
  }, []);

  useEffect(() => {
    if (locateRequest > 0) geolocateRef.current?.trigger();
  }, [locateRequest]);

  // MapLibre's keyboard handler only hears keys while its canvas is focused.
  // Keep arrow-key panning available after the user has clicked ordinary map
  // chrome too, without stealing cursor/navigation keys from real controls.
  useEffect(() => {
    if (!map) return;
    const panByKey: Record<string, [number, number]> = {
      ArrowLeft: [-100, 0],
      ArrowRight: [100, 0],
      ArrowUp: [0, -100],
      ArrowDown: [0, 100],
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const offset = panByKey[event.key];
      if (!offset || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (event.target === map.getCanvas()) return; // MapLibre already handles this case.
      if (
        event.target instanceof HTMLElement &&
        event.target.closest('input, textarea, select, button, a, [contenteditable="true"]')
      ) {
        return;
      }
      event.preventDefault();
      map.panBy(offset, { duration: 300 });
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [map]);

  // Style swaps are deliberately independent of map construction: choosing a
  // theme or activity keeps the camera and controls in place. Atlas overlay,
  // route and navigation hooks already re-ensure their layers on style.load.
  useEffect(() => {
    if (!map) return;
    let cancelled = false;
    void loadStyle(colorScheme, profile, customStyle, basemap, poi, terrain).then((style) => {
      if (!cancelled) map.setStyle(style);
    });
    return () => {
      cancelled = true;
    };
  }, [map, colorScheme, profile, customStyle, basemap, poi, terrain]);

  // The mesh exists in a top-down camera too, but reads as an ordinary flat
  // map. Enter/leave with a deliberate camera move so the control has an
  // immediate visible result; subsequent pitch gestures remain entirely free.
  const previousTerrainRef = useRef(false);
  useEffect(() => {
    if (!map || previousTerrainRef.current === terrain) return;
    previousTerrainRef.current = terrain;
    map.easeTo({ pitch: terrain ? 55 : 0, duration: 700 });
  }, [map, terrain]);

  // Render the (single) dropped pin as a draggable marker. Clicking it reopens
  // the place card; the card itself is App-level React, not a MapLibre popup.
  const markerRef = useRef<maplibregl.Marker | null>(null);
  useEffect(() => {
    if (!map) return;
    markerRef.current?.remove();
    markerRef.current = null;
    if (pin) {
      // Same red teardrop as the Android destination pick (#d33939).
      const marker = new maplibregl.Marker({
        element: teardropElement(
          '#d33939',
          undefined,
          selected?.lat === pin.lat && selected.lng === pin.lng,
        ),
        anchor: 'bottom',
        draggable: true,
      })
        .setLngLat(pin)
        .addTo(map);
      marker.getElement().addEventListener('click', () => {
        onSelectRef.current({ source: 'pin', position: pin });
      });
      marker.on('dragend', () => {
        const at = marker.getLngLat();
        onPinChange({ lat: at.lat, lng: at.lng });
      });
      markerRef.current = marker;
    }
  }, [map, pin, selected, onPinChange]);

  // Draw saved places as colour-badged emoji markers (favourites are few, so
  // DOM markers render real emoji + colour that vector-tile glyphs can't).
  const placeMarkersRef = useRef<maplibregl.Marker[]>([]);
  useEffect(() => {
    if (!map) return;
    for (const m of placeMarkersRef.current) m.remove();
    placeMarkersRef.current = places.map((place) => {
      const marker = new maplibregl.Marker({
        element: teardropElement(
          place.color,
          place.icon,
          selected?.lat === place.lat && selected.lng === place.lng,
        ),
        anchor: 'bottom',
      })
        .setLngLat({ lat: place.lat, lng: place.lng })
        .addTo(map);
      marker.getElement().addEventListener('click', () => {
        onSelectRef.current({
          source: 'place',
          position: { lat: place.lat, lng: place.lng },
          name: place.name,
          address: place.address || undefined,
          category: place.notes.split('\n')[0] || undefined,
          placeId: place.id,
        });
      });
      return marker;
    });
    return () => {
      for (const m of placeMarkersRef.current) m.remove();
      placeMarkersRef.current = [];
    };
  }, [map, places, selected]);

  // Basemap POIs and search hits do not own a DOM marker of their own. Give
  // the open card a real selected pin so overlapping symbols never leave the
  // map asking which one was tapped.
  const selectedMarkerRef = useRef<maplibregl.Marker | null>(null);
  useEffect(() => {
    if (!map) return;
    selectedMarkerRef.current?.remove();
    selectedMarkerRef.current = null;
    if (!selected) return;
    const alreadyMarked =
      (pin?.lat === selected.lat && pin.lng === selected.lng) ||
      places.some((place) => place.lat === selected.lat && place.lng === selected.lng);
    if (alreadyMarked) return;
    selectedMarkerRef.current = new maplibregl.Marker({
      element: teardropElement('#d33939', undefined, true),
      anchor: 'bottom',
    })
      .setLngLat(selected)
      .addTo(map);
    return () => {
      selectedMarkerRef.current?.remove();
      selectedMarkerRef.current = null;
    };
  }, [map, selected, pin, places]);

  return <div ref={containerRef} style={{ height: '100%' }} />;
}
