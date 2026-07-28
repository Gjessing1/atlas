import {
  buildGpx,
  buildKml,
  buildKmlTree,
  computeTrackStats,
  parseGpx,
  parseTrackFile,
  type KmlFolder,
  type TrackData,
} from '@atlas/gpx';
import { inaturSegments, inaturTrackName, type InaturArea } from '@atlas/core';
import type {
  AtlasStorage,
  CollectionRecord,
  DeletedRecord,
  ExportedData,
  ImportSummary,
  NewPlace,
  NewTrack,
  PlacePatch,
  PlaceRecord,
  StorageUnavailableReason,
  TrackPatch,
  TrackRecord,
} from '@atlas/storage';
import { parseExportedData, storageUnavailableReason } from '@atlas/storage';
import { unzipSync, zipSync } from 'fflate';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  resolveCollectionDrop,
  type CollectionDragItem,
  type CollectionDropZone,
} from './collectionDnd.js';

/**
 * Platform seams for useUserData. Must be referentially stable across renders
 * (module const or useMemo) — `openStorage` identity gates the open effect.
 *
 * `TFile` is whatever the platform's picker hands the importer (a DOM `File`
 * on web, a `{ name, uri }` from expo-document-picker on Android).
 */
export interface UserDataPlatform<TFile> {
  openStorage: () => Promise<AtlasStorage>;
  /**
   * Optional: resolve once a storage that was `busy` may be free again — on
   * web, when the page holding the exclusive OPFS handles goes away. Lets a
   * second tab come alive by itself instead of leaving the user at a dead end
   * with no clue that closing the other one is what unblocks it.
   *
   * Rejection (including on abort) means "stop waiting", never "retry now".
   */
  awaitAvailability?: (signal: AbortSignal) => Promise<void>;
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

/**
 * The whole library as one KMZ (a zip holding `doc.kml`), so the export is not
 * only restorable into Atlas but also portable to other mapping platforms with
 * the folder structure intact. Tracks whose stored GPX no longer parses are
 * skipped — a backup must never fail over one bad row.
 */
function buildLibraryKmz(dump: ExportedData): Uint8Array {
  const ids = new Set(dump.collections.map((c) => c.id));
  const itemsIn = (collectionId: string | null): TrackData[] => {
    const inFolder = <T extends { collectionId: string | null }>(record: T): boolean =>
      collectionId === null
        ? record.collectionId === null || !ids.has(record.collectionId)
        : record.collectionId === collectionId;

    const items: TrackData[] = [];
    const waypoints = dump.places
      .filter(inFolder)
      .map((p) => ({ lat: p.lat, lng: p.lng, name: p.name, address: p.address || undefined }));
    if (waypoints.length > 0) items.push({ segments: [], waypoints });
    for (const track of dump.tracks.filter(inFolder)) {
      try {
        items.push({ ...parseGpx(track.gpx), name: track.name });
      } catch (err) {
        console.error('Skipping unparseable track in KMZ export', track.id, err);
      }
    }
    return items;
  };

  const asFolder = (collection: CollectionRecord): KmlFolder => ({
    name: collection.name,
    items: itemsIn(collection.id),
    children: dump.collections.filter((c) => c.parentId === collection.id).map(asFolder),
  });

  const kml = buildKmlTree({
    name: 'Atlas',
    items: itemsIn(null),
    // Folders with a missing parent are roots, matching how the lists render.
    children: dump.collections
      .filter((c) => c.parentId === null || !ids.has(c.parentId))
      .map(asFolder),
  });
  return zipSync({ 'doc.kml': new TextEncoder().encode(kml) });
}

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

/** Where regular GPX/KML/KMZ records should be filed after import. */
export interface ImportOptions {
  /** Existing collection, or null/the default for the root. */
  collectionId?: string | null;
  /** Create this collection lazily when the file contains importable records. */
  newCollection?: { name: string; parentId?: string | null };
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
 * (which also holds GPX/KMZ copies — those are for other apps to read, the JSON
 * is the authoritative one, so the other entries are deliberately ignored here).
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

/**
 * Whether the user's data is actually open, and what to say (and offer) when
 * it is not. Broken out of `UserData` because the surfaces that report it —
 * a banner, the Account panel — have no business with the rest of the API.
 */
export interface StorageAvailability {
  /** 'error' means persistent storage is unavailable. */
  status: 'loading' | 'ready' | 'error';
  error: string | null;
  /**
   * Why, when `status` is 'error'. `'busy'` is the recoverable one: another
   * page holds the database and this one takes over when that page closes, so
   * the UI should say *that* rather than offer a pointless retry.
   */
  errorReason: StorageUnavailableReason | null;
  /** Open again after a failure. A no-op unless `status` is 'error'. */
  retry: () => void;
}

export interface UserData<TFile> extends StorageAvailability {
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
  /** Apply the shared place/folder drop rules and refresh the affected lists. */
  arrangeCollectionItem: (
    drag: CollectionDragItem,
    target: CollectionDragItem,
    zone: CollectionDropZone,
  ) => Promise<void>;

  importFiles: (files: TFile[], options?: ImportOptions) => Promise<ImportResult>;
  /** Save generated geometry (for example a planned route) as a synced track. */
  saveTrack: (
    data: TrackData,
    name: string,
    collectionId?: string | null,
  ) => Promise<TrackRecord | null>;
  /**
   * Save a resolved iNatur permit as a filled, synced area overlay with a GPX
   * boundary underneath for normal export and cross-app portability.
   */
  savePermitArea: (area: InaturArea, collectionId?: string | null) => Promise<TrackRecord | null>;
  updateTrack: (id: string, patch: TrackPatch) => Promise<void>;
  deleteTrack: (id: string) => Promise<void>;
  /** Parsed geometry for a track (cached in memory). */
  getTrackData: (id: string) => Promise<TrackData | null>;
  /** Export one track as .gpx (stored original) or .kml (converted). */
  exportTrack: (id: string, format: 'gpx' | 'kml') => Promise<void>;

  createCollection: (name: string, parentId?: string | null) => Promise<CollectionRecord | null>;
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
 * The one permit-area persistence shape used by both apps: interoperable GPX
 * boundary plus the topology the map needs to fill holes correctly.
 */
export function permitTrackInput(
  area: InaturArea,
  collectionId: string | null = null,
): { data: TrackData; input: NewTrack } {
  const name = inaturTrackName(area);
  const data: TrackData = { name, segments: inaturSegments(area), waypoints: [] };
  return {
    data,
    input: {
      name,
      gpx: buildGpx(data),
      stats: computeTrackStats(data) as unknown as Record<string, number>,
      collectionId,
      tags: ['iNatur permit'],
      area: {
        kind: 'area',
        source: 'inatur',
        sourceId: area.offerId,
        polygons: area.polygons,
        bbox: area.bbox,
      },
    },
  };
}

/**
 * Serializes the storage lifecycle: each open waits for every previous
 * instance's close to finish. Module-level because the underlying resource is
 * too — the web driver takes exclusive OPFS handles, so a remount (StrictMode,
 * platform change) must not race a new open against a still-closing
 * predecessor. Never left rejected, so one failed close cannot wedge the app.
 */
let storageCloseChain: Promise<unknown> = Promise.resolve();

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
  const [errorReason, setErrorReason] = useState<StorageUnavailableReason | null>(null);
  // Bumping this re-runs the open effect: the user pressing Retry, or the
  // platform reporting that whoever held the database has let go. `manual`
  // separates the two — a press deserves the visible "loading" it asked for,
  // a background attempt must leave what the UI already says alone.
  const [attempt, setAttempt] = useState({ n: 0, manual: false });
  const statusRef = useRef(status);
  statusRef.current = status;
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

  /**
   * Try again after a failure. Guarded on the error state because a reopen of
   * a working database would close it first — a stray call must not take the
   * app offline for a moment.
   */
  const retry = useCallback(() => {
    if (statusRef.current === 'error') setAttempt((a) => ({ n: a.n + 1, manual: true }));
  }, []);

  useEffect(() => {
    let cancelled = false;
    const waiting = new AbortController();
    // Retrying in the background behind a stated error keeps the error stated:
    // flipping back to 'loading' on every attempt made the banner blink.
    if (attempt.manual || statusRef.current !== 'error') setStatus('loading');
    const opened = storageCloseChain.then(() => platform.openStorage());
    opened.then(
      async (s) => {
        if (cancelled) return;
        storageRef.current = s;
        const [c, p, t] = await Promise.all([s.listCollections(), s.listPlaces(), s.listTracks()]);
        if (cancelled) return;
        setCollections(c);
        setPlaces(p);
        setTracks(t);
        setStorage(s);
        setError(null);
        setErrorReason(null);
        setStatus('ready');
      },
      (err: unknown) => {
        if (cancelled) return;
        console.error('Persistent storage unavailable', err);
        const reason = storageUnavailableReason(err);
        setError(err instanceof Error ? err.message : String(err));
        setErrorReason(reason);
        setStatus('error');
        // Somebody else has it: wait for them to let go and take over, rather
        // than making the user work out that a second tab is the problem.
        if (reason === 'busy' && platform.awaitAvailability) {
          platform.awaitAvailability(waiting.signal).then(
            () => {
              if (!cancelled) setAttempt((a) => ({ n: a.n + 1, manual: false }));
            },
            () => undefined,
          );
        }
      },
    );
    return () => {
      cancelled = true;
      waiting.abort();
      storageRef.current = null;
      // Close whatever this effect opened — even when the open resolves after
      // cleanup, the chained close still releases it (no leaked instance, no
      // dangling exclusive OPFS handles).
      storageCloseChain = opened
        .then(
          (s) => s.close(),
          () => undefined,
        )
        .catch(() => undefined);
    };
  }, [platform, attempt]);

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

  const arrangeCollectionItem = useCallback(
    async (
      drag: CollectionDragItem,
      target: CollectionDragItem,
      zone: CollectionDropZone,
    ): Promise<void> => {
      const s = storageRef.current;
      if (!s) return;
      const operations = resolveCollectionDrop({ collections, places, drag, target, zone });
      if (operations.length === 0) return;
      try {
        for (const operation of operations) {
          switch (operation.type) {
            case 'move-place':
              await s.updatePlace(operation.id, { collectionId: operation.collectionId });
              break;
            case 'move-folder':
              await s.moveCollection(operation.id, operation.parentId);
              break;
            case 'reorder-places':
              await s.reorderPlaces(operation.orderedIds);
              break;
            case 'reorder-folders':
              await s.reorderCollections(operation.orderedIds);
              break;
          }
        }
        await Promise.all([refreshCollections(), refreshPlaces()]);
      } catch (err) {
        reportWriteFailure('Arranging collections', err);
      }
    },
    [collections, places, refreshCollections, refreshPlaces, reportWriteFailure],
  );

  const importFiles = useCallback(
    async (files: TFile[], options: ImportOptions = {}): Promise<ImportResult> => {
      const s = storageRef.current;
      const result: ImportResult = { tracks: [], places: [], errors: [], restored: null };
      if (!s) return result;

      // Create a requested destination only after finding an importable regular
      // file. Backups restore their own hierarchy and must never be rewritten
      // into this target (or leave an empty folder behind).
      let targetCollectionId: string | null | undefined = options.newCollection
        ? undefined
        : (options.collectionId ?? null);
      const resolveTargetCollection = async (): Promise<string | null> => {
        if (targetCollectionId !== undefined) return targetCollectionId;
        const name = options.newCollection?.name.trim();
        if (!name) {
          targetCollectionId = null;
          return targetCollectionId;
        }
        const collection = await s.createCollection(name, options.newCollection?.parentId ?? null);
        targetCollectionId = collection.id;
        return targetCollectionId;
      };

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
            const track = await s.createTrack({
              name: data.name ?? read.name,
              gpx,
              stats,
              collectionId: await resolveTargetCollection(),
            });
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
                  address: w.address,
                  collectionId: await resolveTargetCollection(),
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

  const saveTrack = useCallback(
    async (
      data: TrackData,
      name: string,
      collectionId: string | null = null,
    ): Promise<TrackRecord | null> => {
      const s = storageRef.current;
      if (!s) return null;
      try {
        const savedName = name.trim() || data.name?.trim() || 'Planned route';
        const track = await s.createTrack({
          name: savedName,
          gpx: buildGpx({ ...data, name: savedName }),
          stats: computeTrackStats(data) as unknown as Record<string, number>,
          collectionId,
        });
        trackDataCache.current.set(track.id, data);
        await refreshTracks();
        return track;
      } catch (err) {
        reportWriteFailure('Saving route', err);
        return null;
      }
    },
    [refreshTracks, reportWriteFailure],
  );

  const savePermitArea = useCallback(
    async (area: InaturArea, collectionId: string | null = null): Promise<TrackRecord | null> => {
      const s = storageRef.current;
      if (!s) return null;
      try {
        const { data, input } = permitTrackInput(area, collectionId);
        const track = await s.createTrack(input);
        trackDataCache.current.set(track.id, data);
        await refreshTracks();
        return track;
      } catch (err) {
        reportWriteFailure('Saving permit area', err);
        return null;
      }
    },
    [refreshTracks, reportWriteFailure],
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
        const collection = (await storageRef.current?.createCollection(name, parentId)) ?? null;
        await refreshCollections();
        return collection;
      } catch (err) {
        reportWriteFailure('Creating folder', err);
        return null;
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
        // Tracks are in the list this button sits above — on both clients now —
        // so "Hide all" that left every track drawn was answering a different
        // question from the one the user asked.
        const [ps, ts, cs] = await Promise.all([
          s.listPlaces(),
          s.listTracks(),
          s.listCollections(),
        ]);
        // Only flip rows that differ, so we don't churn updated_at (and the sync
        // outbox) for records already in the wanted state.
        await Promise.all([
          ...ps.filter((p) => p.visible !== visible).map((p) => s.updatePlace(p.id, { visible })),
          ...ts.filter((t) => t.visible !== visible).map((t) => s.updateTrack(t.id, { visible })),
          ...cs
            .filter((c) => c.visible !== visible)
            .map((c) => s.setCollectionVisible(c.id, visible)),
        ]);
        await Promise.all([refreshPlaces(), refreshTracks(), refreshCollections()]);
      } catch (err) {
        reportWriteFailure('Updating visibility', err);
      }
    },
    [refreshPlaces, refreshTracks, refreshCollections, reportWriteFailure],
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
    const files: Record<string, Uint8Array> = {
      [EXPORT_JSON_NAME]: encoder.encode(json),
      // Interop copy: the same library as KMZ, for other mapping platforms.
      'atlas-export.kmz': buildLibraryKmz(dump),
    };
    if (dump.places.length > 0) {
      files['places.gpx'] = encoder.encode(
        buildGpx({
          name: 'Atlas places',
          segments: [],
          waypoints: dump.places.map((p) => ({
            lat: p.lat,
            lng: p.lng,
            name: p.name,
            address: p.address || undefined,
          })),
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
    errorReason,
    retry,
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
    arrangeCollectionItem,
    importFiles,
    saveTrack,
    savePermitArea,
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
