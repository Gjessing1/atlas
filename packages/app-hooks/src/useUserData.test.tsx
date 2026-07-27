// @vitest-environment jsdom
import { AtlasStorage, StorageUnavailableError } from '@atlas/storage';
import { createNodeSqlDriver as createNodeDriver } from '@atlas/storage/node';
import { parseKmz } from '@atlas/gpx';
import { act, renderHook, waitFor } from '@testing-library/react';
import { unzipSync } from 'fflate';
import { describe, expect, it, vi } from 'vitest';
import type { UserDataPlatform } from './useUserData.js';
import { useUserData } from './useUserData.js';

/** Test file type: name + bytes, handed straight through by readFile. */
interface MemFile {
  name: string;
  bytes: Uint8Array;
}

interface Saved {
  name: string;
  body: string;
  mime: string;
}

function createPlatform(opts?: { zip?: boolean; storage?: AtlasStorage }) {
  const storage = opts?.storage ?? new AtlasStorage(createNodeDriver());
  const savedText: Saved[] = [];
  const savedZips: { name: string; bytes: Uint8Array }[] = [];
  const platform: UserDataPlatform<MemFile> = {
    openStorage: async () => {
      await storage.init();
      return storage;
    },
    readFile: (file) => Promise.resolve(file),
    saveTextFile: (name, body, mime) => {
      savedText.push({ name, body, mime });
      return Promise.resolve();
    },
    ...(opts?.zip
      ? {
          saveZipFile: (name: string, bytes: Uint8Array) => {
            savedZips.push({ name, bytes });
            return Promise.resolve();
          },
        }
      : {}),
  };
  return { storage, platform, savedText, savedZips };
}

const gpxFile = (name: string): MemFile => ({
  name,
  bytes: new TextEncoder().encode(
    `<?xml version="1.0"?><gpx><trk><name>Morning ride</name><trkseg>
       <trkpt lat="59.9" lon="10.7"><ele>100</ele></trkpt>
       <trkpt lat="59.91" lon="10.71"><ele>110</ele></trkpt>
     </trkseg></trk></gpx>`,
  ),
});

const waypointsFile: MemFile = {
  name: 'favs.gpx',
  bytes: new TextEncoder().encode(
    '<gpx><wpt lat="59.9" lon="10.7"><name>Cabin</name></wpt><wpt lat="60" lon="11"/></gpx>',
  ),
};

describe('useUserData', () => {
  it('opens storage, loads lists, and reports readiness', async () => {
    const { storage, platform } = createPlatform();
    await storage.init();
    await storage.createPlace({ name: 'Existing', lat: 59, lng: 10 });
    const { result } = renderHook(() => useUserData(platform));
    expect(result.current.status).toBe('loading');
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.places.map((p) => p.name)).toEqual(['Existing']);
    expect(result.current.storage).not.toBeNull();
  });

  it('reports an error state when storage cannot open', async () => {
    const platform: UserDataPlatform<MemFile> = {
      openStorage: () => Promise.reject(new Error('OPFS unavailable')),
      readFile: (f) => Promise.resolve(f),
      saveTextFile: () => Promise.resolve(),
    };
    const { result } = renderHook(() => useUserData(platform));
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error).toBe('OPFS unavailable');
    // An unclassified throw is a real failure, not a busy database.
    expect(result.current.errorReason).toBe('failed');
  });

  describe('recovering from an unavailable storage', () => {
    /** A platform whose first N opens fail, then hands over a working storage. */
    function flakyPlatform(failures: number, err: () => unknown) {
      const { storage } = createPlatform();
      let opens = 0;
      const platform: UserDataPlatform<MemFile> = {
        openStorage: async () => {
          opens += 1;
          if (opens <= failures) throw err();
          await storage.init();
          return storage;
        },
        readFile: (file) => Promise.resolve(file),
        saveTextFile: () => Promise.resolve(),
      };
      return { platform, storage, opens: () => opens };
    }

    it('retry() opens again after a failure', async () => {
      const { platform, opens } = flakyPlatform(1, () => new Error('disk on fire'));
      const { result } = renderHook(() => useUserData(platform));
      await waitFor(() => expect(result.current.status).toBe('error'));

      act(() => result.current.retry());
      await waitFor(() => expect(result.current.status).toBe('ready'));
      expect(opens()).toBe(2);
      // The failure is not left behind on the state that recovered from it.
      expect(result.current.error).toBeNull();
      expect(result.current.errorReason).toBeNull();
    });

    it('retry() on a working storage does nothing (never closes what works)', async () => {
      const { platform, opens } = flakyPlatform(0, () => new Error('unused'));
      const { result } = renderHook(() => useUserData(platform));
      await waitFor(() => expect(result.current.status).toBe('ready'));

      act(() => result.current.retry());
      await waitFor(() => expect(opens()).toBe(1));
      expect(result.current.status).toBe('ready');
    });

    it('waits out a busy storage and takes over when it is released', async () => {
      const { platform: base, storage } = flakyPlatform(1, () => {
        throw new Error('unreachable');
      });
      let release!: () => void;
      const released = new Promise<void>((r) => (release = r));
      let opens = 0;
      const platform: UserDataPlatform<MemFile> = {
        ...base,
        openStorage: async () => {
          opens += 1;
          // Held by another page until `release` — the second tab case.
          if (opens === 1) throw new StorageUnavailableError('busy');
          await storage.init();
          return storage;
        },
        awaitAvailability: () => released,
      };

      const { result } = renderHook(() => useUserData(platform));
      await waitFor(() => expect(result.current.status).toBe('error'));
      expect(result.current.errorReason).toBe('busy');

      // Nobody pressed anything: the other page let go, and this one takes over.
      await act(async () => {
        release();
        await released;
      });
      await waitFor(() => expect(result.current.status).toBe('ready'));
    });

    it('stops waiting for a busy storage once unmounted', async () => {
      const aborted = vi.fn();
      const platform: UserDataPlatform<MemFile> = {
        openStorage: () => Promise.reject(new StorageUnavailableError('busy')),
        awaitAvailability: (signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => {
              aborted();
              reject(new Error('aborted'));
            });
          }),
        readFile: (file) => Promise.resolve(file),
        saveTextFile: () => Promise.resolve(),
      };

      const { result, unmount } = renderHook(() => useUserData(platform));
      await waitFor(() => expect(result.current.status).toBe('error'));
      unmount();
      expect(aborted).toHaveBeenCalledTimes(1);
    });
  });

  it('writes through mutations and surfaces failed writes', async () => {
    const { storage, platform } = createPlatform();
    const { result } = renderHook(() => useUserData(platform));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    let created: unknown;
    await act(async () => {
      created = await result.current.savePlace({ name: 'Home', lat: 59.9, lng: 10.7 });
    });
    expect(created).not.toBeNull();
    expect(result.current.places).toHaveLength(1);

    await act(async () => {
      await result.current.updatePlace(result.current.places[0]!.id, { name: 'Hjem' });
    });
    expect(result.current.places[0]!.name).toBe('Hjem');

    vi.spyOn(storage, 'deletePlace').mockRejectedValueOnce(new Error('disk full'));
    await act(async () => {
      await result.current.deletePlace(result.current.places[0]!.id);
    });
    expect(result.current.writeError).toBe('Deleting place failed — disk full');
    expect(result.current.places).toHaveLength(1); // nothing was deleted
    act(() => result.current.clearWriteError());
    expect(result.current.writeError).toBeNull();
  });

  it('offers an undo for each delete and restores the record on demand', async () => {
    const { platform } = createPlatform();
    const { result } = renderHook(() => useUserData(platform));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    await act(async () => {
      await result.current.createCollection('Hikes');
    });
    const folderId = result.current.collections[0]!.id;
    await act(async () => {
      await result.current.savePlace({
        name: 'Preikestolen',
        lat: 58.9,
        lng: 6.1,
        collectionId: folderId,
      });
    });
    const placeId = result.current.places[0]!.id;

    await act(async () => {
      await result.current.deletePlace(placeId);
    });
    expect(result.current.places).toHaveLength(0);
    expect(result.current.undoable?.message).toBe('Deleted "Preikestolen"');

    await act(async () => {
      await result.current.undoable!.undo();
    });
    expect(result.current.places).toMatchObject([{ id: placeId, name: 'Preikestolen' }]);
    expect(result.current.undoable).toBeNull();

    // Undoing a folder delete also pulls its contents back out of the root.
    await act(async () => {
      await result.current.deleteCollection(folderId);
    });
    expect(result.current.collections).toHaveLength(0);
    expect(result.current.places[0]!.collectionId).toBeNull();
    expect(result.current.undoable?.message).toBe('Deleted "Hikes"');

    await act(async () => {
      await result.current.undoable!.undo();
    });
    expect(result.current.collections).toMatchObject([{ id: folderId, name: 'Hikes' }]);
    expect(result.current.places[0]!.collectionId).toBe(folderId);
  });

  it('moves a nested collection back up the tree', async () => {
    const { platform } = createPlatform();
    const { result } = renderHook(() => useUserData(platform));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    await act(async () => {
      await result.current.createCollection('Parent');
    });
    const parentId = result.current.collections[0]!.id;
    await act(async () => {
      await result.current.createCollection('Child', parentId);
    });
    const childId = result.current.collections.find((c) => c.name === 'Child')!.id;

    await act(async () => {
      await result.current.moveCollection(childId, null);
    });
    expect(result.current.collections.find((c) => c.id === childId)!.parentId).toBeNull();
  });

  it('clears a pending undo when dismissed', async () => {
    const { platform } = createPlatform();
    const { result } = renderHook(() => useUserData(platform));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    await act(async () => {
      await result.current.savePlace({ name: 'Home', lat: 59.9, lng: 10.7 });
    });
    await act(async () => {
      await result.current.deletePlace(result.current.places[0]!.id);
    });
    expect(result.current.undoable).not.toBeNull();

    act(() => result.current.clearUndoable());
    expect(result.current.undoable).toBeNull();
    expect(result.current.places).toHaveLength(0);
  });

  it('imports tracks and waypoint-only files, collecting per-file errors', async () => {
    const { platform } = createPlatform();
    const { result } = renderHook(() => useUserData(platform));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    let outcome!: Awaited<ReturnType<typeof result.current.importFiles>>;
    await act(async () => {
      outcome = await result.current.importFiles([
        gpxFile('ride.gpx'),
        waypointsFile,
        { name: 'broken.gpx', bytes: new TextEncoder().encode('not xml at all') },
      ]);
    });
    expect(outcome.tracks.map((t) => t.name)).toEqual(['Morning ride']);
    expect(outcome.places).toHaveLength(2);
    expect(outcome.errors).toHaveLength(1);
    expect(outcome.errors[0]).toContain('broken.gpx');
    expect(result.current.tracks).toHaveLength(1);
    expect(result.current.places).toHaveLength(2);

    // Imported geometry is parseable back out of storage (and cached).
    const data = await result.current.getTrackData(outcome.tracks[0]!.id);
    expect(data?.segments[0]).toHaveLength(2);
  });

  it('files imported tracks and waypoints into a newly requested collection', async () => {
    const { platform } = createPlatform();
    const { result } = renderHook(() => useUserData(platform));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    await act(async () => {
      await result.current.importFiles([gpxFile('ride.gpx'), waypointsFile], {
        newCollection: { name: 'Norway trip' },
      });
    });

    const folder = result.current.collections.find((item) => item.name === 'Norway trip');
    expect(folder).toBeDefined();
    expect(result.current.tracks[0]!.collectionId).toBe(folder!.id);
    expect(result.current.places.every((place) => place.collectionId === folder!.id)).toBe(true);
  });

  it('exports a single track as gpx or kml via the platform seam', async () => {
    const { platform, savedText } = createPlatform();
    const { result } = renderHook(() => useUserData(platform));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    let imported!: Awaited<ReturnType<typeof result.current.importFiles>>;
    await act(async () => {
      imported = await result.current.importFiles([gpxFile('Tur til hytta!.gpx')]);
    });

    await act(async () => {
      await result.current.exportTrack(imported.tracks[0]!.id, 'gpx');
      await result.current.exportTrack(imported.tracks[0]!.id, 'kml');
    });
    expect(savedText[0]!.name).toBe('Morning_ride.gpx');
    expect(savedText[0]!.mime).toBe('application/gpx+xml');
    expect(savedText[0]!.body).toContain('<trkpt'); // original GPX preserved
    expect(savedText[1]!.name).toBe('Morning_ride.kml');
    expect(savedText[1]!.body).toContain('<kml');
  });

  it('exportAll ships a zip when the platform can save one, else the JSON dump', async () => {
    const zipped = createPlatform({ zip: true });
    const hook1 = renderHook(() => useUserData(zipped.platform));
    await waitFor(() => expect(hook1.result.current.status).toBe('ready'));
    await act(async () => {
      await hook1.result.current.savePlace({ name: 'Home', lat: 59.9, lng: 10.7 });
      await hook1.result.current.importFiles([gpxFile('ride.gpx')]);
      await hook1.result.current.exportAll();
    });
    expect(zipped.savedZips).toHaveLength(1);
    const entries = unzipSync(zipped.savedZips[0]!.bytes);
    expect(Object.keys(entries).sort()).toEqual([
      'atlas-export.json',
      'atlas-export.kmz',
      'places.gpx',
      'tracks/Morning_ride.gpx',
    ]);

    const plain = createPlatform();
    const hook2 = renderHook(() => useUserData(plain.platform));
    await waitFor(() => expect(hook2.result.current.status).toBe('ready'));
    await act(async () => {
      await hook2.result.current.exportAll();
    });
    expect(plain.savedText[0]!.mime).toBe('application/json');
    expect(JSON.parse(plain.savedText[0]!.body)).toHaveProperty('places');
  });

  it('exports an interop KMZ that mirrors the folder structure', async () => {
    const zipped = createPlatform({ zip: true });
    const { result } = renderHook(() => useUserData(zipped.platform));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    await act(async () => {
      await result.current.savePlace({ name: 'Loose pin', lat: 59.9, lng: 10.7 });
      await result.current.createCollection('Trips');
    });
    const folder = result.current.collections[0]!;
    await act(async () => {
      await result.current.savePlace({
        name: 'Filed pin',
        lat: 60.1,
        lng: 11.2,
        collectionId: folder.id,
      });
      await result.current.importFiles([gpxFile('ride.gpx')], { collectionId: folder.id });
      await result.current.exportAll();
    });

    const kmz = unzipSync(zipped.savedZips[0]!.bytes)['atlas-export.kmz']!;
    const kml = new TextDecoder().decode(unzipSync(kmz)['doc.kml']!);
    expect(kml).toContain('<name>Trips</name>');
    // The filed records sit inside the folder, the loose pin above it.
    expect(kml.indexOf('Loose pin')).toBeLessThan(kml.indexOf('<Folder>'));
    expect(kml.indexOf('Filed pin')).toBeGreaterThan(kml.indexOf('<Folder>'));
    expect(kml.indexOf('Morning ride')).toBeGreaterThan(kml.indexOf('<Folder>'));

    // And it is a real KMZ: another platform can read it back.
    const data = parseKmz(kmz);
    expect(data.waypoints.map((w) => w.name).sort()).toEqual(['Filed pin', 'Loose pin']);
    expect(data.segments).toHaveLength(1);
  });

  /**
   * Rule 5 (no feature traps user data) end-to-end: whatever exportAll writes
   * must be readable back onto a device with no account and no server.
   */
  describe('full-backup restore', () => {
    it('carries places, tracks and folders from an export zip onto a fresh device', async () => {
      const source = createPlatform({ zip: true });
      const hook1 = renderHook(() => useUserData(source.platform));
      await waitFor(() => expect(hook1.result.current.status).toBe('ready'));
      await act(async () => {
        await hook1.result.current.savePlace({ name: 'Home', lat: 59.9, lng: 10.7 });
        await hook1.result.current.createCollection('Trips');
        await hook1.result.current.importFiles([gpxFile('ride.gpx')]);
        await hook1.result.current.exportAll();
      });
      const backup: MemFile = {
        name: 'atlas-export-2026-07-20.zip',
        bytes: source.savedZips[0]!.bytes,
      };

      // A brand-new device: separate storage, no account, no sync.
      const fresh = createPlatform();
      const hook2 = renderHook(() => useUserData(fresh.platform));
      await waitFor(() => expect(hook2.result.current.status).toBe('ready'));
      let outcome!: Awaited<ReturnType<typeof hook2.result.current.importFiles>>;
      await act(async () => {
        outcome = await hook2.result.current.importFiles([backup]);
      });

      expect(outcome.errors).toEqual([]);
      expect(outcome.restored).toMatchObject({
        places: { imported: 1 },
        tracks: { imported: 1 },
        collections: { imported: 1 },
      });
      // The restored records are live in the UI state, under their original ids.
      expect(hook2.result.current.places.map((p) => p.name)).toEqual(['Home']);
      expect(hook2.result.current.tracks.map((t) => t.name)).toEqual(['Morning ride']);
      expect(hook2.result.current.collections.map((c) => c.name)).toEqual(['Trips']);
      expect(hook2.result.current.places[0]!.id).toBe(hook1.result.current.places[0]!.id);
      // Track geometry survives, not just the row.
      const data = await hook2.result.current.getTrackData(hook2.result.current.tracks[0]!.id);
      expect(data?.segments[0]).toHaveLength(2);
    });

    it('reads the bare JSON dump too, and re-importing changes nothing', async () => {
      const source = createPlatform();
      const hook1 = renderHook(() => useUserData(source.platform));
      await waitFor(() => expect(hook1.result.current.status).toBe('ready'));
      await act(async () => {
        await hook1.result.current.savePlace({ name: 'Cabin', lat: 61, lng: 9 });
        await hook1.result.current.exportAll();
      });
      const backup: MemFile = {
        name: source.savedText[0]!.name,
        bytes: new TextEncoder().encode(source.savedText[0]!.body),
      };

      const fresh = createPlatform();
      const hook2 = renderHook(() => useUserData(fresh.platform));
      await waitFor(() => expect(hook2.result.current.status).toBe('ready'));
      await act(async () => {
        await hook2.result.current.importFiles([backup]);
      });
      expect(hook2.result.current.places).toHaveLength(1);

      let again!: Awaited<ReturnType<typeof hook2.result.current.importFiles>>;
      await act(async () => {
        again = await hook2.result.current.importFiles([backup]);
      });
      expect(again.restored?.places).toEqual({ imported: 0, skipped: 1 });
      expect(hook2.result.current.places).toHaveLength(1);
    });

    it('reports a non-backup json/zip as an error instead of throwing', async () => {
      const { platform } = createPlatform();
      const { result } = renderHook(() => useUserData(platform));
      await waitFor(() => expect(result.current.status).toBe('ready'));
      let outcome!: Awaited<ReturnType<typeof result.current.importFiles>>;
      await act(async () => {
        outcome = await result.current.importFiles([
          { name: 'geo.json', bytes: new TextEncoder().encode('{"type":"FeatureCollection"}') },
          { name: 'broken.json', bytes: new TextEncoder().encode('not json at all') },
          { name: 'photos.zip', bytes: new TextEncoder().encode('PK not really a zip') },
        ]);
      });
      expect(outcome.restored).toBeNull();
      expect(outcome.errors).toHaveLength(3);
      expect(outcome.errors[0]).toContain('not an Atlas backup');
      expect(result.current.places).toEqual([]);
    });
  });

  it('setAllVisible flips only records that differ', async () => {
    const { storage, platform } = createPlatform();
    const { result } = renderHook(() => useUserData(platform));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    await act(async () => {
      await result.current.savePlace({ name: 'A', lat: 1, lng: 1 });
      await result.current.savePlace({ name: 'B', lat: 2, lng: 2 });
      await result.current.createCollection('Folder');
    });
    const bId = result.current.places.find((p) => p.name === 'B')!.id;
    await act(async () => {
      await result.current.updatePlace(bId, { visible: false });
    });

    const spy = vi.spyOn(storage, 'updatePlace');
    await act(async () => {
      await result.current.setAllVisible(false);
    });
    // Only A differed — B was already hidden (folders go via setCollectionVisible).
    expect(spy).toHaveBeenCalledTimes(1);
    expect(result.current.places.every((p) => !p.visible)).toBe(true);
    expect(result.current.collections.every((c) => !c.visible)).toBe(true);
  });

  describe('storage lifecycle', () => {
    it('closes the storage on unmount', async () => {
      const { storage, platform } = createPlatform();
      const close = vi.spyOn(storage, 'close');
      const { result, unmount } = renderHook(() => useUserData(platform));
      await waitFor(() => expect(result.current.status).toBe('ready'));
      expect(close).not.toHaveBeenCalled();

      unmount();
      await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    });

    it('closes an open that resolves only after unmount (no leaked instance)', async () => {
      const { storage } = createPlatform();
      const close = vi.spyOn(storage, 'close');
      let release!: (s: typeof storage) => void;
      const gate = new Promise<typeof storage>((r) => (release = r));
      const platform: UserDataPlatform<MemFile> = {
        openStorage: () => gate,
        readFile: (file) => Promise.resolve(file),
        saveTextFile: () => Promise.resolve(),
      };

      const { result, unmount } = renderHook(() => useUserData(platform));
      unmount();
      await storage.init();
      release(storage);
      await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
      // The unmounted hook never surfaced the late storage.
      expect(result.current.status).toBe('loading');
    });

    it('a remount waits for the previous instance to close before opening', async () => {
      const order: string[] = [];
      const { storage } = createPlatform();
      await storage.init();
      const platform: UserDataPlatform<MemFile> = {
        openStorage: () => {
          order.push('open');
          return Promise.resolve(storage);
        },
        readFile: (file) => Promise.resolve(file),
        saveTextFile: () => Promise.resolve(),
      };
      vi.spyOn(storage, 'close').mockImplementation(async () => {
        order.push('close');
      });

      const first = renderHook(() => useUserData(platform));
      await waitFor(() => expect(first.result.current.status).toBe('ready'));
      first.unmount();
      const second = renderHook(() => useUserData(platform));
      await waitFor(() => expect(second.result.current.status).toBe('ready'));
      expect(order).toEqual(['open', 'close', 'open']);
      second.unmount();
    });
  });
});
