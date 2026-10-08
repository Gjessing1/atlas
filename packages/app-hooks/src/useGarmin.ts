import {
  fmtKm,
  fmtShortDate,
  GARMIN_ACTIVITY_TAG,
  GARMIN_COURSE_TAG,
  garminSportFolder,
  garminTypeLabel,
  visibleOnMap,
  type GarminCourseSport,
} from '@atlas/core';
import { buildGpx, computeTrackStats, parseGpx } from '@atlas/gpx';
import { routePathToTrackData, type RoutePath, type RoutingProfile } from '@atlas/routing';
import type { AtlasStorage, CollectionRecord, TrackRecord } from '@atlas/storage';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SyncState } from './useSync.js';
import type { UserData } from './useUserData.js';

interface GarminActivity {
  id: string;
  name: string;
  date: string | null;
  type: string | null;
  hasRoute?: boolean;
}
export interface GarminDevice {
  id: string;
  name: string;
}
/** A course in the user's Garmin Connect library. */
export interface GarminCourse {
  id: string;
  name: string;
  /** Garmin `typeKey`, e.g. `trail_running`. */
  type: string | null;
  distanceM: number | null;
  ascentM: number | null;
  /** Last change in Garmin Connect, epoch ms. */
  updated: number | null;
}

export interface GarminDelivery {
  deviceName: string;
  /** Recorded since replacing an edited course re-sends to the same watch. */
  deviceId?: string;
  queuedAt: number;
  /** Garmin's course revision when the send request succeeded. */
  courseUpdated: number | null;
  changed?: boolean;
}

/** Garmin confirms queueing, but does not expose the installed course list of a watch. */
export function garminDeliveryLine(course: GarminCourse, delivery: GarminDelivery): string {
  const changed =
    course.updated !== null &&
    delivery.courseUpdated !== null &&
    course.updated > delivery.courseUpdated + 60_000;
  if (changed || delivery.changed)
    return `Changed since last sent to ${delivery.deviceName} · send again`;
  return `Sent to ${delivery.deviceName} ${fmtShortDate(delivery.queuedAt)} · watch sync unverified`;
}

/** A Garmin course open in the planner for reshaping, saved into Atlas as `trackId`. */
export interface GarminCourseEdit {
  id: string;
  name: string;
  type: string | null;
  trackId: string;
}

/**
 * An edited course now on Garmin as `newId`. The old one stays until the user confirms its
 * deletion: Garmin's PUT cannot replace geometry safely, and create-then-delete leaves a
 * working course on the account if either step fails.
 */
export interface GarminReplacement {
  oldId: string;
  newId: string;
  name: string;
  /** The watch the new course was queued for, when that succeeded. */
  queuedTo: string | null;
}

/** The planner profile to reshape a course in: its sport's closest routing costing. */
export function garminCourseProfile(type: string | null): RoutingProfile {
  if (!type) return 'hike';
  if (type.includes('running')) return 'run';
  if (type.includes('cycling') || type.includes('biking')) return 'bike';
  if (type === 'walking') return 'foot';
  return 'hike';
}

/** The watch an edited course should go back to: the one it was last sent to. */
export function garminResendDevice(
  delivery: GarminDelivery | undefined,
  devices: readonly GarminDevice[],
): string {
  if (delivery?.deviceId && devices.some((device) => device.id === delivery.deviceId))
    return delivery.deviceId;
  return devices.find((device) => device.name === delivery?.deviceName)?.id ?? '';
}

/** "Trail running · 18.0 km · ↗ 536 m · 5 Jul" — the second line of a course row. */
export function garminCourseLine(course: GarminCourse, nowMs = Date.now()): string {
  const parts: string[] = [];
  if (course.type) parts.push(garminTypeLabel(course.type));
  if (course.distanceM) parts.push(fmtKm(course.distanceM));
  if (course.ascentM && course.ascentM >= 1) parts.push(`↗ ${Math.round(course.ascentM)} m`);
  if (course.updated) parts.push(fmtShortDate(course.updated, nowMs));
  return parts.join(' · ');
}

/** Sport filters for a course list: one per sport folder present, most courses first. */
export function garminCourseSports(courses: readonly GarminCourse[]) {
  const counts = new Map<string, number>();
  for (const course of courses) {
    const sport = garminSportFolder(course.type);
    counts.set(sport, (counts.get(sport) ?? 0) + 1);
  }
  return [...counts]
    .map(([sport, count]) => ({ sport, count }))
    .sort((a, b) => b.count - a.count || a.sport.localeCompare(b.sport));
}

const ACTIVITIES_FOLDER = 'Garmin activities';
const COURSES_FOLDER = 'Garmin courses';

/** The Garmin type kept as a track's plain tag beside its `garmin:`/`garmin-course:` id tag. */
const typeTag = (tags: readonly string[]) =>
  tags.find(
    (tag) =>
      tag !== '' && !tag.startsWith(GARMIN_ACTIVITY_TAG) && !tag.startsWith(GARMIN_COURSE_TAG),
  ) ?? null;

/**
 * Finds or creates `<root> › <sport>` folders. Lookups are by name so a folder the user
 * created, or one another device synced, is reused rather than duplicated; the root is
 * matched at top level first, then anywhere, because earlier versions found it by name alone.
 */
function sportFolders(storage: AtlasStorage, rootName: string) {
  let listed: Promise<CollectionRecord[]> | null = null;
  let root: CollectionRecord | null = null;
  const children = new Map<string, CollectionRecord>();
  const list = () => (listed ??= storage.listCollections());
  return {
    async root(create: boolean): Promise<CollectionRecord | null> {
      if (root) return root;
      const all = await list();
      root =
        all.find((c) => c.name === rootName && c.parentId === null) ??
        all.find((c) => c.name === rootName) ??
        null;
      if (!root && create) root = await storage.createCollection(rootName);
      return root;
    },
    async forType(type: string | null): Promise<CollectionRecord> {
      const parent = (await this.root(true))!;
      const name = garminSportFolder(type);
      let folder = children.get(name);
      if (!folder) {
        folder =
          (await list()).find((c) => c.parentId === parent.id && c.name === name) ??
          (await storage.createCollection(name, parent.id));
        children.set(name, folder);
      }
      return folder;
    },
  };
}

export interface GarminState {
  connected: boolean | null;
  mfaRequired: boolean;
  busy: boolean;
  error: string | null;
  lastCourseUrl: string | null;
  lastCourseQueued: boolean | null;
  devices: GarminDevice[];
  /** `sorted`: earlier imports moved out of the top folder into their sport folder. */
  lastImport: { imported: number; skipped: number; errors: number; sorted: number } | null;
  nextActivityOffset: number;
  historyComplete: boolean;
  refresh: () => Promise<void>;
  connect: (email: string, password: string) => Promise<void>;
  completeMfa: (code: string) => Promise<void>;
  disconnect: () => Promise<void>;
  loadDevices: () => Promise<void>;
  uploadCourse: (
    path: RoutePath,
    name: string,
    profile: RoutingProfile,
    deviceId?: string,
  ) => Promise<void>;
  clearCourseResult: () => void;
  /** Imports the next 30 activities further back in history. */
  importActivities: () => Promise<void>;
  restartActivityImport: () => Promise<void>;
  /** Imports everything recorded since the newest activity already in Atlas. */
  checkNewActivities: () => Promise<void>;
  /** This device's schedule for `checkNewActivities`. */
  autoImport: GarminAutoImport;
  setAutoImport: (value: GarminAutoImport) => Promise<void>;
  /** When this device last checked for new activities (epoch ms); null if never. */
  lastActivityCheck: number | null;
  /** The Garmin Connect course library; null until first loaded. */
  courses: GarminCourse[] | null;
  /** Course id → id of the Atlas track saved from it, when there is one. */
  savedCourses: ReadonlyMap<string, string>;
  coursesOnMap: ReadonlySet<string>;
  setCourseVisible: (id: string, visible: boolean) => Promise<void>;
  /** A successful queue request, not proof that the device has synced. */
  deliveries: ReadonlyMap<string, GarminDelivery>;
  /** The course an edit, delete, send or save is in flight for. */
  pendingCourseId: string | null;
  /** One-line confirmation of the last course action. */
  courseNotice: string | null;
  /** Why the last course action failed; kept apart from `error` so it shows on its row. */
  courseError: string | null;
  loadCourses: () => Promise<void>;
  renameCourse: (id: string, name: string) => Promise<boolean>;
  setCourseSport: (id: string, sport: GarminCourseSport) => Promise<boolean>;
  deleteCourse: (id: string) => Promise<boolean>;
  sendCourse: (id: string, deviceId: string) => Promise<boolean>;
  /** Copies the course into Atlas (Garmin courses › sport); resolves to the track id. */
  saveCourse: (id: string) => Promise<string | null>;
  /** The course being reshaped in the planner, or null. */
  courseEdit: GarminCourseEdit | null;
  /** Saves the course into Atlas if needed and marks it as being edited; resolves to its track. */
  startCourseEdit: (id: string) => Promise<GarminCourseEdit | null>;
  cancelCourseEdit: () => void;
  /**
   * Creates the reshaped course on Garmin under the same name and sport, queues it for
   * `deviceId`, and files the new line in Atlas beside the old copy. The old Garmin course
   * is left for `deleteReplacedCourse`.
   */
  replaceCourse: (path: RoutePath, profile: RoutingProfile, deviceId?: string) => Promise<boolean>;
  replacement: GarminReplacement | null;
  deleteReplacedCourse: () => Promise<boolean>;
  keepReplacedCourse: () => void;
}

const activityOffsetKey = (email: string) => `local.garmin.activityOffset.${email}`;
/** Set once importing walked back to the oldest activity Garmin has. */
const historyCompleteKey = (email: string) => `local.garmin.historyComplete.${email}`;
/** How far back into older history one check reaches: 150 activities, paced like a person. */
const BACKFILL_PAGES = 5;

/**
 * How often new activities are fetched by themselves. Per device (`local.`): two devices on a
 * schedule would race to import the same recording before either had synced it.
 */
export type GarminAutoImport = 'off' | 'sixHours' | 'daily';
const AUTO_IMPORT_KEY = 'local.garmin.autoImport';
const LAST_CHECK_KEY = 'local.garmin.lastActivityCheck';
const AUTO_IMPORT_INTERVAL_MS: Record<Exclude<GarminAutoImport, 'off'>, number> = {
  sixHours: 6 * 3_600_000,
  daily: 24 * 3_600_000,
};
const isAutoImport = (value: unknown): value is GarminAutoImport =>
  value === 'off' || value === 'sixHours' || value === 'daily';

/** Garmin account operations shared by web and Android. Atlas keeps imported tracks locally. */
export function useGarmin<TFile>(sync: SyncState, data: UserData<TFile>): GarminState {
  const [connected, setConnected] = useState<boolean | null>(null);
  const [mfaRequired, setMfaRequired] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastCourseUrl, setLastCourseUrl] = useState<string | null>(null);
  const [lastCourseQueued, setLastCourseQueued] = useState<boolean | null>(null);
  const [devices, setDevices] = useState<GarminDevice[]>([]);
  const [lastImport, setLastImport] = useState<GarminState['lastImport']>(null);
  const [nextActivityOffset, setNextActivityOffset] = useState(0);
  const [historyComplete, setHistoryComplete] = useState(false);
  const [courses, setCourses] = useState<GarminCourse[] | null>(null);
  const [autoImport, setAutoImportState] = useState<GarminAutoImport>('off');
  // undefined until read from settings, null when no check has run on this device.
  const [lastActivityCheck, setLastActivityCheck] = useState<number | null | undefined>(undefined);
  const [deliveries, setDeliveries] = useState<ReadonlyMap<string, GarminDelivery>>(new Map());
  const [pendingCourseId, setPendingCourseId] = useState<string | null>(null);
  const [courseNotice, setCourseNotice] = useState<string | null>(null);
  const [courseError, setCourseError] = useState<string | null>(null);
  const [courseEdit, setCourseEdit] = useState<GarminCourseEdit | null>(null);
  const [replacement, setReplacement] = useState<GarminReplacement | null>(null);
  const request = sync.accountRequest;
  // Settings are read once local storage is open: before that `getSetting` answers null, and
  // a schedule read then would look switched off for the whole session.
  const storageReady = data.storage !== null && data.storage !== undefined;

  const run = useCallback(async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Garmin Connect request failed.');
    } finally {
      setBusy(false);
    }
  }, []);

  const refresh = useCallback(async () => {
    if (!sync.email) {
      setConnected(null);
      return;
    }
    await run(async () => {
      const response = await request<{ connected: boolean }>('/api/garmin/status');
      setConnected(response.connected);
    });
  }, [sync.email, request, run]);

  useEffect(() => {
    setLastCourseUrl(null);
    setLastCourseQueued(null);
    setDevices([]);
    setLastImport(null);
    setError(null);
    setNextActivityOffset(0);
    setHistoryComplete(false);
    setCourses(null);
    setDeliveries(new Map());
    setCourseNotice(null);
    setCourseEdit(null);
    setReplacement(null);
    if (sync.email) void refresh();
    else {
      setConnected(null);
      setMfaRequired(false);
    }
  }, [sync.email, refresh]);

  useEffect(() => {
    if (!sync.email || !storageReady) return;
    let active = true;
    void Promise.all([
      data.getSetting(activityOffsetKey(sync.email)),
      data.getSetting(historyCompleteKey(sync.email)),
    ]).then(([value, complete]) => {
      if (!active) return;
      const parsed = Number(value);
      if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 100_000) {
        setNextActivityOffset(parsed);
      }
      setHistoryComplete(complete === '1');
    });
    return () => {
      active = false;
    };
  }, [sync.email, data.getSetting, storageReady]);

  useEffect(() => {
    if (!storageReady) return;
    let active = true;
    void Promise.all([data.getSetting(AUTO_IMPORT_KEY), data.getSetting(LAST_CHECK_KEY)]).then(
      ([mode, checked]) => {
        if (!active) return;
        if (isAutoImport(mode)) setAutoImportState(mode);
        const at = Number(checked);
        setLastActivityCheck(checked && Number.isFinite(at) && at > 0 ? at : null);
      },
    );
    return () => {
      active = false;
    };
  }, [data.getSetting, storageReady]);

  const resetActivityOffset = useCallback(async () => {
    if (sync.email) {
      await data.setSetting(activityOffsetKey(sync.email), '0');
      await data.setSetting(historyCompleteKey(sync.email), '0');
    }
    setNextActivityOffset(0);
    setHistoryComplete(false);
  }, [sync.email, data.setSetting]);

  const connect = useCallback(
    (email: string, password: string) =>
      run(async () => {
        const response = await request<{ connected: boolean; mfaRequired: boolean }>(
          '/api/garmin/connect',
          { email, password },
        );
        setConnected(response.connected);
        setMfaRequired(response.mfaRequired);
        if (response.connected) await resetActivityOffset();
      }),
    [request, run, resetActivityOffset],
  );

  const completeMfa = useCallback(
    (code: string) =>
      run(async () => {
        await request('/api/garmin/mfa', { code });
        setMfaRequired(false);
        setConnected(true);
        await resetActivityOffset();
      }),
    [request, run, resetActivityOffset],
  );

  const disconnect = useCallback(
    () =>
      run(async () => {
        await request('/api/garmin/disconnect', {});
        setConnected(false);
        setMfaRequired(false);
        setDevices([]);
        setCourses(null);
        setDeliveries(new Map());
        setCourseNotice(null);
        await resetActivityOffset();
      }),
    [request, run, resetActivityOffset],
  );

  const loadDevices = useCallback(
    () =>
      run(async () => {
        const response = await request<{ devices: GarminDevice[] }>('/api/garmin/devices');
        setDevices(response.devices);
      }),
    [request, run],
  );

  const uploadCourse = useCallback(
    (path: RoutePath, name: string, profile: RoutingProfile, deviceId?: string) =>
      run(async () => {
        setLastCourseUrl(null);
        setLastCourseQueued(null);
        if (profile === 'car')
          throw new Error('Garmin courses are available for walking, running, hiking and cycling.');
        const gpx = buildGpx(routePathToTrackData(path, name));
        const response = await request<{ id: number; url: string; queued: boolean }>(
          '/api/garmin/course',
          {
            name,
            profile,
            gpx,
            ...(deviceId ? { deviceId } : {}),
          },
        );
        setLastCourseUrl(response.url);
        setLastCourseQueued(response.queued);
        if (response.queued && deviceId && Number.isFinite(response.id)) {
          const delivery = {
            deviceName: devices.find((device) => device.id === deviceId)?.name ?? 'your device',
            deviceId,
            queuedAt: Date.now(),
            courseUpdated: null,
          };
          await data.setSetting(`garmin.delivery.${response.id}`, JSON.stringify(delivery));
          setDeliveries((current) => new Map(current).set(String(response.id), delivery));
        }
        setCourses(null); // the library has a new course; reload when next shown
      }),
    [data.setSetting, devices, request, run],
  );

  const clearCourseResult = useCallback(() => {
    setLastCourseUrl(null);
    setLastCourseQueued(null);
    setError(null);
    setCourseNotice(null);
    setCourseError(null);
  }, []);

  /**
   * Imports one page of 30 activities from `start` (0 = newest). Activities already in Atlas
   * (by Garmin id) and indoor ones without a GPS route are skipped; `known` counts the former,
   * which is what tells a check for new activities that it has caught up.
   */
  const importPage = useCallback(
    async (storage: AtlasStorage, start: number) => {
      const response = await request<{ activities: GarminActivity[] }>(
        `/api/garmin/activities?start=${start}`,
      );
      const existing = await storage.listTracks();
      const tags = new Set(existing.flatMap((track) => track.tags));
      const folders = sportFolders(storage, ACTIVITIES_FOLDER);
      // Activities imported before sport folders existed sit in the top folder; file them now.
      // Only those still directly in it move — a track the user filed elsewhere stays put.
      let sorted = 0;
      const root = await folders.root(false);
      for (const track of existing) {
        if (!root || track.collectionId !== root.id) continue;
        if (!track.tags.some((tag) => tag.startsWith(GARMIN_ACTIVITY_TAG))) continue;
        const folder = await folders.forType(typeTag(track.tags));
        await storage.updateTrack(track.id, { collectionId: folder.id });
        sorted++;
      }
      let imported = 0;
      let skipped = 0;
      let known = 0;
      let errors = 0;
      for (const activity of response.activities) {
        const tag = `${GARMIN_ACTIVITY_TAG}${activity.id}`;
        if (tags.has(tag)) {
          skipped++;
          known++;
          continue;
        }
        if (activity.hasRoute === false) {
          skipped++;
          continue;
        }
        try {
          const { gpx } = await request<{ gpx: string }>(
            `/api/garmin/activities/${activity.id}/gpx`,
          );
          const track = parseGpx(gpx);
          if (track.segments.every((segment) => segment.length < 2)) {
            skipped++;
            continue;
          }
          const folder = await folders.forType(activity.type);
          const name = activity.name.trim() || track.name || 'Garmin activity';
          await storage.createTrack({
            name,
            gpx,
            stats: computeTrackStats(track) as unknown as Record<string, number>,
            collectionId: folder.id,
            notes: activity.date
              ? `Recorded ${activity.date} in Garmin Connect`
              : 'Garmin Connect activity',
            tags: [tag, ...(activity.type ? [activity.type] : [])],
          });
          tags.add(tag);
          imported++;
        } catch {
          errors++;
        }
      }
      return { count: response.activities.length, imported, skipped, known, errors, sorted };
    },
    [request],
  );

  /** Imports the next page of history, walking back from the newest 30 at a time. */
  const importActivities = useCallback(
    () =>
      run(async () => {
        const storage = data.storage;
        if (!storage) throw new Error('Local storage is unavailable.');
        if (!sync.email) throw new Error('Sign in to your Atlas account first.');
        const key = activityOffsetKey(sync.email);
        const savedOffset = Number(await data.getSetting(key));
        const start =
          Number.isInteger(savedOffset) && savedOffset >= 0 && savedOffset <= 100_000
            ? savedOffset
            : 0;
        const page = await importPage(storage, start);
        await data.refreshAll();
        const next = page.count === 30 ? start + 30 : 0;
        await data.setSetting(key, String(next));
        if (next === 0) await data.setSetting(historyCompleteKey(sync.email), '1');
        setNextActivityOffset(next);
        setHistoryComplete(next === 0);
        setLastImport({
          imported: page.imported,
          skipped: page.skipped,
          errors: page.errors,
          sorted: page.sorted,
        });
      }),
    [data, importPage, run, sync.email],
  );

  /**
   * One check, by hand (↻) or on the schedule. First what was recorded since the last import:
   * pages from the newest until one holds an activity Atlas already has (or Garmin runs out),
   * at most ten pages. Then, until the whole history is in, up to five more pages further back
   * from where the last check stopped — so an account connected with years of recordings
   * fills in over a few checks without anyone pressing "Import older" thirty times.
   */
  const checkNewActivities = useCallback(
    () =>
      run(async () => {
        const storage = data.storage;
        if (!storage) throw new Error('Local storage is unavailable.');
        const email = sync.email;
        if (!email) throw new Error('Sign in to your Atlas account first.');
        const checkedAt = Date.now();
        // Stamped before the work, so a failing check waits for its next turn instead of
        // retrying on every render.
        await data.setSetting(LAST_CHECK_KEY, String(checkedAt));
        setLastActivityCheck(checkedAt);
        const total = { imported: 0, skipped: 0, errors: 0, sorted: 0 };
        const add = (page: Awaited<ReturnType<typeof importPage>>) => {
          total.imported += page.imported;
          total.skipped += page.skipped;
          total.errors += page.errors;
          total.sorted += page.sorted;
        };
        let start = 0;
        let reachedEnd = false;
        for (let pages = 0; pages < 10; pages++) {
          const page = await importPage(storage, start);
          add(page);
          start += 30;
          reachedEnd = page.count < 30;
          if (reachedEnd || page.known > 0) break;
        }
        const offsetKey = activityOffsetKey(email);
        const saved = Number((await data.getSetting(offsetKey)) ?? 0);
        // Every page this pass listed was imported whole, so history resumes after them.
        let offset = Math.max(
          start,
          Number.isInteger(saved) && saved >= 0 && saved <= 100_000 ? saved : 0,
        );
        let complete = reachedEnd || (await data.getSetting(historyCompleteKey(email))) === '1';
        for (let pages = 0; !complete && pages < BACKFILL_PAGES; pages++) {
          const page = await importPage(storage, offset);
          add(page);
          if (page.count < 30) {
            offset = 0;
            complete = true;
          } else offset += 30;
        }
        await data.refreshAll();
        if (complete) offset = 0;
        await data.setSetting(offsetKey, String(offset));
        if (complete) await data.setSetting(historyCompleteKey(email), '1');
        setNextActivityOffset(offset);
        setHistoryComplete(complete);
        setLastImport(total);
      }),
    [data, importPage, run, sync.email],
  );

  const setAutoImport = useCallback(
    async (value: GarminAutoImport) => {
      await data.setSetting(AUTO_IMPORT_KEY, value);
      setAutoImportState(value);
    },
    [data.setSetting],
  );

  // The schedule: check when a check falls due while Atlas is open, and on the next open after
  // one fell due while it was closed (JS timers do not run in the background). It waits for
  // this session's first sync so activities another device already imported are known, rather
  // than imported again under new ids.
  const checkRef = useRef(checkNewActivities);
  checkRef.current = checkNewActivities;
  useEffect(() => {
    if (connected !== true || autoImport === 'off' || !data.storage || sync.lastSyncAt === null)
      return;
    if (lastActivityCheck === undefined) return;
    const due = (lastActivityCheck ?? 0) + AUTO_IMPORT_INTERVAL_MS[autoImport];
    const timer = setTimeout(
      () => void checkRef.current(),
      Math.min(Math.max(0, due - Date.now()), 2 ** 31 - 1),
    );
    return () => clearTimeout(timer);
  }, [connected, autoImport, lastActivityCheck, data.storage, sync.lastSyncAt]);

  const restartActivityImport = useCallback(async () => {
    await resetActivityOffset();
    setLastImport(null);
  }, [resetActivityOffset]);

  const savedCourses = useMemo(() => {
    const saved = new Map<string, string>();
    for (const track of data.tracks ?? [])
      for (const tag of track.tags)
        if (tag.startsWith(GARMIN_COURSE_TAG))
          saved.set(tag.slice(GARMIN_COURSE_TAG.length), track.id);
    return saved;
  }, [data.tracks]);

  const coursesOnMap = useMemo(() => {
    const visible = new Set(
      visibleOnMap(data.tracks ?? [], data.collections ?? []).map((t) => t.id),
    );
    return new Set(
      [...savedCourses].filter(([, trackId]) => visible.has(trackId)).map(([id]) => id),
    );
  }, [data.tracks, data.collections, savedCourses]);

  const setCourseVisible = useCallback(
    async (id: string, visible: boolean) => {
      const trackId = savedCourses.get(id);
      if (!trackId) return;
      const track = data.tracks.find((item) => item.id === trackId);
      if (!track) return;
      if (visible) {
        let folderId = track.collectionId;
        while (folderId) {
          const folder = data.collections.find((item) => item.id === folderId);
          if (!folder) break;
          if (!folder.visible) await data.setCollectionVisible(folder.id, true);
          folderId = folder.parentId;
        }
      }
      if (track.visible !== visible) await data.updateTrack(trackId, { visible });
    },
    [data, savedCourses],
  );

  const loadCourses = useCallback(
    () =>
      run(async () => {
        const response = await request<{ courses: GarminCourse[] }>('/api/garmin/courses');
        const entries = await Promise.all(
          response.courses.map(async (course) => {
            const raw = await data.getSetting(`garmin.delivery.${course.id}`);
            if (!raw) return null;
            try {
              const value: unknown = JSON.parse(raw);
              if (
                typeof value !== 'object' ||
                value === null ||
                !('deviceName' in value) ||
                typeof value.deviceName !== 'string' ||
                !('queuedAt' in value) ||
                typeof value.queuedAt !== 'number' ||
                !Number.isFinite(value.queuedAt)
              )
                return null;
              const updated = 'courseUpdated' in value ? value.courseUpdated : null;
              const deviceId = 'deviceId' in value ? value.deviceId : undefined;
              return [
                course.id,
                {
                  deviceName: value.deviceName,
                  ...(typeof deviceId === 'string' ? { deviceId } : {}),
                  queuedAt: value.queuedAt,
                  courseUpdated: typeof updated === 'number' ? updated : null,
                  changed: 'changed' in value && value.changed === true,
                },
              ] as const;
            } catch {
              return null;
            }
          }),
        );
        setDeliveries(
          new Map(entries.filter((entry): entry is NonNullable<typeof entry> => !!entry)),
        );
        // Newest change first: the course just planned or edited is the one being looked for.
        setCourses([...response.courses].sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0)));
      }),
    [data.getSetting, request, run],
  );

  /** Runs one course action with row-level progress; resolves false when it failed. */
  const courseAction = useCallback(
    async <T>(id: string, work: () => Promise<T>): Promise<T | null> => {
      setPendingCourseId(id);
      setCourseNotice(null);
      setCourseError(null);
      try {
        return await work();
      } catch (reason) {
        setCourseError(reason instanceof Error ? reason.message : 'Garmin Connect request failed.');
        return null;
      } finally {
        setPendingCourseId(null);
      }
    },
    [],
  );

  const patchCourse = (id: string, change: Partial<GarminCourse>) =>
    setCourses((list) =>
      list ? list.map((course) => (course.id === id ? { ...course, ...change } : course)) : list,
    );

  const markCourseChanged = useCallback(
    async (id: string) => {
      const old = deliveries.get(id);
      if (!old) return;
      const next = { ...old, changed: true };
      await data.setSetting(`garmin.delivery.${id}`, JSON.stringify(next));
      setDeliveries((current) => new Map(current).set(id, next));
    },
    [data.setSetting, deliveries],
  );

  const renameCourse = useCallback(
    async (id: string, name: string) =>
      (await courseAction(id, async () => {
        await request(`/api/garmin/courses/${id}`, { name: name.trim() }, 'PATCH');
        patchCourse(id, { name: name.trim(), updated: Date.now() });
        await markCourseChanged(id);
        setCourseNotice(`Renamed to “${name.trim()}” in Garmin Connect.`);
        return true;
      })) === true,
    [courseAction, markCourseChanged, request],
  );

  const setCourseSport = useCallback(
    async (id: string, sport: GarminCourseSport) =>
      (await courseAction(id, async () => {
        await request(`/api/garmin/courses/${id}`, { sport }, 'PATCH');
        patchCourse(id, { type: sport, updated: Date.now() });
        await markCourseChanged(id);
        setCourseNotice('Sport changed in Garmin Connect.');
        return true;
      })) === true,
    [courseAction, markCourseChanged, request],
  );

  const deleteCourse = useCallback(
    async (id: string) =>
      (await courseAction(id, async () => {
        const name = courses?.find((course) => course.id === id)?.name ?? 'Course';
        await request(`/api/garmin/courses/${id}`, undefined, 'DELETE');
        // A failed local cache write cannot undo a successful Connect deletion.
        await data.setSetting(`garmin.delivery.${id}`, '').catch(() => {});
        setCourses((list) => list?.filter((course) => course.id !== id) ?? null);
        setDeliveries((current) => {
          const next = new Map(current);
          next.delete(id);
          return next;
        });
        setCourseNotice(`Deleted “${name}” from Garmin Connect. Remove any watch copy there too.`);
        return true;
      })) === true,
    [courseAction, courses, data.setSetting, request],
  );

  const sendCourse = useCallback(
    async (id: string, deviceId: string) =>
      (await courseAction(id, async () => {
        await request(`/api/garmin/courses/${id}/send`, { deviceId });
        const device = devices.find((item) => item.id === deviceId)?.name ?? 'your device';
        const delivery = {
          deviceName: device,
          deviceId,
          queuedAt: Date.now(),
          courseUpdated: courses?.find((course) => course.id === id)?.updated ?? null,
        };
        await data.setSetting(`garmin.delivery.${id}`, JSON.stringify(delivery));
        setDeliveries((current) => new Map(current).set(id, delivery));
        setCourseNotice(`Queued for ${device}. It arrives on the next sync with Garmin Connect.`);
        return true;
      })) === true,
    [courseAction, courses, data.setSetting, devices, request],
  );

  const saveCourse = useCallback(
    (id: string) =>
      courseAction(id, async () => {
        const already = savedCourses.get(id);
        if (already) return already;
        const storage = data.storage;
        if (!storage) throw new Error('Local storage is unavailable.');
        const course = courses?.find((item) => item.id === id);
        const { gpx } = await request<{ gpx: string }>(`/api/garmin/courses/${id}/gpx`);
        const parsed = parseGpx(gpx);
        if (parsed.segments.every((segment) => segment.length < 2))
          throw new Error('Garmin returned a course without a route.');
        const folder = await sportFolders(storage, COURSES_FOLDER).forType(course?.type ?? null);
        const track: TrackRecord = await storage.createTrack({
          name: course?.name || parsed.name || 'Garmin course',
          gpx,
          stats: computeTrackStats(parsed) as unknown as Record<string, number>,
          collectionId: folder.id,
          notes: 'Copied from Garmin Connect',
          tags: [`${GARMIN_COURSE_TAG}${id}`, ...(course?.type ? [course.type] : [])],
        });
        await data.refreshAll();
        setCourseNotice(`Saved to ${COURSES_FOLDER} › ${folder.name}.`);
        return track.id;
      }),
    [courseAction, courses, data, request, savedCourses],
  );

  const startCourseEdit = useCallback(
    async (id: string) => {
      const course = courses?.find((item) => item.id === id);
      const trackId = await saveCourse(id);
      if (!trackId) return null;
      const edit = {
        id,
        name: course?.name ?? 'Garmin course',
        type: course?.type ?? null,
        trackId,
      };
      setCourseEdit(edit);
      setReplacement(null);
      setCourseNotice(null);
      if (devices.length === 0) void loadDevices();
      return edit;
    },
    [courses, devices.length, loadDevices, saveCourse],
  );

  const cancelCourseEdit = useCallback(() => setCourseEdit(null), []);

  const replaceCourse = useCallback(
    async (path: RoutePath, profile: RoutingProfile, deviceId?: string) => {
      const edit = courseEdit;
      if (!edit) return false;
      return (
        (await courseAction(edit.id, async () => {
          const storage = data.storage;
          if (!storage) throw new Error('Local storage is unavailable.');
          if (profile === 'car')
            throw new Error('Garmin courses are for walking, running, hiking and cycling.');
          const gpx = buildGpx(routePathToTrackData(path, edit.name));
          const created = await request<{ id: number; url: string; queued: boolean }>(
            '/api/garmin/course',
            { name: edit.name, profile, gpx, sportOf: edit.id, ...(deviceId ? { deviceId } : {}) },
          );
          const newId = String(created.id);
          const deviceName = deviceId
            ? (devices.find((device) => device.id === deviceId)?.name ?? 'your device')
            : null;
          if (created.queued && deviceId && deviceName) {
            const delivery = { deviceName, deviceId, queuedAt: Date.now(), courseUpdated: null };
            await data.setSetting(`garmin.delivery.${newId}`, JSON.stringify(delivery));
            setDeliveries((current) => new Map(current).set(newId, delivery));
          }
          // The Atlas copy follows the course: the new line is filed where the old copy was
          // and carries the new id; the old copy stays (it is the user's data) but is named
          // for what it now is, so the folder does not hold two identical-looking entries.
          const old = data.tracks.find((track) => track.id === edit.trackId);
          const folder =
            old?.collectionId ??
            (await sportFolders(storage, COURSES_FOLDER).forType(edit.type)).id;
          await storage.createTrack({
            name: edit.name,
            gpx,
            stats: computeTrackStats(parseGpx(gpx)) as unknown as Record<string, number>,
            collectionId: folder,
            notes: 'Edited in Atlas and sent to Garmin Connect',
            tags: [`${GARMIN_COURSE_TAG}${newId}`, ...(edit.type ? [edit.type] : [])],
          });
          if (old) {
            await storage.updateTrack(old.id, {
              name: `${old.name} (before edit)`,
              tags: old.tags.filter((tag) => !tag.startsWith(GARMIN_COURSE_TAG)),
              visible: false,
            });
          }
          await data.refreshAll();
          setCourses(null);
          setCourseEdit(null);
          setReplacement({
            oldId: edit.id,
            newId,
            name: edit.name,
            queuedTo: created.queued && deviceName ? deviceName : null,
          });
          return true;
        })) === true
      );
    },
    [courseAction, courseEdit, data, devices, request],
  );

  const deleteReplacedCourse = useCallback(async () => {
    const done = replacement;
    if (!done) return false;
    const deleted = await courseAction(done.oldId, async () => {
      await request(`/api/garmin/courses/${done.oldId}`, undefined, 'DELETE');
      await data.setSetting(`garmin.delivery.${done.oldId}`, '').catch(() => {});
      setDeliveries((current) => {
        const next = new Map(current);
        next.delete(done.oldId);
        return next;
      });
      setCourses((list) => list?.filter((course) => course.id !== done.oldId) ?? null);
      setCourseNotice(
        `Deleted the old “${done.name}” from Garmin Connect. Remove any watch copy there too.`,
      );
      return true;
    });
    if (deleted) setReplacement(null);
    return deleted === true;
  }, [courseAction, data.setSetting, replacement, request]);

  const keepReplacedCourse = useCallback(() => {
    setReplacement(null);
    setCourseNotice('Both versions are in Garmin Connect.');
  }, []);

  return {
    connected,
    mfaRequired,
    busy,
    error,
    lastCourseUrl,
    lastCourseQueued,
    devices,
    lastImport,
    nextActivityOffset,
    historyComplete,
    refresh,
    connect,
    completeMfa,
    disconnect,
    loadDevices,
    uploadCourse,
    clearCourseResult,
    importActivities,
    restartActivityImport,
    checkNewActivities,
    autoImport,
    setAutoImport,
    lastActivityCheck: lastActivityCheck ?? null,
    courses,
    savedCourses,
    coursesOnMap,
    setCourseVisible,
    deliveries,
    pendingCourseId,
    courseNotice,
    courseError,
    loadCourses,
    renameCourse,
    setCourseSport,
    deleteCourse,
    sendCourse,
    saveCourse,
    courseEdit,
    startCourseEdit,
    cancelCourseEdit,
    replaceCourse,
    replacement,
    deleteReplacedCourse,
    keepReplacedCourse,
  };
}
