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
  DeletedRecord,
  ImportSummary,
  NewPlace,
  PlacePatch,
  PlaceRecord,
  TrackPatch,
  TrackRecord,
} from '@atlas/storage';
import { parseExportedData } from '@atlas/storage';
import { unzipSync, zipSync } from 'fflate';
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Platform seams for useUserData. Must be referentially stable across renders
 * (module const or useMemo) — `openStorage` identity gates the open effect.
 *
 * `TFile` is whatever the platform's picker hands the importer (a DOM `File`
 * on web, a `{ name, uri }` from expo-document-picker on Android).
 */
export interface UserDataPlatform<TFile> {
  openStorage: () => Promise<AtlasStorage>;
  /** Read a picked/dropped file into its name + raw bytes. */
  readFile: (file: TFile) => Promise<{ name: string; bytes: Uint8Array }>;
  /** Deliver a single exported file (browser download / OS share sheet). */
  saveTextFile: (name: string, body: string, mime: string) => Promise<void>;
  /**
   * Deliver the full-export zip, when the platform can save binary files.
   * When absent, exportAll falls back to sharing the JSON dump alone.
   */
  saveZipFile?: (name: string, bytes: Uint8Array) => Promise<void>;
}

/** The file name `exportAll` writes the dump under, inside the export zip. */
const EXPORT_JSON_NAME = 'atlas-export.json';

export interface ImportResult {
  tracks: TrackRecord[];
  places: PlaceRecord[];
  errors: string[];
  /**
   * Totals from any full-backup file in the batch (null when none was picked).
   * A restore merges by id rather than creating records, so its results do not
   * appear in `tracks`/`places` — the UI reports it separately.
   */
  restored: ImportSummary | null;
}

const addSummary = (a: ImportSummary | null, b: ImportSummary): ImportSummary => {
  if (!a) return b;
  const add = (x: { imported: number; skipped: number }, y: typeof x): typeof x => ({
    imported: x.imported + y.imported,
    skipped: x.skipped + y.skipped,
  });
  return {
    collections: add(a.collections, b.collections),
    places: add(a.places, b.places),
    tracks: add(a.tracks, b.tracks),
    settings: add(a.settings, b.settings),
  };
};

/** Total records a restore actually wrote — what the UI reports as "restored". */
export const importedCount = (s: ImportSummary): number =>
  s.collections.imported + s.places.imported + s.tracks.imported + s.settings.imported;

/**
 * The export dump inside a picked file, or null when it is not a backup.
 * Accepts both shapes `exportAll` produces: the bare JSON dump, and the zip
 * (which also holds GPX copies — those are for other apps to read, the JSON is
 * the authoritative one, so the GPX entries are deliberately ignored here).
 */
function readBackupFile(name: string, bytes: Uint8Array): ReturnType<typeof parseExportedData> {
  const lower = name.toLowerCase();
  let json: string;
  if (lower.endsWith('.zip')) {
    const entry = unzipSync(bytes, { filter: (f) => f.name === EXPORT_JSON_NAME })[
      EXPORT_JSON_NAME
    ];
    if (!entry) return null;
    json = new TextDecoder().decode(entry);
  } else if (lower.endsWith('.json')) {
    json = new TextDecoder().decode(bytes);
  } else {
    return null;
  }
  try {
    return parseExportedData(JSON.parse(json));
  } catch {
    return null;
  }
}

/**
 * The last deletion, offered back to the user as an undo. Deletes are immediate
 * (no confirmation dialog) — this is what makes that safe, so the UI must
 * surface it whenever it is non-null.
 */
export interface UndoableDelete {
  /** Ready-to-show message, e.g. `Deleted "Preikestolen"`. */
  message: string;
  undo: () => Promise<void>;
}

export interface UserData<TFile> {
  /** 'error' means persistent storage is unavailable. */
  status: 'loading' | 'ready' | 'error';
  error: string | null;
  /** Latest failed storage write, for a dismissible toast — null when none. */
  writeError: string | null;
  clearWriteError: () => void;
  /** Latest deletion, for an undo toast — null when none is pending. */
  undoable: UndoableDelete | null;
  /** Drop the pending undo (toast dismissed or timed out). */
  clearUndoable: () => void;
  collections: CollectionRecord[];
  places: PlaceRecord[];
  tracks: TrackRecord[];

  /** The open storage (null until ready) — for wiring the sync engine only. */
  storage: AtlasStorage | null;
  /** Reload all lists from storage, e.g. after sync applied remote changes. */
  refreshAll: () => Promise<void>;

  savePlace: (input: NewPlace) => Promise<PlaceRecord | null>;
  updatePlace: (id: string, patch: PlacePatch) => Promise<void>;
  deletePlace: (id: string) => Promise<void>;
  /** Persist a drag-and-drop arrangement of places (ids in their new order). */
  reorderPlaces: (orderedIds: string[]) => Promise<void>;
  /** Persist a drag-and-drop arrangement of folders (ids in their new order). */
  reorderCollections: (orderedIds: string[]) => Promise<void>;

  importFiles: (files: TFile[]) => Promise<ImportResult>;
  updateTrack: (id: string, patch: TrackPatch) => Promise<void>;
  deleteTrack: (id: string) => Promise<void>;
  /** Parsed geometry for a track (cached in memory). */
  getTrackData: (id: string) => Promise<TrackData | null>;
  /** Export one track as .gpx (stored original) or .kml (converted). */
  exportTrack: (id: string, format: 'gpx' | 'kml') => Promise<void>;

  createCollection: (name: string, parentId?: string | null) => Promise<void>;
  renameCollection: (id: string, name: string) => Promise<void>;
  moveCollection: (id: string, parentId: string | null) => Promise<void>;
  setCollectionVisible: (id: string, visible: boolean) => Promise<void>;
  deleteCollection: (id: string) => Promise<void>;

  /** Show or hide every place and folder at once (the "show/hide all" action). */
  setAllVisible: (visible: boolean) => Promise<void>;

  /** Everything exportable (rule 5): zip when the platform can, else JSON. */
  exportAll: () => Promise<void>;
  getSetting: (key: string) => Promise<string | null>;
  /** Fire-and-forget setting write (auto-save). */
  setSetting: (key: string, value: string) => void;
}

export const sanitizeFileName = (name: string): string =>
  name.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'unnamed';

/**
 * All user data (collections/places/tracks) as React state, with mutations
 * that write through to persistent storage and refresh — every change is
 * saved immediately (auto-save everywhere), there is no explicit save step.
 * Local data is authoritative — the server only syncs (ARCHITECTURE.md
 * rule 3).
 */
export function useUserData<TFile>(platform: UserDataPlatform<TFile>): UserData<TFile> {
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [undoable, setUndoable] = useState<UndoableDelete | null>(null);
  const [collections, setCollections] = useState<CollectionRecord[]>([]);
  const [places, setPlaces] = useState<PlaceRecord[]>([]);
  const [tracks, setTracks] = useState<TrackRecord[]>([]);
  const [storage, setStorage] = useState<AtlasStorage | null>(null);
  const storageRef = useRef<AtlasStorage | null>(null);
  const trackDataCache = useRef(new Map<string, TrackData>());

  const clearWriteError = useCallback(() => setWriteError(null), []);
  const clearUndoable = useCallback(() => setUndoable(null), []);
  // A rejected write means the change was NOT saved — surface it rather than
  // letting it look like a no-op (never *silently* lose user data).
  const reportWriteFailure = useCallback((action: string, err: unknown) => {
    console.error(`${action} failed`, err);
    setWriteError(`${action} failed — ${err instanceof Error ? err.message : String(err)}`);
  }, []);

  /**
   * Arm the undo for a delete. Deletions are immediate rather than
   * confirm()-gated — the snapshot storage hands back can re-create the record
   * under its original id, which is the friendlier trade (and the only one that
   * works on touch, where a modal confirm is a tap-through reflex).
   */
  const offerUndo = useCallback(
    (deleted: DeletedRecord | null, refresh: () => Promise<void>) => {
      if (!deleted) return;
      const name = typeof deleted.data['name'] === 'string' ? deleted.data['name'] : 'item';
      setUndoable({
        message: `Deleted "${name}"`,
        undo: async () => {
          try {
            await storageRef.current?.restore(deleted);
            await refresh();
          } catch (err) {
            reportWriteFailure('Undoing the delete', err);
          }
          setUndoable(null);
        },
      });
    },
    [reportWriteFailure],
  );

  useEffect(() => {
    let cancelled = false;
    platform.openStorage().then(
      async (s) => {
        if (cancelled) return;
        storageRef.current = s;
        const [c, p, t] = await Promise.all([s.listCollections(), s.listPlaces(), s.listTracks()]);
        if (cancelled) return;
        setCollections(c);
        setPlaces(p);
        setTracks(t);
        setStorage(s);
        setStatus('ready');
      },
      (err: unknown) => {
        if (cancelled) return;
        console.error('Persistent storage unavailable', err);
        setError(err instanceof Error ? err.message : String(err));
        setStatus('error');
      },
    );
    return () => {
      cancelled = true;
      storageRef.current = null;
    };
  }, [platform]);

  const refreshPlaces = useCallback(async () => {
    if (storageRef.current) setPlaces(await storageRef.current.listPlaces());
  }, []);
  const refreshTracks = useCallback(async () => {
    if (storageRef.current) setTracks(await storageRef.current.listTracks());
  }, []);
  const refreshCollections = useCallback(async () => {
    if (storageRef.current) setCollections(await storageRef.current.listCollections());
  }, []);
  const refreshAll = useCallback(async () => {
    await Promise.all([refreshCollections(), refreshPlaces(), refreshTracks()]);
  }, [refreshCollections, refreshPlaces, refreshTracks]);

  const savePlace = useCallback(
    async (input: NewPlace) => {
      const s = storageRef.current;
      if (!s) return null;
      try {
        const place = await s.createPlace(input);
        await refreshPlaces();
        return place;
      } catch (err) {
        reportWriteFailure('Saving place', err);
        return null;
      }
    },
    [refreshPlaces, reportWriteFailure],
  );

  const updatePlace = useCallback(
    async (id: string, patch: PlacePatch) => {
      try {
        await storageRef.current?.updatePlace(id, patch);
        await refreshPlaces();
      } catch (err) {
        reportWriteFailure('Updating place', err);
      }
    },
    [refreshPlaces, reportWriteFailure],
  );

  const deletePlace = useCallback(
    async (id: string) => {
      try {
        const deleted = (await storageRef.current?.deletePlace(id)) ?? null;
        await refreshPlaces();
        offerUndo(deleted, refreshPlaces);
      } catch (err) {
        reportWriteFailure('Deleting place', err);
      }
    },
    [refreshPlaces, reportWriteFailure, offerUndo],
  );

  const reorderPlaces = useCallback(
    async (orderedIds: string[]) => {
      try {
        await storageRef.current?.reorderPlaces(orderedIds);
        await refreshPlaces();
      } catch (err) {
        reportWriteFailure('Reordering places', err);
      }
    },
    [refreshPlaces, reportWriteFailure],
  );

  const reorderCollections = useCallback(
    async (orderedIds: string[]) => {
      try {
        await storageRef.current?.reorderCollections(orderedIds);
        await refreshCollections();
      } catch (err) {
        reportWriteFailure('Reordering folders', err);
      }
    },
    [refreshCollections, reportWriteFailure],
  );

  const importFiles = useCallback(
    async (files: TFile[]): Promise<ImportResult> => {
      const s = storageRef.current;
      const result: ImportResult = { tracks: [], places: [], errors: [], restored: null };
      if (!s) return result;

      for (const file of files) {
        let name = '(unreadable file)';
        try {
          const read = await platform.readFile(file);
          name = read.name;
          const lower = read.name.toLowerCase();
          // A .json/.zip pick is a full backup, never a track file — checked
          // first so a restore is never mistaken for a failed GPX parse.
          if (lower.endsWith('.json') || lower.endsWith('.zip')) {
            const dump = readBackupFile(read.name, read.bytes);
            if (!dump) {
              result.errors.push(`${read.name}: not an Atlas backup file`);
              continue;
            }
            result.restored = addSummary(result.restored, await s.importAll(dump));
            continue;
          }
          const data = parseTrackFile(read.name, read.bytes);
          if (data.segments.length > 0) {
            // Preserve original GPX byte-for-byte (extensions and all — rule 5:
            // never trap user data); KML/KMZ are converted to canonical GPX.
            const gpx = read.name.toLowerCase().endsWith('.gpx')
              ? new TextDecoder().decode(read.bytes)
              : buildGpx(data);
            const stats = computeTrackStats(data) as unknown as Record<string, number>;
            const track = await s.createTrack({ name: data.name ?? read.name, gpx, stats });
            trackDataCache.current.set(track.id, data);
            result.tracks.push(track);
          } else if (data.waypoints.length > 0) {
            // A waypoints-only file is a list of favorites, not a track.
            for (const w of data.waypoints) {
              result.places.push(
                await s.createPlace({
                  name: w.name ?? `${w.lat.toFixed(5)}, ${w.lng.toFixed(5)}`,
                  lat: w.lat,
                  lng: w.lng,
                }),
              );
            }
          } else {
            result.errors.push(`${read.name}: no tracks or waypoints found`);
          }
        } catch (err) {
          result.errors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      // A restore also brings folders (and settings) in, so refresh all three.
      await Promise.all([refreshTracks(), refreshPlaces(), refreshCollections()]);
      return result;
    },
    [platform, refreshTracks, refreshPlaces, refreshCollections],
  );

  const updateTrack = useCallback(
    async (id: string, patch: TrackPatch) => {
      try {
        await storageRef.current?.updateTrack(id, patch);
        await refreshTracks();
      } catch (err) {
        reportWriteFailure('Updating track', err);
      }
    },
    [refreshTracks, reportWriteFailure],
  );

  const deleteTrack = useCallback(
    async (id: string) => {
      try {
        const deleted = (await storageRef.current?.deleteTrack(id)) ?? null;
        trackDataCache.current.delete(id);
        await refreshTracks();
        // Undoing re-reads the GPX from storage, so the dropped cache entry
        // costs one parse, not the track.
        offerUndo(deleted, refreshTracks);
      } catch (err) {
        reportWriteFailure('Deleting track', err);
      }
    },
    [refreshTracks, reportWriteFailure, offerUndo],
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

  const exportTrack = useCallback(
    async (id: string, format: 'gpx' | 'kml') => {
      const s = storageRef.current;
      if (!s) return;
      const track = (await s.listTracks()).find((t) => t.id === id);
      const gpx = await s.getTrackGpx(id);
      if (!track || !gpx) return;
      const body = format === 'gpx' ? gpx : buildKml(parseGpx(gpx));
      const mime =
        format === 'gpx' ? 'application/gpx+xml' : 'application/vnd.google-earth.kml+xml';
      await platform.saveTextFile(`${sanitizeFileName(track.name)}.${format}`, body, mime);
    },
    [platform],
  );

  const createCollection = useCallback(
    async (name: string, parentId: string | null = null) => {
      try {
        await storageRef.current?.createCollection(name, parentId);
        await refreshCollections();
      } catch (err) {
        reportWriteFailure('Creating folder', err);
      }
    },
    [refreshCollections, reportWriteFailure],
  );

  const renameCollection = useCallback(
    async (id: string, name: string) => {
      try {
        await storageRef.current?.renameCollection(id, name);
        await refreshCollections();
      } catch (err) {
        reportWriteFailure('Renaming folder', err);
      }
    },
    [refreshCollections, reportWriteFailure],
  );

  const moveCollection = useCallback(
    async (id: string, parentId: string | null) => {
      try {
        await storageRef.current?.moveCollection(id, parentId);
        await refreshCollections();
      } catch (err) {
        reportWriteFailure('Moving collection', err);
      }
    },
    [refreshCollections, reportWriteFailure],
  );

  const setCollectionVisible = useCallback(
    async (id: string, visible: boolean) => {
      try {
        await storageRef.current?.setCollectionVisible(id, visible);
        await refreshCollections();
      } catch (err) {
        reportWriteFailure('Updating folder', err);
      }
    },
    [refreshCollections, reportWriteFailure],
  );

  const deleteCollection = useCallback(
    async (id: string) => {
      try {
        const deleted = (await storageRef.current?.deleteCollection(id)) ?? null;
        await refreshAll();
        // Undo also re-parents the contents the delete moved up a level, so
        // places and tracks have to be reloaded too.
        offerUndo(deleted, refreshAll);
      } catch (err) {
        reportWriteFailure('Deleting folder', err);
      }
    },
    [refreshAll, reportWriteFailure, offerUndo],
  );

  const setAllVisible = useCallback(
    async (visible: boolean) => {
      const s = storageRef.current;
      if (!s) return;
      try {
        const [ps, cs] = await Promise.all([s.listPlaces(), s.listCollections()]);
        // Only flip rows that differ, so we don't churn updated_at (and the sync
        // outbox) for records already in the wanted state.
        await Promise.all([
          ...ps.filter((p) => p.visible !== visible).map((p) => s.updatePlace(p.id, { visible })),
          ...cs
            .filter((c) => c.visible !== visible)
            .map((c) => s.setCollectionVisible(c.id, visible)),
        ]);
        await Promise.all([refreshPlaces(), refreshCollections()]);
      } catch (err) {
        reportWriteFailure('Updating visibility', err);
      }
    },
    [refreshPlaces, refreshCollections, reportWriteFailure],
  );

  const exportAll = useCallback(async () => {
    const s = storageRef.current;
    if (!s) return;
    const dump = await s.exportAll();
    const date = new Date().toISOString().slice(0, 10);
    const json = JSON.stringify(dump, null, 2);
    if (!platform.saveZipFile) {
      await platform.saveTextFile(`atlas-export-${date}.json`, json, 'application/json');
      return;
    }
    const encoder = new TextEncoder();
    const files: Record<string, Uint8Array> = { 'atlas-export.json': encoder.encode(json) };
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
    await platform.saveZipFile(`atlas-export-${date}.zip`, zipSync(files));
  }, [platform]);

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
    writeError,
    clearWriteError,
    undoable,
    clearUndoable,
    collections,
    places,
    tracks,
    storage: status === 'ready' ? storage : null,
    refreshAll,
    savePlace,
    updatePlace,
    deletePlace,
    reorderPlaces,
    reorderCollections,
    importFiles,
    updateTrack,
    deleteTrack,
    getTrackData,
    exportTrack,
    createCollection,
    renameCollection,
    moveCollection,
    setCollectionVisible,
    deleteCollection,
    setAllVisible,
    exportAll,
    getSetting,
    setSetting,
  };
}
