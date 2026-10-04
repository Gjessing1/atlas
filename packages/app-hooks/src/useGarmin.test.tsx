// @vitest-environment jsdom
import { AtlasStorage, type TrackRecord } from '@atlas/storage';
import { createNodeSqlDriver } from '@atlas/storage/node';
import { act, renderHook, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { useGarmin } from './useGarmin.js';
import type { SyncState } from './useSync.js';
import type { UserData } from './useUserData.js';

const GPX = `<?xml version="1.0"?><gpx><trk><name>Morning run</name><trkseg>
<trkpt lat="59.9" lon="10.7"/><trkpt lat="59.91" lon="10.71"/>
</trkseg></trk></gpx>`;

it('imports GPS activities into sport folders and deduplicates by Garmin id', async () => {
  const storage = new AtlasStorage(createNodeSqlDriver());
  await storage.init();
  const refreshAll = vi.fn(async () => {});
  const accountRequest = vi.fn(async (path: string) => {
    if (path.endsWith('/status')) return { connected: true };
    if (path.includes('/activities?start='))
      return {
        activities: [
          { id: '123', name: 'Morning run', date: '2026-10-01', type: 'running' },
          { id: '124', name: 'Indoor ride', date: '2026-10-02', type: 'cycling', hasRoute: false },
        ],
      };
    if (path.includes('/123/gpx')) return { gpx: GPX };
    if (path.includes('/124/gpx')) throw new Error('Indoor ride has no route');
    throw new Error(`Unexpected ${path}`);
  });
  const sync = { email: 'atlas@example.com', accountRequest } as unknown as SyncState;
  const settings = new Map<string, string>();
  const data = {
    storage,
    refreshAll,
    getSetting: vi.fn(async (key: string) => settings.get(key)),
    setSetting: vi.fn(async (key: string, value: string) => {
      settings.set(key, value);
    }),
  } as unknown as UserData<unknown>;
  const { result } = renderHook(() => useGarmin(sync, data));
  await waitFor(() => expect(result.current.connected).toBe(true));
  await act(async () => {
    await result.current.importActivities();
  });
  expect(result.current.lastImport).toEqual({ imported: 1, skipped: 1, errors: 0, sorted: 0 });
  const [track] = await storage.listTracks();
  expect(track?.tags).toEqual(['garmin:123', 'running']);
  expect(await storage.getTrackGpx(track!.id)).toBe(GPX);
  const folders = await storage.listCollections();
  const root = folders.find((folder) => folder.name === 'Garmin activities')!;
  const running = folders.find((folder) => folder.name === 'Running')!;
  expect(folders).toHaveLength(2);
  expect([root.parentId, running.parentId]).toEqual([null, root.id]);
  expect(track!.collectionId).toBe(running.id);
  await act(async () => {
    await result.current.importActivities();
  });
  expect(result.current.lastImport).toEqual({ imported: 0, skipped: 2, errors: 0, sorted: 0 });
  expect(await storage.listTracks()).toHaveLength(1);
  expect(refreshAll).toHaveBeenCalledTimes(2);
  await storage.close();
});

it('continues activity history in batches and can restart at the newest activity', async () => {
  const storage = new AtlasStorage(createNodeSqlDriver());
  await storage.init();
  const starts: number[] = [];
  const settings = new Map<string, string>();
  const accountRequest = vi.fn(async (path: string) => {
    if (path.endsWith('/status')) return { connected: true };
    if (path.includes('/activities?start=')) {
      const start = Number(new URL(path, 'https://atlas.test').searchParams.get('start'));
      starts.push(start);
      return {
        activities:
          start === 0
            ? Array.from({ length: 30 }, (_, index) => ({
                id: String(index + 1),
                name: 'No GPS',
                hasRoute: false,
              }))
            : [{ id: '31', name: 'Older ride', hasRoute: false }],
      };
    }
    throw new Error(`Unexpected ${path}`);
  });
  const sync = { email: 'history@example.com', accountRequest } as unknown as SyncState;
  const data = {
    storage,
    refreshAll: vi.fn(async () => {}),
    getSetting: vi.fn(async (key: string) => settings.get(key)),
    setSetting: vi.fn(async (key: string, value: string) => {
      settings.set(key, value);
    }),
  } as unknown as UserData<unknown>;
  const { result } = renderHook(() => useGarmin(sync, data));
  await waitFor(() => expect(result.current.connected).toBe(true));
  await act(async () => {
    await result.current.importActivities();
  });
  expect(result.current.nextActivityOffset).toBe(30);
  await act(async () => {
    await result.current.importActivities();
  });
  expect(starts).toEqual([0, 30]);
  expect(result.current.historyComplete).toBe(true);
  await act(async () => {
    await result.current.restartActivityImport();
  });
  expect(result.current.nextActivityOffset).toBe(0);
  await storage.close();
});

function fakeData(storage: AtlasStorage, tracks: { current: TrackRecord[] }) {
  const settings = new Map<string, string>();
  return {
    storage,
    get tracks() {
      return tracks.current;
    },
    refreshAll: vi.fn(async () => {
      tracks.current = await storage.listTracks();
    }),
    getSetting: vi.fn(async (key: string) => settings.get(key)),
    setSetting: vi.fn(async (key: string, value: string) => {
      settings.set(key, value);
    }),
  } as unknown as UserData<unknown>;
}

it('files activities from before sport folders, leaving ones the user moved alone', async () => {
  const storage = new AtlasStorage(createNodeSqlDriver());
  await storage.init();
  const root = await storage.createCollection('Garmin activities');
  const mine = await storage.createCollection('Favourite runs');
  const old = (id: string, type: string, collectionId: string) =>
    storage.createTrack({ name: id, gpx: GPX, collectionId, tags: [`garmin:${id}`, type] });
  const skate = await old('1', 'skating_ws', root.id);
  const trail = await old('2', 'trail_running', root.id);
  const road = await old('3', 'running', root.id);
  const kept = await old('4', 'running', mine.id);
  const accountRequest = vi.fn(async (path: string) => {
    if (path.endsWith('/status')) return { connected: true };
    if (path.includes('/activities?start=')) return { activities: [] };
    throw new Error(`Unexpected ${path}`);
  });
  const sync = { email: 'sort@example.com', accountRequest } as unknown as SyncState;
  const { result } = renderHook(() => useGarmin(sync, fakeData(storage, { current: [] })));
  await waitFor(() => expect(result.current.connected).toBe(true));
  await act(async () => {
    await result.current.importActivities();
  });
  expect(result.current.lastImport).toEqual({ imported: 0, skipped: 0, errors: 0, sorted: 3 });
  const folders = await storage.listCollections();
  const folderOf = async (id: string) => {
    const track = (await storage.listTracks()).find((item) => item.id === id)!;
    const folder = folders.find((item) => item.id === track.collectionId)!;
    return [folder.name, folder.parentId === root.id];
  };
  expect(await folderOf(skate.id)).toEqual(['Skating', true]);
  expect(await folderOf(trail.id)).toEqual(['Running', true]);
  expect(await folderOf(road.id)).toEqual(['Running', true]);
  expect(await folderOf(kept.id)).toEqual(['Favourite runs', false]);
  expect(folders.filter((folder) => folder.name === 'Running')).toHaveLength(1);
  await storage.close();
});

it('manages Garmin courses and saves a copy into the course sport folder', async () => {
  const storage = new AtlasStorage(createNodeSqlDriver());
  await storage.init();
  const calls: [string, unknown, unknown][] = [];
  const accountRequest = vi.fn(async (path: string, body?: unknown, method?: string) => {
    calls.push([path, body, method]);
    if (path.endsWith('/status')) return { connected: true };
    if (path === '/api/garmin/devices') return { devices: [{ id: '456', name: 'Fenix' }] };
    if (path === '/api/garmin/courses')
      return {
        courses: [
          { id: '1', name: 'Old loop', type: 'hiking', distanceM: 5000, ascentM: 100, updated: 1 },
          {
            id: '2',
            name: '18k',
            type: 'trail_running',
            distanceM: 18028,
            ascentM: 536,
            updated: 9,
          },
        ],
      };
    if (path === '/api/garmin/courses/2/gpx') return { gpx: GPX };
    if (path === '/api/garmin/courses/1' && method === 'DELETE') return { deleted: true };
    if (path === '/api/garmin/courses/2' && method === 'PATCH') return { updated: true };
    if (path === '/api/garmin/courses/2/send') return { queued: true };
    throw new Error(`Unexpected ${path}`);
  });
  const sync = { email: 'courses@example.com', accountRequest } as unknown as SyncState;
  const tracks = { current: [] as TrackRecord[] };
  const data = fakeData(storage, tracks);
  const { result, rerender } = renderHook(() => useGarmin(sync, data));
  await waitFor(() => expect(result.current.connected).toBe(true));
  await act(async () => {
    await result.current.loadCourses();
    await result.current.loadDevices();
  });
  expect(result.current.courses?.map((course) => course.id)).toEqual(['2', '1']);

  let trackId: string | null = null;
  await act(async () => {
    trackId = await result.current.saveCourse('2');
  });
  rerender();
  const [saved] = await storage.listTracks();
  expect(saved).toMatchObject({
    id: trackId,
    name: '18k',
    tags: ['garmin-course:2', 'trail_running'],
  });
  const folders = await storage.listCollections();
  const folder = folders.find((item) => item.id === saved!.collectionId)!;
  expect([folder.name, folders.find((item) => item.id === folder.parentId)?.name]).toEqual([
    'Running',
    'Garmin courses',
  ]);
  expect(result.current.savedCourses.get('2')).toBe(trackId);
  await act(async () => {
    expect(await result.current.saveCourse('2')).toBe(trackId);
  });
  expect(await storage.listTracks()).toHaveLength(1);

  await act(async () => {
    expect(await result.current.renameCourse('2', ' Ridge 18k ')).toBe(true);
    expect(await result.current.setCourseSport('2', 'hiking')).toBe(true);
    expect(await result.current.sendCourse('2', '456')).toBe(true);
  });
  expect(result.current.courses?.find((course) => course.id === '2')).toMatchObject({
    name: 'Ridge 18k',
    type: 'hiking',
  });
  expect(result.current.courseNotice).toBe(
    'Queued for Fenix. It arrives on the next sync with Garmin Connect.',
  );
  expect(result.current.deliveries.get('2')).toMatchObject({ deviceName: 'Fenix' });
  expect(await data.getSetting('garmin.delivery.2')).toContain('Fenix');
  await act(async () => {
    await result.current.loadCourses();
  });
  expect(result.current.deliveries.get('2')).toMatchObject({ deviceName: 'Fenix' });
  expect(calls).toContainEqual(['/api/garmin/courses/2', { name: 'Ridge 18k' }, 'PATCH']);
  expect(calls).toContainEqual(['/api/garmin/courses/2/send', { deviceId: '456' }, undefined]);

  await act(async () => {
    expect(await result.current.deleteCourse('1')).toBe(true);
  });
  expect(result.current.courses?.map((course) => course.id)).toEqual(['2']);
  expect(result.current.courseNotice).toBe('Deleted “Old loop” from Garmin Connect.');
  // Deleting on Garmin never touches the Atlas copy.
  expect(await storage.listTracks()).toHaveLength(1);

  accountRequest.mockRejectedValueOnce(
    new Error('Garmin is still processing this course; try again in a minute'),
  );
  await act(async () => {
    expect(await result.current.deleteCourse('2')).toBe(false);
  });
  expect(result.current.courseError).toBe(
    'Garmin is still processing this course; try again in a minute',
  );
  expect(result.current.courses?.map((course) => course.id)).toEqual(['2']);
  expect(result.current.pendingCourseId).toBeNull();
  await storage.close();
});
