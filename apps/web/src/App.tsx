import {
  APP_NAME,
  decodeMapHash,
  type LatLng,
  type MapViewState,
  type SearchResult,
} from '@atlas/core';
import type maplibregl from 'maplibre-gl';
import { useCallback, useRef, useState } from 'react';
import { MapView } from './MapView.js';
import { SearchBox } from './SearchBox.js';

const DEFAULT_VIEW: MapViewState = { center: { lat: 59.91, lng: 10.75 }, zoom: 5 }; // Oslo

// Decoded once at startup; afterwards the map keeps the hash in sync.
const initialView = decodeMapHash(window.location.hash) ?? DEFAULT_VIEW;

export function App() {
  const [pin, setPin] = useState<LatLng | null>(initialView.pin ?? null);
  const mapRef = useRef<maplibregl.Map | null>(null);

  const getBias = useCallback((): LatLng | null => {
    const center = mapRef.current?.getCenter();
    return center ? { lat: center.lat, lng: center.lng } : null;
  }, []);

  const onSearchSelect = useCallback((result: SearchResult) => {
    setPin(result.position);
    const map = mapRef.current;
    if (map) {
      map.flyTo({ center: result.position, zoom: Math.max(map.getZoom(), 13) });
    }
  }, []);

  return (
    <div style={{ height: '100%', position: 'relative' }}>
      <MapView
        initialView={initialView}
        pin={pin}
        onPinChange={setPin}
        onMapReady={(map) => {
          mapRef.current = map;
        }}
      />
      <div className="topbar">
        <div className="app-title">{APP_NAME}</div>
        <SearchBox onSelect={onSearchSelect} getBias={getBias} />
      </div>
    </div>
  );
}
