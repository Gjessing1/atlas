import { buildGpx, buildKml, computeTrackStats, parseGpx, parseTrackFile } from '@atlas/gpx';
import type {
  AtlasStorage,
  CollectionRecord,
  NewPlace,
  NewTrack,
  PlacePatch,
  PlaceRecord,
  TrackPatch,
  TrackRecord,
} from '@atlas/storage';
import * as FileSystem from 'expo-file-system/legacy';
import { useCallback, useEffect, useRef, useState } from 'react';

import { openStorage } from './db';
import { sanitizeFileName, shareText } from './share';

/** A file handed to the importer (from expo-document-picker); name drives the parser. */
export interface PickedFile {
  name: string;
  uri: string;
}

export interface ImportResult {
  tracks: number;
  places: number;
  errors: string[];
}

export interface UserData {
  status: 'loading' | 'ready' | 'error';
  error: string | null;
  places: PlaceRecord[];
  /** Folders — resolve a place's effective map visibility and group places/tracks. */
  collections: CollectionRecord[];
  tracks: TrackRecord[];
  /** The open storage (null until ready) — for wiring the sync engine only. */
  storage: AtlasStorage | null;
  /** Reload from storage, e.g. after sync applied remote changes. */
  refreshAll: () => Promise<void>;

  savePlace: (input: NewPlace) => Promise<void>;
  updatePlace: (id: string, patch: PlacePatch) => Promise<void>;
  deletePlace: (id: string) => Promise<void>;

  /** Persist a recorded track (track recording) — refreshes the tracks list. */
  saveTrack: (input: NewTrack) => Promise<void>;
  /** Import GPX/KML/KMZ files picked from the device; returns a per-file summary. */
  importFiles: (files: PickedFile[]) => Promise<ImportResult>;
  updateTrack: (id: string, patch: TrackPatch) => Promise<void>;
  deleteTrack: (id: string) => Promise<void>;
  /** Share one track as .gpx (stored original) or .kml (converted) via the OS share sheet. */
  exportTrack: (id: string, format: 'gpx' | 'kml') => Promise<void>;

  createCollection: (name: string, parentId?: string | null) => Promise<void>;
  renameCollection: (id: string, name: string) => Promise<void>;
  setCollectionVisible: (id: string, visible: boolean) => Promise<void>;
  deleteCollection: (id: string) => Promise<void>;
  /** Show or hide every place and folder at once (the "show/hide all" action). */
  setAllVisible: (visible: boolean) => Promise<void>;

  /** Share the full user-data dump as a JSON file (rule 5: everything exportable). */
  exportAll: () => Promise<void>;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Decode a base64 string to bytes without relying on a global `atob` (Hermes
 * doesn't ship one everywhere) — needed to hand KMZ (zip) bytes to the parser.
 */
function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/[^A-Za-z0-9+/]/g, '');
  const len = Math.floor((clean.length * 3) / 4);
  const out = new Uint8Array(len);
  let p = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const a = B64.indexOf(clean[i]!);
    const b = B64.indexOf(clean[i + 1]!);
    const c = B64.indexOf(clean[i + 2]!);
    const d = B64.indexOf(clean[i + 3]!);
    const chunk = (a << 18) | (b << 12) | ((c < 0 ? 0 : c) << 6) | (d < 0 ? 0 : d);
    if (p < len) out[p++] = (chunk >> 16) & 0xff;
    if (c >= 0 && p < len) out[p++] = (chunk >> 8) & 0xff;
    if (d >= 0 && p < len) out[p++] = chunk & 0xff;
  }
  return out;
}

/**
 * Android counterpart of the web app's useUserData: the same @atlas/storage
 * layer over the device's native SQLite (see src/db.ts). Local data is
 * authoritative — the server only syncs (ARCHITECTURE.md rule 3). Mirrors the
 * web surface (places / folders / tracks + import/export) for mobile parity.
 */
export function useUserData(): UserData {
  const [status, setStatus] = useState<UserData['status']>('loading');
  const [error, setError] = useState<string | null>(null);
  const [places, setPlaces] = useState<PlaceRecord[]>([]);
  const [collections, setCollections] = useState<CollectionRecord[]>([]);
  const [tracks, setTracks] = useState<TrackRecord[]>([]);
  const storageRef = useRef<AtlasStorage | null>(null);
  const [storage, setStorage] = useState<AtlasStorage | null>(null);

  const refreshAll = useCallback(async () => {
    const s = storageRef.current;
    if (!s) return;
    const [p, c, t] = await Promise.all([s.listPlaces(), s.listCollections(), s.listTracks()]);
    setPlaces(p);
    setCollections(c);
    setTracks(t);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void openStorage()
      .then(async (s) => {
        if (cancelled) return;
        storageRef.current = s;
        setStorage(s);
        const [p, c, t] = await Promise.all([s.listPlaces(), s.listCollections(), s.listTracks()]);
        setPlaces(p);
        setCollections(c);
        setTracks(t);
        setStatus('ready');
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setStatus('error');
        }
      });
    return () => {
      cancelled = true;
      storageRef.current = null;
    };
  }, []);

  const savePlace = useCallback(
    async (input: NewPlace) => {
      await storageRef.current?.createPlace(input);
      await refreshAll();
    },
    [refreshAll],
  );

  const updatePlace = useCallback(
    async (id: string, patch: PlacePatch) => {
      await storageRef.current?.updatePlace(id, patch);
      await refreshAll();
    },
    [refreshAll],
  );

  const deletePlace = useCallback(
    async (id: string) => {
      await storageRef.current?.deletePlace(id);
      await refreshAll();
    },
    [refreshAll],
  );

  const saveTrack = useCallback(
    async (input: NewTrack) => {
      await storageRef.current?.createTrack(input);
      await refreshAll();
    },
    [refreshAll],
  );

  const importFiles = useCallback(
    async (files: PickedFile[]): Promise<ImportResult> => {
      const storage = storageRef.current;
      const result: ImportResult = { tracks: 0, places: 0, errors: [] };
      if (!storage) return result;

      for (const file of files) {
        try {
          const isText = /\.(gpx|kml)$/i.test(file.name);
          const bytes = isText
            ? new TextEncoder().encode(await FileSystem.readAsStringAsync(file.uri))
            : base64ToBytes(await FileSystem.readAsStringAsync(file.uri, { encoding: 'base64' }));
          const data = parseTrackFile(file.name, bytes);
          if (data.segments.length > 0) {
            // Preserve original GPX byte-for-byte (rule 5: never trap user data);
            // KML/KMZ are converted to canonical GPX.
            const gpx = file.name.toLowerCase().endsWith('.gpx')
              ? new TextDecoder().decode(bytes)
              : buildGpx(data);
            const stats = computeTrackStats(data) as unknown as Record<string, number>;
            await storage.createTrack({ name: data.name ?? file.name, gpx, stats });
            result.tracks += 1;
          } else if (data.waypoints.length > 0) {
            // A waypoints-only file is a list of favorites, not a track.
            for (const w of data.waypoints) {
              await storage.createPlace({
                name: w.name ?? `${w.lat.toFixed(5)}, ${w.lng.toFixed(5)}`,
                lat: w.lat,
                lng: w.lng,
              });
              result.places += 1;
            }
          } else {
            result.errors.push(`${file.name}: no tracks or waypoints found`);
          }
        } catch (err) {
          result.errors.push(`${file.name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      await refreshAll();
      return result;
    },
    [refreshAll],
  );

  const updateTrack = useCallback(
    async (id: string, patch: TrackPatch) => {
      await storageRef.current?.updateTrack(id, patch);
      await refreshAll();
    },
    [refreshAll],
  );

  const deleteTrack = useCallback(
    async (id: string) => {
      await storageRef.current?.deleteTrack(id);
      await refreshAll();
    },
    [refreshAll],
  );

  const exportTrack = useCallback(async (id: string, format: 'gpx' | 'kml') => {
    const storage = storageRef.current;
    if (!storage) return;
    const track = (await storage.listTracks()).find((t) => t.id === id);
    const gpx = await storage.getTrackGpx(id);
    if (!track || !gpx) return;
    const body = format === 'gpx' ? gpx : buildKml(parseGpx(gpx));
    await shareText(`${sanitizeFileName(track.name)}.${format}`, body);
  }, []);

  const createCollection = useCallback(
    async (name: string, parentId: string | null = null) => {
      await storageRef.current?.createCollection(name, parentId);
      await refreshAll();
    },
    [refreshAll],
  );

  const renameCollection = useCallback(
    async (id: string, name: string) => {
      await storageRef.current?.renameCollection(id, name);
      await refreshAll();
    },
    [refreshAll],
  );

  const setCollectionVisible = useCallback(
    async (id: string, visible: boolean) => {
      await storageRef.current?.setCollectionVisible(id, visible);
      await refreshAll();
    },
    [refreshAll],
  );

  const deleteCollection = useCallback(
    async (id: string) => {
      await storageRef.current?.deleteCollection(id);
      await refreshAll();
    },
    [refreshAll],
  );

  const setAllVisible = useCallback(
    async (visible: boolean) => {
      const storage = storageRef.current;
      if (!storage) return;
      const [ps, cs] = await Promise.all([storage.listPlaces(), storage.listCollections()]);
      // Only flip rows that differ, so we don't churn updated_at (and the sync
      // outbox) for records already in the wanted state.
      await Promise.all([
        ...ps
          .filter((p) => p.visible !== visible)
          .map((p) => storage.updatePlace(p.id, { visible })),
        ...cs
          .filter((c) => c.visible !== visible)
          .map((c) => storage.setCollectionVisible(c.id, visible)),
      ]);
      await refreshAll();
    },
    [refreshAll],
  );

  const exportAll = useCallback(async () => {
    const storage = storageRef.current;
    if (!storage) return;
    const dump = await storage.exportAll();
    const date = new Date().toISOString().slice(0, 10);
    await shareText(`atlas-export-${date}.json`, JSON.stringify(dump, null, 2));
  }, []);

  return {
    status,
    error,
    places,
    collections,
    tracks,
    storage,
    refreshAll,
    savePlace,
    updatePlace,
    deletePlace,
    saveTrack,
    importFiles,
    updateTrack,
    deleteTrack,
    exportTrack,
    createCollection,
    renameCollection,
    setCollectionVisible,
    deleteCollection,
    setAllVisible,
    exportAll,
  };
}
