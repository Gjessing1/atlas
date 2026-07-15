import {
  APP_NAME,
  decodeMapHash,
  type LatLng,
  type MapViewState,
  type SearchResult,
} from '@atlas/core';
import { trackBounds, type TrackData } from '@atlas/gpx';
import type { PlaceRecord, TrackRecord } from '@atlas/storage';
import maplibregl from 'maplibre-gl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ElevationProfile } from './ElevationProfile.js';
import { MapView } from './MapView.js';
import { useTrackLayers } from './map/useTrackLayers.js';
import { SearchBox } from './SearchBox.js';
import { Sidebar } from './Sidebar.js';
import { type ImportResult, useUserData } from './storage/useUserData.js';

const DEFAULT_VIEW: MapViewState = { center: { lat: 59.91, lng: 10.75 }, zoom: 5 }; // Oslo
const LAST_VIEW_SETTING = 'lastView';

// Decoded once at startup; afterwards the map keeps the hash in sync. A share
// link (hash) always wins over the persisted last view.
const hashView = decodeMapHash(window.location.hash);
const initialView = hashView ?? DEFAULT_VIEW;

export function App() {
  const [pin, setPin] = useState<LatLng | null>(initialView.pin ?? null);
  const [map, setMap] = useState<maplibregl.Map | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [selectedTrack, setSelectedTrack] = useState<{
    track: TrackRecord;
    data: TrackData;
  } | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const userData = useUserData();

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

  // ---- user data on the map ----

  const { tracks, getTrackData, setSetting, getSetting, savePlace } = userData;

  const selectTrack = useCallback(
    (id: string | null) => {
      if (id === null) {
        setSelectedTrack(null);
        return;
      }
      const track = tracks.find((t) => t.id === id);
      if (!track) return;
      void getTrackData(id).then((data) => {
        if (data) setSelectedTrack({ track, data });
      });
    },
    [tracks, getTrackData],
  );

  useTrackLayers(map, tracks, getTrackData, selectTrack);

  // Keep the selected track's metadata fresh; drop it when the track is deleted.
  useEffect(() => {
    setSelectedTrack((cur) => {
      if (!cur) return cur;
      const track = tracks.find((t) => t.id === cur.track.id);
      return track ? { ...cur, track } : null;
    });
  }, [tracks]);

  const showPlace = useCallback((place: PlaceRecord) => {
    const map = mapRef.current;
    map?.flyTo({ center: { lat: place.lat, lng: place.lng }, zoom: Math.max(map.getZoom(), 14) });
  }, []);

  const showTrack = useCallback(
    (track: TrackRecord) => {
      void getTrackData(track.id).then((data) => {
        if (!data) return;
        setSelectedTrack({ track, data });
        const bounds = trackBounds(data);
        if (bounds && mapRef.current) {
          mapRef.current.fitBounds(
            [
              [bounds.sw.lng, bounds.sw.lat],
              [bounds.ne.lng, bounds.ne.lat],
            ],
            { padding: 60, maxZoom: 15 },
          );
        }
      });
    },
    [getTrackData],
  );

  const onImported = useCallback(
    (result: ImportResult) => {
      const first = result.tracks[0];
      if (first) showTrack(first);
      else if (result.places[0]) showPlace(result.places[0]);
    },
    [showTrack, showPlace],
  );

  const onSavePin = useCallback(
    (pin: LatLng) => {
      void savePlace({
        name: `Pin ${pin.lat.toFixed(5)}, ${pin.lng.toFixed(5)}`,
        lat: pin.lat,
        lng: pin.lng,
      });
      setSidebarOpen(true);
    },
    [savePlace],
  );

  // Elevation-profile hover → a small dot marker on the map.
  const hoverMarkerRef = useRef<maplibregl.Marker | null>(null);
  const onProfileHover = useCallback((point: LatLng | null) => {
    const map = mapRef.current;
    if (!point || !map) {
      hoverMarkerRef.current?.remove();
      return;
    }
    if (!hoverMarkerRef.current) {
      const el = document.createElement('div');
      el.className = 'track-hover-dot';
      hoverMarkerRef.current = new maplibregl.Marker({ element: el });
    }
    hoverMarkerRef.current.setLngLat(point).addTo(map);
  }, []);

  // Auto-save the camera; restore it on startup when the URL has no view hash.
  useEffect(() => {
    if (!map || userData.status !== 'ready') return;
    if (!hashView) {
      void getSetting(LAST_VIEW_SETTING).then((raw) => {
        if (!raw) return;
        // Don't fight the user: only restore while the camera still sits at
        // the startup default. (The URL hash is no signal here — the map
        // echoes the camera into it on load.)
        const center = map.getCenter();
        const untouched =
          Math.abs(map.getZoom() - initialView.zoom) < 0.01 &&
          Math.abs(center.lat - initialView.center.lat) < 1e-6 &&
          Math.abs(center.lng - initialView.center.lng) < 1e-6;
        if (!untouched) return;
        try {
          const view = JSON.parse(raw) as MapViewState;
          map.jumpTo({ center: view.center, zoom: view.zoom });
        } catch {
          // Ignore a corrupt setting; the default view is fine.
        }
      });
    }
    const save = () => {
      const center = map.getCenter();
      setSetting(
        LAST_VIEW_SETTING,
        JSON.stringify({ center: { lat: center.lat, lng: center.lng }, zoom: map.getZoom() }),
      );
    };
    map.on('moveend', save);
    return () => {
      map.off('moveend', save);
    };
  }, [map, userData.status, getSetting, setSetting]);

  return (
    <div style={{ height: '100%', position: 'relative' }}>
      <MapView
        initialView={initialView}
        pin={pin}
        onPinChange={setPin}
        onSavePin={onSavePin}
        onMapReady={(m) => {
          mapRef.current = m;
          setMap(m);
        }}
      />
      <div className="topbar">
        <div className="app-title">{APP_NAME}</div>
        <SearchBox onSelect={onSearchSelect} getBias={getBias} />
        <button
          type="button"
          className="sidebar-toggle"
          aria-expanded={sidebarOpen}
          onClick={() => setSidebarOpen((open) => !open)}
        >
          ★ Saved
        </button>
      </div>
      {sidebarOpen && (
        <Sidebar
          data={userData}
          selectedTrackId={selectedTrack?.track.id ?? null}
          onShowPlace={showPlace}
          onShowTrack={showTrack}
          onImported={onImported}
          onClose={() => setSidebarOpen(false)}
        />
      )}
      {selectedTrack && (
        <ElevationProfile
          track={selectedTrack.track}
          data={selectedTrack.data}
          onClose={() => selectTrack(null)}
          onHoverPoint={onProfileHover}
        />
      )}
    </div>
  );
}
