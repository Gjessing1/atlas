import {
  buildGpx,
  buildKml,
  computeTrackStats,
  parseGpx,
  parseTrackFile,
  type TrackData,
} from '@atlas/gpx';
import type {
  AtlasStorage,
  CollectionRecord,
  NewPlace,
  PlacePatch,
  PlaceRecord,
  TrackPatch,
  TrackRecord,
} from '@atlas/storage';
import { zipSync } from 'fflate';
import { useCallback, useEffect, useRef, useState } from 'react';
import { openStorage } from './db.js';

export interface ImportResult {
  tracks: TrackRecord[];
  places: PlaceRecord[];
  errors: string[];
}

export interface UserData {
  /** 'error' means persistent storage is unavailable (no OPFS/WASM). */
  status: 'loading' | 'ready' | 'error';
  error: string | null;
  collections: CollectionRecord[];
  places: PlaceRecord[];
  tracks: TrackRecord[];

  savePlace: (input: NewPlace) => Promise<PlaceRecord | null>;
  updatePlace: (id: string, patch: PlacePatch) => Promise<void>;
  deletePlace: (id: string) => Promise<void>;

  importFiles: (files: File[]) => Promise<ImportResult>;
  updateTrack: (id: string, patch: TrackPatch) => Promise<void>;
  deleteTrack: (id: string) => Promise<void>;
  /** Parsed geometry for a track (cached in memory). */
  getTrackData: (id: string) => Promise<TrackData | null>;
  /** Download one track as .gpx (stored original) or .kml (converted). */
  downloadTrack: (id: string, format: 'gpx' | 'kml') => Promise<void>;

  createCollection: (name: string, parentId?: string | null) => Promise<void>;
  renameCollection: (id: string, name: string) => Promise<void>;
  deleteCollection: (id: string) => Promise<void>;

  exportAll: () => Promise<void>;
  getSetting: (key: string) => Promise<string | null>;
  /** Fire-and-forget setting write (auto-save). */
  setSetting: (key: string, value: string) => void;
}

const sanitizeFileName = (name: string): string =>
  name.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'unnamed';

function download(fileName: string, bytes: Uint8Array, type: string): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * All user data (collections/places/tracks) as React state, with mutations
 * that write through to persistent storage and refresh — every change is
 * saved immediately (auto-save everywhere), there is no explicit save step.
 */
export function useUserData(): UserData {
  const [status, setStatus] = useState<UserData['status']>('loading');
  const [error, setError] = useState<string | null>(null);
  const [collections, setCollections] = useState<CollectionRecord[]>([]);
  const [places, setPlaces] = useState<PlaceRecord[]>([]);
  const [tracks, setTracks] = useState<TrackRecord[]>([]);
  const storageRef = useRef<AtlasStorage | null>(null);
  const trackDataCache = useRef(new Map<string, TrackData>());

  useEffect(() => {
    let cancelled = false;
    openStorage().then(
      async (storage) => {
        if (cancelled) return;
        storageRef.current = storage;
        const [c, p, t] = await Promise.all([
          storage.listCollections(),
          storage.listPlaces(),
          storage.listTracks(),
        ]);
        if (cancelled) return;
        setCollections(c);
        setPlaces(p);
        setTracks(t);
        setStatus('ready');
      },
      (err: unknown) => {
        if (cancelled) return;
        console.error('Persistent storage unavailable', err);
        setError(String(err));
        setStatus('error');
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshPlaces = useCallback(async () => {
    if (storageRef.current) setPlaces(await storageRef.current.listPlaces());
  }, []);
  const refreshTracks = useCallback(async () => {
    if (storageRef.current) setTracks(await storageRef.current.listTracks());
  }, []);
  const refreshCollections = useCallback(async () => {
    if (storageRef.current) setCollections(await storageRef.current.listCollections());
  }, []);

  const savePlace = useCallback(
    async (input: NewPlace) => {
      const storage = storageRef.current;
      if (!storage) return null;
      const place = await storage.createPlace(input);
      await refreshPlaces();
      return place;
    },
    [refreshPlaces],
  );

  const updatePlace = useCallback(
    async (id: string, patch: PlacePatch) => {
      await storageRef.current?.updatePlace(id, patch);
      await refreshPlaces();
    },
    [refreshPlaces],
  );

  const deletePlace = useCallback(
    async (id: string) => {
      await storageRef.current?.deletePlace(id);
      await refreshPlaces();
    },
    [refreshPlaces],
  );

  const importFiles = useCallback(
    async (files: File[]): Promise<ImportResult> => {
      const storage = storageRef.current;
      const result: ImportResult = { tracks: [], places: [], errors: [] };
      if (!storage) return result;

      for (const file of files) {
        try {
          const bytes = new Uint8Array(await file.arrayBuffer());
          const data = parseTrackFile(file.name, bytes);
          if (data.segments.length > 0) {
            // Preserve original GPX byte-for-byte (extensions and all — rule 5:
            // never trap user data); KML/KMZ are converted to canonical GPX.
            const gpx = file.name.toLowerCase().endsWith('.gpx')
              ? new TextDecoder().decode(bytes)
              : buildGpx(data);
            const stats = computeTrackStats(data) as unknown as Record<string, number>;
            const track = await storage.createTrack({
              name: data.name ?? file.name,
              gpx,
              stats,
            });
            trackDataCache.current.set(track.id, data);
            result.tracks.push(track);
          } else if (data.waypoints.length > 0) {
            // A waypoints-only file is a list of favorites, not a track.
            for (const w of data.waypoints) {
              result.places.push(
                await storage.createPlace({
                  name: w.name ?? `${w.lat.toFixed(5)}, ${w.lng.toFixed(5)}`,
                  lat: w.lat,
                  lng: w.lng,
                }),
              );
            }
          } else {
            result.errors.push(`${file.name}: no tracks or waypoints found`);
          }
        } catch (err) {
          result.errors.push(`${file.name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      await Promise.all([refreshTracks(), refreshPlaces()]);
      return result;
    },
    [refreshTracks, refreshPlaces],
  );

  const updateTrack = useCallback(
    async (id: string, patch: TrackPatch) => {
      await storageRef.current?.updateTrack(id, patch);
      await refreshTracks();
    },
    [refreshTracks],
  );

  const deleteTrack = useCallback(
    async (id: string) => {
      await storageRef.current?.deleteTrack(id);
      trackDataCache.current.delete(id);
      await refreshTracks();
    },
    [refreshTracks],
  );

  const getTrackData = useCallback(async (id: string): Promise<TrackData | null> => {
    const cached = trackDataCache.current.get(id);
    if (cached) return cached;
    const gpx = await storageRef.current?.getTrackGpx(id);
    if (!gpx) return null;
    try {
      const data = parseGpx(gpx);
      trackDataCache.current.set(id, data);
      return data;
    } catch (err) {
      console.error('Failed to parse stored track', id, err);
      return null;
    }
  }, []);

  const downloadTrack = useCallback(async (id: string, format: 'gpx' | 'kml') => {
    const storage = storageRef.current;
    if (!storage) return;
    const track = (await storage.listTracks()).find((t) => t.id === id);
    const gpx = await storage.getTrackGpx(id);
    if (!track || !gpx) return;
    const body = format === 'gpx' ? gpx : buildKml(parseGpx(gpx));
    const mime = format === 'gpx' ? 'application/gpx+xml' : 'application/vnd.google-earth.kml+xml';
    download(`${sanitizeFileName(track.name)}.${format}`, new TextEncoder().encode(body), mime);
  }, []);

  const createCollection = useCallback(
    async (name: string, parentId: string | null = null) => {
      await storageRef.current?.createCollection(name, parentId);
      await refreshCollections();
    },
    [refreshCollections],
  );

  const renameCollection = useCallback(
    async (id: string, name: string) => {
      await storageRef.current?.renameCollection(id, name);
      await refreshCollections();
    },
    [refreshCollections],
  );

  const deleteCollection = useCallback(
    async (id: string) => {
      await storageRef.current?.deleteCollection(id);
      await Promise.all([refreshCollections(), refreshPlaces(), refreshTracks()]);
    },
    [refreshCollections, refreshPlaces, refreshTracks],
  );

  const exportAll = useCallback(async () => {
    const storage = storageRef.current;
    if (!storage) return;
    const dump = await storage.exportAll();
    const encoder = new TextEncoder();
    const files: Record<string, Uint8Array> = {
      'atlas-export.json': encoder.encode(JSON.stringify(dump, null, 2)),
    };
    if (dump.places.length > 0) {
      files['places.gpx'] = encoder.encode(
        buildGpx({
          name: 'Atlas places',
          segments: [],
          waypoints: dump.places.map((p) => ({ lat: p.lat, lng: p.lng, name: p.name })),
        }),
      );
    }
    const used = new Set<string>();
    for (const track of dump.tracks) {
      let base = sanitizeFileName(track.name);
      if (used.has(base)) base = `${base}-${track.id.slice(0, 8)}`;
      used.add(base);
      files[`tracks/${base}.gpx`] = encoder.encode(track.gpx);
    }
    const date = new Date().toISOString().slice(0, 10);
    download(`atlas-export-${date}.zip`, zipSync(files), 'application/zip');
  }, []);

  const getSetting = useCallback(
    (key: string) => storageRef.current?.getSetting(key) ?? Promise.resolve(null),
    [],
  );

  const setSetting = useCallback((key: string, value: string) => {
    void storageRef.current?.setSetting(key, value);
  }, []);

  return {
    status,
    error,
    collections,
    places,
    tracks,
    savePlace,
    updatePlace,
    deletePlace,
    importFiles,
    updateTrack,
    deleteTrack,
    getTrackData,
    downloadTrack,
    createCollection,
    renameCollection,
    deleteCollection,
    exportAll,
    getSetting,
    setSetting,
  };
}
