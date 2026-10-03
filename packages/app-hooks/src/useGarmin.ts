import { buildGpx, computeTrackStats, parseGpx } from '@atlas/gpx';
import { routePathToTrackData, type RoutePath, type RoutingProfile } from '@atlas/routing';
import { useCallback, useEffect, useState } from 'react';
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

export interface GarminState {
  connected: boolean | null;
  mfaRequired: boolean;
  busy: boolean;
  error: string | null;
  lastCourseUrl: string | null;
  lastCourseQueued: boolean | null;
  devices: GarminDevice[];
  lastImport: { imported: number; skipped: number; errors: number } | null;
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
  importActivities: () => Promise<void>;
  restartActivityImport: () => Promise<void>;
}

const activityOffsetKey = (email: string) => `local.garmin.activityOffset.${email}`;

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
  const request = sync.accountRequest;

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
    if (sync.email) void refresh();
    else {
      setConnected(null);
      setMfaRequired(false);
    }
  }, [sync.email, refresh]);

  useEffect(() => {
    if (!sync.email) return;
    let active = true;
    void data.getSetting(activityOffsetKey(sync.email)).then((value) => {
      const parsed = Number(value);
      if (active && Number.isInteger(parsed) && parsed >= 0 && parsed <= 100_000) {
        setNextActivityOffset(parsed);
      }
    });
    return () => {
      active = false;
    };
  }, [sync.email, data.getSetting]);

  const resetActivityOffset = useCallback(async () => {
    if (sync.email) await data.setSetting(activityOffsetKey(sync.email), '0');
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
        const response = await request<{ url: string; queued: boolean }>('/api/garmin/course', {
          name,
          profile,
          gpx,
          ...(deviceId ? { deviceId } : {}),
        });
        setLastCourseUrl(response.url);
        setLastCourseQueued(response.queued);
      }),
    [request, run],
  );

  const clearCourseResult = useCallback(() => {
    setLastCourseUrl(null);
    setLastCourseQueued(null);
    setError(null);
  }, []);

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
        const response = await request<{ activities: GarminActivity[] }>(
          `/api/garmin/activities?start=${start}`,
        );
        const existing = await storage.listTracks();
        const tags = new Set(existing.flatMap((track) => track.tags));
        let collection = (await storage.listCollections()).find(
          (item) => item.name === 'Garmin activities',
        );
        let imported = 0;
        let skipped = 0;
        let errors = 0;
        for (const activity of response.activities) {
          const tag = `garmin:${activity.id}`;
          if (tags.has(tag)) {
            skipped++;
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
            if (!collection) collection = await storage.createCollection('Garmin activities');
            const name = activity.name.trim() || track.name || 'Garmin activity';
            await storage.createTrack({
              name,
              gpx,
              stats: computeTrackStats(track) as unknown as Record<string, number>,
              collectionId: collection.id,
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
        await data.refreshAll();
        const next = response.activities.length === 30 ? start + 30 : 0;
        await data.setSetting(key, String(next));
        setNextActivityOffset(next);
        setHistoryComplete(next === 0);
        setLastImport({ imported, skipped, errors });
      }),
    [data, request, run, sync.email],
  );

  const restartActivityImport = useCallback(async () => {
    await resetActivityOffset();
    setLastImport(null);
  }, [resetActivityOffset]);

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
  };
}
