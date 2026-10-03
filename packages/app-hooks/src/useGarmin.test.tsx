// @vitest-environment jsdom
import { AtlasStorage } from '@atlas/storage';
import { createNodeSqlDriver } from '@atlas/storage/node';
import { act, renderHook, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { useGarmin } from './useGarmin.js';
import type { SyncState } from './useSync.js';
import type { UserData } from './useUserData.js';

const GPX = `<?xml version="1.0"?><gpx><trk><name>Morning run</name><trkseg>
<trkpt lat="59.9" lon="10.7"/><trkpt lat="59.91" lon="10.71"/>
</trkseg></trk></gpx>`;

it('imports GPS activities into one folder and deduplicates by Garmin id', async () => {
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
  expect(result.current.lastImport).toEqual({ imported: 1, skipped: 1, errors: 0 });
  const [track] = await storage.listTracks();
  expect(track?.tags).toEqual(['garmin:123', 'running']);
  expect(await storage.getTrackGpx(track!.id)).toBe(GPX);
  expect((await storage.listCollections()).map((folder) => folder.name)).toEqual([
    'Garmin activities',
  ]);
  await act(async () => {
    await result.current.importActivities();
  });
  expect(result.current.lastImport).toEqual({ imported: 0, skipped: 2, errors: 0 });
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
