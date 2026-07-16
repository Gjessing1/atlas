import { encodeMapHash, resolveStyleTemplate, type LatLng, type MapViewState } from '@atlas/core';
import type { PlaceRecord } from '@atlas/storage';
import maplibregl, { type MapMouseEvent, type StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { Protocol } from 'pmtiles';
import { useEffect, useRef, useState } from 'react';

// Self-hosted basemap: PMTiles archives are fetched piecewise over HTTP range
// requests; the pmtiles protocol handler turns tile requests into range reads.
maplibregl.addProtocol('pmtiles', new Protocol().tile);

// Self-hosted style template written by infrastructure/tiles/fetch-map-assets.sh.
const STYLE_TEMPLATE_URL = '/assets/styles/liberty.json';
// Fallback so a fresh checkout without provisioned tiles still shows a map.
const FALLBACK_STYLE_URL = 'https://demotiles.maplibre.org/style.json';

// Layers of the liberty style that render the OpenMapTiles `poi` source layer.
const POI_LAYERS = ['poi_r20', 'poi_r7', 'poi_r1', 'poi_transit'];

const LONG_PRESS_MS = 600;

async function loadStyle(): Promise<string | StyleSpecification> {
  try {
    const res = await fetch(STYLE_TEMPLATE_URL);
    if (!res.ok) throw new Error(`style template: HTTP ${res.status}`);
    const template = await res.text();
    return JSON.parse(resolveStyleTemplate(template, window.location.origin)) as StyleSpecification;
  } catch (err) {
    console.warn('Self-hosted style unavailable, using fallback style.', err);
    return FALLBACK_STYLE_URL;
  }
}

function pinPopupContent(pin: LatLng, onRemove: () => void, onSave: () => void): HTMLElement {
  const el = document.createElement('div');
  el.className = 'pin-popup';
  const coords = `${pin.lat.toFixed(5)}, ${pin.lng.toFixed(5)}`;
  const coordsEl = document.createElement('code');
  coordsEl.textContent = coords;
  el.appendChild(coordsEl);

  const buttons = document.createElement('div');
  buttons.className = 'pin-popup-buttons';
  const mkButton = (label: string, action: () => void) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.addEventListener('click', action);
    buttons.appendChild(b);
  };
  mkButton('Save', onSave);
  mkButton('Copy coords', () => void navigator.clipboard.writeText(coords));
  // The URL hash always reflects camera + pin, so the current URL is the share link.
  mkButton('Copy link', () => void navigator.clipboard.writeText(window.location.href));
  mkButton('Remove', onRemove);
  el.appendChild(buttons);
  return el;
}

/** A colour-badged emoji marker element for a saved place. */
function placeMarkerElement(place: PlaceRecord): HTMLElement {
  const el = document.createElement('div');
  el.className = 'place-marker';
  el.style.setProperty('--place-color', place.color);
  // The badge is a rotated teardrop; the emoji sits in a child that rotates back.
  const glyph = document.createElement('span');
  glyph.textContent = place.icon;
  el.appendChild(glyph);
  return el;
}

interface MapViewProps {
  /** Initial camera; typically decoded from the URL hash. */
  initialView: MapViewState;
  pin: LatLng | null;
  /** Saved places, drawn as colour-badged emoji markers. */
  places: PlaceRecord[];
  onPinChange: (pin: LatLng | null) => void;
  /** Save the dropped pin as a place (favorites). */
  onSavePin: (pin: LatLng) => void;
  onMapReady: (map: maplibregl.Map) => void;
  /** While `.current` is true, POI click popups are suppressed (route mode owns clicks). */
  suppressPoiClicks?: { readonly current: boolean };
}

export function MapView({
  initialView,
  pin,
  places,
  onPinChange,
  onSavePin,
  onMapReady,
  suppressPoiClicks,
}: MapViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<maplibregl.Map | null>(null);
  const pinRef = useRef(pin);
  pinRef.current = pin;

  useEffect(() => {
    if (!containerRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      // Set async below; start with an empty style to avoid a fetch waterfall.
      style: { version: 8, sources: {}, layers: [] },
      center: initialView.center,
      zoom: initialView.zoom,
    });
    void loadStyle().then((style) => map.setStyle(style));
    map.addControl(new maplibregl.NavigationControl(), 'top-right');
    map.addControl(new maplibregl.ScaleControl(), 'bottom-left');

    // Keep the URL hash shareable: it always encodes camera + pin.
    const syncHash = () => {
      const center = map.getCenter();
      const state: MapViewState = {
        center: { lat: center.lat, lng: center.lng },
        zoom: map.getZoom(),
        pin: pinRef.current ?? undefined,
      };
      history.replaceState(null, '', encodeMapHash(state));
    };
    map.on('moveend', syncHash);

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

    // POI popups from the vector tiles.
    for (const layer of POI_LAYERS) {
      map.on('click', layer, (e) => {
        if (suppressPoiClicks?.current) return;
        const feature = e.features?.[0];
        if (!feature) return;
        const props = feature.properties as Record<string, unknown>;
        const name = (props['name'] ?? props['name:latin']) as string | undefined;
        if (!name) return;
        const kind = [props['class'], props['subclass']]
          .filter((v) => typeof v === 'string' && v !== name)
          .join(' · ');
        const el = document.createElement('div');
        el.className = 'poi-popup';
        el.innerHTML = `<strong></strong><span></span>`;
        el.querySelector('strong')!.textContent = name;
        el.querySelector('span')!.textContent = kind;
        new maplibregl.Popup({ closeButton: false, offset: 8 })
          .setLngLat(e.lngLat)
          .setDOMContent(el)
          .addTo(map);
      });
      map.on('mouseenter', layer, () => (map.getCanvas().style.cursor = 'pointer'));
      map.on('mouseleave', layer, () => (map.getCanvas().style.cursor = ''));
    }

    setMap(map);
    onMapReady(map);
    // Exposed for end-to-end tests and console debugging.
    (window as unknown as { __atlasMap?: maplibregl.Map }).__atlasMap = map;
    return () => {
      setMap(null);
      map.remove();
    };
    // The map is created exactly once; interaction callbacks read refs/props via closures.
  }, []);

  // Render the (single) dropped pin as a draggable marker with a coords popup.
  const markerRef = useRef<maplibregl.Marker | null>(null);
  useEffect(() => {
    if (!map) return;
    markerRef.current?.remove();
    markerRef.current = null;
    if (pin) {
      const popup = new maplibregl.Popup({ closeButton: false, offset: 32 }).setDOMContent(
        pinPopupContent(
          pin,
          () => onPinChange(null),
          () => onSavePin(pin),
        ),
      );
      const marker = new maplibregl.Marker({ draggable: true, color: '#d33' })
        .setLngLat(pin)
        .setPopup(popup)
        .addTo(map);
      marker.on('dragend', () => {
        const at = marker.getLngLat();
        onPinChange({ lat: at.lat, lng: at.lng });
      });
      markerRef.current = marker;
    }
    // Reflect the pin in the shareable URL immediately (not only on camera moves).
    const center = map.getCenter();
    history.replaceState(
      null,
      '',
      encodeMapHash({
        center: { lat: center.lat, lng: center.lng },
        zoom: map.getZoom(),
        pin: pin ?? undefined,
      }),
    );
  }, [map, pin, onPinChange, onSavePin]);

  // Draw saved places as colour-badged emoji markers (favourites are few, so
  // DOM markers render real emoji + colour that vector-tile glyphs can't).
  const placeMarkersRef = useRef<maplibregl.Marker[]>([]);
  useEffect(() => {
    if (!map) return;
    for (const m of placeMarkersRef.current) m.remove();
    placeMarkersRef.current = places.map((place) => {
      const popup = new maplibregl.Popup({ closeButton: false, offset: 18 }).setText(place.name);
      return new maplibregl.Marker({ element: placeMarkerElement(place), anchor: 'bottom' })
        .setLngLat({ lat: place.lat, lng: place.lng })
        .setPopup(popup)
        .addTo(map);
    });
    return () => {
      for (const m of placeMarkersRef.current) m.remove();
      placeMarkersRef.current = [];
    };
  }, [map, places]);

  return <div ref={containerRef} style={{ height: '100%' }} />;
}
