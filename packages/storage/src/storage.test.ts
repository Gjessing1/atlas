import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SqlDriver, SqlStatement } from './driver.js';
import { migrate } from './migrations.js';
import { createNodeSqlDriver as createNodeDriver } from './node-driver.js';
import { AtlasStorage } from './storage.js';

const PERMIT_AREA = {
  kind: 'area' as const,
  source: 'inatur' as const,
  sourceId: '0123456789abcdef01234567',
  polygons: [
    [
      [
        [10, 60],
        [11, 60],
        [11, 61],
        [10, 60],
      ],
      [
        [10.2, 60.2],
        [10.3, 60.2],
        [10.2, 60.2],
      ],
    ],
  ] as [number, number][][][],
  bbox: [10, 60, 11, 61] as [number, number, number, number],
};

/** A stand as the Fish & Hunt shortlist saves it (@atlas/core PlaceStand). */
const ROE_STAND = {
  kind: 'stand' as const,
  source: 'atlas-potential' as const,
  target: 'Rådyrbukk · lokkejakt',
  aim: { label: 'SE', bearing: 135, distanceM: 48, position: { lat: 59.851, lng: 10.421 } },
  vantageM: 6,
  maxRangeM: 150,
  lanes: [{ key: 'e', label: 'E', bearing: 90, rangeM: 120 }],
  approach: {
    risk: 'caution' as const,
    basis: 'mapped-route' as const,
    holdingCoverM: 64,
    walkMinutes: 12,
    approximate: false,
  },
  bandLabel: 'Prime ground',
  warning: 'Terrain visibility is not a backstop check.',
  savedAt: 1_757_656_800_000,
};

/**
 * Delegate driver that rewrites the first batch statement matching `match`
 * into invalid SQL, so the failure happens *inside* the transaction — the
 * statements before it execute and must be rolled back.
 */
function sabotageBatch(driver: SqlDriver, match: RegExp): SqlDriver {
  let armed = true;
  return {
    ...driver,
    batch: (statements: SqlStatement[]) =>
      driver.batch(
        statements.map((s) => {
          if (!armed || !match.test(s.sql)) return s;
          armed = false;
          return { sql: 'INSERT INTO no_such_table DEFAULT VALUES' };
        }),
      ),
  };
}

describe('AtlasStorage', () => {
  let storage: AtlasStorage;

  beforeEach(async () => {
    storage = new AtlasStorage(createNodeDriver());
    await storage.init();
  });

  it('init is idempotent (migrations only run once)', async () => {
    await storage.init();
    expect(await storage.listPlaces()).toEqual([]);
  });

  describe('a place saved as a hunting stand', () => {
    it('keeps the plan on the record, not only as prose in the notes', async () => {
      await storage.createPlace({ name: 'Stand 1', lat: 59.85, lng: 10.42, stand: ROE_STAND });
      expect((await storage.listPlaces())[0]!.stand).toEqual(ROE_STAND);
    });

    it('leaves an ordinary pin without one', async () => {
      await storage.createPlace({ name: 'Home', lat: 59.9, lng: 10.7 });
      expect((await storage.listPlaces())[0]!.stand).toBeNull();
    });

    it('survives a rename — editing the pin must not drop the plan', async () => {
      const place = await storage.createPlace({
        name: 'Stand 1',
        lat: 59.85,
        lng: 10.42,
        stand: ROE_STAND,
      });
      await storage.updatePlace(place.id, { name: 'Bjørkekanten' });
      expect((await storage.listPlaces())[0]!.stand).toEqual(ROE_STAND);
    });

    it("pushes the plan to the user's other devices", async () => {
      const place = await storage.createPlace({
        name: 'Stand 1',
        lat: 59.85,
        lng: 10.42,
        stand: ROE_STAND,
      });
      const payload = await storage.readSyncRecord('place', place.id);
      expect(payload!.data['stand']).toEqual(ROE_STAND);
    });

    it('applies a stand arriving from another device', async () => {
      await storage.applyRemoteChange({
        entity: 'place',
        id: 'remote-1',
        updatedAt: Date.now(),
        deleted: false,
        data: { name: 'Their stand', lat: 59.85, lng: 10.42, stand: ROE_STAND, createdAt: 1 },
      });
      expect((await storage.listPlaces())[0]!.stand).toEqual(ROE_STAND);
    });

    // A rose the surface never produced is worse than no rose: the block exists
    // to be trusted about which way to face.
    it('stores nothing rather than half a plan from a malformed payload', async () => {
      await storage.applyRemoteChange({
        entity: 'place',
        id: 'remote-2',
        updatedAt: Date.now(),
        deleted: false,
        data: {
          name: 'Bad stand',
          lat: 59.85,
          lng: 10.42,
          stand: { ...ROE_STAND, lanes: 'E 120 m' },
          createdAt: 1,
        },
      });
      expect((await storage.listPlaces())[0]!.stand).toBeNull();
    });

    // A phone still on the previous bundle pushes whole places with no `stand`
    // key at all. Renaming a pin there must not erase the rose here.
    it('keeps the local plan when an older peer says nothing about stands', async () => {
      const place = await storage.createPlace({
        name: 'Stand 1',
        lat: 59.85,
        lng: 10.42,
        stand: ROE_STAND,
      });
      await storage.applyRemoteChange({
        entity: 'place',
        id: place.id,
        updatedAt: place.updatedAt + 1000,
        deleted: false,
        data: { name: 'Renamed on the old phone', lat: 59.85, lng: 10.42, createdAt: 1 },
      });
      const stored = (await storage.listPlaces())[0]!;
      expect(stored.name).toBe('Renamed on the old phone');
      expect(stored.stand).toEqual(ROE_STAND);
    });

    // …while a client that *does* know about stands can still clear one.
    it('clears the plan when a peer explicitly sends none', async () => {
      const place = await storage.createPlace({
        name: 'Stand 1',
        lat: 59.85,
        lng: 10.42,
        stand: ROE_STAND,
      });
      await storage.applyRemoteChange({
        entity: 'place',
        id: place.id,
        updatedAt: place.updatedAt + 1000,
        deleted: false,
        data: { name: 'Now just a pin', lat: 59.85, lng: 10.42, stand: null, createdAt: 1 },
      });
      expect((await storage.listPlaces())[0]!.stand).toBeNull();
    });
  });

  it('creates, lists, updates and deletes places', async () => {
    const place = await storage.createPlace({
      name: 'Preikestolen',
      lat: 58.9864,
      lng: 6.1904,
      address: 'Preikestolvegen 521, Jørpeland',
    });
    expect(place.id).toMatch(/[0-9a-f-]{36}/);
    expect(place.tags).toEqual([]);
    // New places get the default icon/colour.
    expect(place).toMatchObject({ icon: '📍', color: '#e11d48' });

    await storage.updatePlace(place.id, {
      notes: 'Steep!',
      address: 'Preikestolvegen 519, Jørpeland',
      tags: ['hike', 'view'],
      icon: '🏔️',
      color: '#16a34a',
    });
    const [listed] = await storage.listPlaces();
    expect(listed).toMatchObject({
      name: 'Preikestolen',
      lat: 58.9864,
      address: 'Preikestolvegen 519, Jørpeland',
      notes: 'Steep!',
      tags: ['hike', 'view'],
      icon: '🏔️',
      color: '#16a34a',
    });
    expect(listed!.updatedAt).toBeGreaterThanOrEqual(place.updatedAt);

    await storage.deletePlace(place.id);
    expect(await storage.listPlaces()).toEqual([]);
  });

  it('defaults places and folders to visible and toggles them', async () => {
    const folder = await storage.createCollection('F');
    const place = await storage.createPlace({ name: 'P', lat: 1, lng: 2 });
    expect(place.visible).toBe(true);
    expect(folder.visible).toBe(true);

    await storage.updatePlace(place.id, { visible: false });
    expect((await storage.listPlaces())[0]!.visible).toBe(false);

    await storage.setCollectionVisible(folder.id, false);
    expect((await storage.listCollections())[0]!.visible).toBe(false);
    await storage.setCollectionVisible(folder.id, true);
    expect((await storage.listCollections())[0]!.visible).toBe(true);
  });

  it('reorders places and folders via sequential sort indexes', async () => {
    const a = await storage.createPlace({ name: 'A', lat: 1, lng: 1 });
    const b = await storage.createPlace({ name: 'B', lat: 2, lng: 2 });
    const c = await storage.createPlace({ name: 'C', lat: 3, lng: 3 });
    await storage.reorderPlaces([c.id, a.id, b.id]);
    expect((await storage.listPlaces()).map((p) => p.name)).toEqual(['C', 'A', 'B']);

    const f1 = await storage.createCollection('One');
    const f2 = await storage.createCollection('Two');
    await storage.reorderCollections([f2.id, f1.id]);
    expect((await storage.listCollections()).map((f) => f.name)).toEqual(['Two', 'One']);
  });

  it('new places list after a manually arranged order', async () => {
    const a = await storage.createPlace({ name: 'Z-first', lat: 1, lng: 1 });
    const b = await storage.createPlace({ name: 'A-second', lat: 2, lng: 2 });
    await storage.reorderPlaces([a.id, b.id]);
    const later = await storage.createPlace({ name: 'B-later', lat: 3, lng: 3 });
    expect((await storage.listPlaces()).map((p) => p.id)).toEqual([a.id, b.id, later.id]);
  });

  it('supports moving a place to a collection and back to root', async () => {
    const collection = await storage.createCollection('Hikes');
    const place = await storage.createPlace({ name: 'A', lat: 1, lng: 2 });
    await storage.updatePlace(place.id, { collectionId: collection.id });
    expect((await storage.listPlaces())[0]!.collectionId).toBe(collection.id);
    await storage.updatePlace(place.id, { collectionId: null });
    expect((await storage.listPlaces())[0]!.collectionId).toBeNull();
  });

  it('moves a nested collection up to its grandparent and rejects cycles', async () => {
    const root = await storage.createCollection('Norway');
    const parent = await storage.createCollection('Rogaland', root.id);
    const child = await storage.createCollection('Lysefjorden', parent.id);

    await storage.moveCollection(child.id, root.id);
    expect((await storage.listCollections()).find((c) => c.id === child.id)!.parentId).toBe(
      root.id,
    );

    await storage.moveCollection(child.id, null);
    expect((await storage.listCollections()).find((c) => c.id === child.id)!.parentId).toBeNull();

    await expect(storage.moveCollection(root.id, parent.id)).rejects.toThrow('own subtree');
    await expect(storage.moveCollection(root.id, root.id)).rejects.toThrow('own subtree');
    await expect(storage.moveCollection(root.id, 'missing')).rejects.toThrow(
      'Parent collection not found',
    );
  });

  it('nests collections and re-parents contents on delete', async () => {
    const parent = await storage.createCollection('Norway');
    const child = await storage.createCollection('Rogaland', parent.id);
    const grandchild = await storage.createCollection('Lysefjorden', child.id);
    const place = await storage.createPlace({ name: 'P', lat: 1, lng: 2, collectionId: child.id });

    await storage.deleteCollection(child.id);

    const collections = await storage.listCollections();
    expect(collections.map((c) => c.id).sort()).toEqual([parent.id, grandchild.id].sort());
    expect(collections.find((c) => c.id === grandchild.id)!.parentId).toBe(parent.id);
    expect((await storage.listPlaces())[0]!.collectionId).toBe(parent.id);
    expect(place.collectionId).toBe(child.id); // original record untouched
  });

  it('stores tracks with GPX body separate from the listed metadata', async () => {
    const gpx = '<gpx version="1.1"><trk><trkseg/></trk></gpx>';
    const track = await storage.createTrack({
      name: 'Morning run',
      gpx,
      stats: { distanceM: 5000, points: 120 },
      area: PERMIT_AREA,
    });

    const [listed] = await storage.listTracks();
    expect(listed).toMatchObject({
      name: 'Morning run',
      stats: { distanceM: 5000, points: 120 },
      visible: true,
      area: PERMIT_AREA,
    });
    expect('gpx' in listed!).toBe(false);
    expect(await storage.getTrackGpx(track.id)).toBe(gpx);
    expect(await storage.getTrackGpx('nope')).toBeNull();

    await storage.updateTrack(track.id, { visible: false, name: 'Evening run' });
    expect((await storage.listTracks())[0]).toMatchObject({ name: 'Evening run', visible: false });

    await storage.deleteTrack(track.id);
    expect(await storage.listTracks()).toEqual([]);
  });

  describe('undo (restore a deleted record)', () => {
    it('puts a place back with its id and contents intact', async () => {
      const folder = await storage.createCollection('Hikes');
      const place = await storage.createPlace({
        name: 'Preikestolen',
        lat: 58.9864,
        lng: 6.1904,
        collectionId: folder.id,
        notes: 'Steep!',
        tags: ['hike'],
        icon: '🏔️',
        color: '#16a34a',
      });

      const deleted = await storage.deletePlace(place.id);
      expect(await storage.listPlaces()).toEqual([]);
      await storage.restore(deleted!);

      const [restored] = await storage.listPlaces();
      expect(restored).toMatchObject({
        id: place.id,
        name: 'Preikestolen',
        lat: 58.9864,
        lng: 6.1904,
        collectionId: folder.id,
        notes: 'Steep!',
        tags: ['hike'],
        icon: '🏔️',
        color: '#16a34a',
        createdAt: place.createdAt,
      });
    });

    it('puts a track back with its GPX body', async () => {
      const gpx = '<gpx version="1.1"><trk><trkseg/></trk></gpx>';
      const track = await storage.createTrack({ name: 'Run', gpx, stats: { distanceM: 5000 } });

      const deleted = await storage.deleteTrack(track.id);
      await storage.restore(deleted!);

      expect((await storage.listTracks())[0]).toMatchObject({
        id: track.id,
        name: 'Run',
        stats: { distanceM: 5000 },
      });
      expect(await storage.getTrackGpx(track.id)).toBe(gpx);
    });

    it('puts a folder back and re-parents the children its delete moved up', async () => {
      const parent = await storage.createCollection('Norway');
      const folder = await storage.createCollection('Rogaland', parent.id);
      const child = await storage.createCollection('Lysefjorden', folder.id);
      const place = await storage.createPlace({
        name: 'P',
        lat: 1,
        lng: 2,
        collectionId: folder.id,
      });
      const trackGpx = '<gpx version="1.1"><trk><trkseg/></trk></gpx>';
      const track = await storage.createTrack({
        name: 'T',
        gpx: trackGpx,
        collectionId: folder.id,
      });

      const deleted = await storage.deleteCollection(folder.id);
      await storage.restore(deleted!);

      const collections = await storage.listCollections();
      expect(collections.find((c) => c.id === folder.id)).toMatchObject({
        name: 'Rogaland',
        parentId: parent.id,
      });
      expect(collections.find((c) => c.id === child.id)!.parentId).toBe(folder.id);
      expect((await storage.listPlaces()).find((p) => p.id === place.id)!.collectionId).toBe(
        folder.id,
      );
      expect((await storage.listTracks()).find((t) => t.id === track.id)!.collectionId).toBe(
        folder.id,
      );
    });

    it('returns null for an unknown id and enqueues the undo for sync', async () => {
      expect(await storage.deletePlace('nope')).toBeNull();
      expect(await storage.deleteCollection('nope')).toBeNull();

      const place = await storage.createPlace({ name: 'P', lat: 1, lng: 2 });
      const deleted = await storage.deletePlace(place.id);
      await storage.clearOutbox(await storage.listOutbox());
      await storage.restore(deleted!);

      // A restore must push as an upsert newer than the delete it undoes,
      // or LWW would resurrect the deletion on the next pull.
      expect(await storage.listOutbox()).toMatchObject([
        { entity: 'place', id: place.id, op: 'upsert' },
      ]);
    });
  });

  it('upserts settings', async () => {
    expect(await storage.getSetting('view')).toBeNull();
    await storage.setSetting('view', 'a');
    await storage.setSetting('view', 'b');
    expect(await storage.getSetting('view')).toBe('b');
  });

  describe('sync support', () => {
    it('records every mutation in the outbox, one entry per record (LWW)', async () => {
      const place = await storage.createPlace({ name: 'P', lat: 1, lng: 2 });
      await storage.updatePlace(place.id, { notes: 'x' });
      const outbox = await storage.listOutbox();
      expect(outbox).toHaveLength(1);
      expect(outbox[0]).toMatchObject({ entity: 'place', id: place.id, op: 'upsert' });

      await storage.deletePlace(place.id);
      expect(await storage.listOutbox()).toMatchObject([
        { entity: 'place', id: place.id, op: 'delete' },
      ]);
    });

    it('does not enqueue local-only settings', async () => {
      await storage.setSetting('local.syncCursor', '42');
      await storage.setSetting('theme', 'dark');
      const outbox = await storage.listOutbox();
      expect(outbox).toMatchObject([{ entity: 'setting', id: 'theme', op: 'upsert' }]);
    });

    it('enqueues records moved when their folder is deleted', async () => {
      const folder = await storage.createCollection('F');
      const place = await storage.createPlace({
        name: 'P',
        lat: 1,
        lng: 2,
        collectionId: folder.id,
      });
      await storage.clearOutbox(await storage.listOutbox());

      await storage.deleteCollection(folder.id);
      const outbox = await storage.listOutbox();
      expect(outbox).toContainEqual(
        expect.objectContaining({ entity: 'place', id: place.id, op: 'upsert' }),
      );
      expect(outbox).toContainEqual(
        expect.objectContaining({ entity: 'collection', id: folder.id, op: 'delete' }),
      );
    });

    it('clearOutbox leaves entries that changed since the snapshot', async () => {
      const place = await storage.createPlace({ name: 'P', lat: 1, lng: 2 });
      const snapshot = await storage.listOutbox();
      // A newer mutation lands between snapshot and clear (updated_at moves on).
      await new Promise((r) => setTimeout(r, 2));
      await storage.updatePlace(place.id, { notes: 'newer' });
      await storage.clearOutbox(snapshot);
      expect(await storage.listOutbox()).toHaveLength(1);
    });

    it('reads sync payloads including the track GPX body', async () => {
      const track = await storage.createTrack({
        name: 'T',
        gpx: '<gpx/>',
        stats: { d: 1 },
        area: PERMIT_AREA,
      });
      const record = await storage.readSyncRecord('track', track.id);
      expect(record!.data).toMatchObject({
        name: 'T',
        gpx: '<gpx/>',
        stats: { d: 1 },
        area: PERMIT_AREA,
      });
      expect(await storage.readSyncRecord('track', 'missing')).toBeNull();

      await storage.setSetting('theme', 'dark');
      expect((await storage.readSyncRecord('setting', 'theme'))!.data).toEqual({ value: 'dark' });
    });

    it('queues track metadata edits without GPX, while pending creates stay full', async () => {
      const track = await storage.createTrack({
        name: 'Long recording',
        gpx: '<gpx>many megabytes in reality</gpx>',
        stats: { d: 1 },
      });
      await storage.updateTrack(track.id, { name: 'Renamed before first sync' });
      expect((await storage.listOutbox())[0]).toMatchObject({
        entity: 'track',
        scope: 'full',
      });

      await storage.clearOutbox(await storage.listOutbox());
      await storage.updateTrack(track.id, { notes: 'metadata only' });
      const entry = (await storage.listOutbox())[0]!;
      expect(entry.scope).toBe('track-metadata');
      const partial = await storage.readSyncRecord('track', track.id, entry.scope);
      expect(partial!.data).toMatchObject({
        name: 'Renamed before first sync',
        notes: 'metadata only',
      });
      expect(partial!.data).not.toHaveProperty('gpx');

      await storage.enqueueFullState();
      expect((await storage.listOutbox())[0]!.scope).toBe('full');
    });

    it('merges a defensive partial track pull without erasing its GPX body', async () => {
      const track = await storage.createTrack({ name: 'Original', gpx: '<gpx/>', stats: { d: 1 } });
      await storage.applyRemoteChange({
        entity: 'track',
        id: track.id,
        updatedAt: track.updatedAt + 1,
        deleted: false,
        partial: true,
        data: { name: 'Remote rename', notes: 'kept small' },
      });
      expect((await storage.listTracks())[0]).toMatchObject({
        name: 'Remote rename',
        notes: 'kept small',
      });
      expect(await storage.getTrackGpx(track.id)).toBe('<gpx/>');
    });

    it('applies newer remote changes and skips older ones', async () => {
      const place = await storage.createPlace({ name: 'Local', lat: 1, lng: 2 });

      const stale = await storage.applyRemoteChange({
        entity: 'place',
        id: place.id,
        updatedAt: place.updatedAt - 1000,
        deleted: false,
        data: { name: 'Stale', lat: 9, lng: 9, createdAt: 1 },
      });
      expect(stale).toBe('skipped');
      expect((await storage.listPlaces())[0]!.name).toBe('Local');

      const fresh = await storage.applyRemoteChange({
        entity: 'place',
        id: place.id,
        updatedAt: place.updatedAt + 1000,
        deleted: false,
        data: { name: 'Remote', lat: 9, lng: 9, notes: 'n', tags: ['a'], createdAt: 1 },
      });
      expect(fresh).toBe('applied');
      expect((await storage.listPlaces())[0]).toMatchObject({ name: 'Remote', tags: ['a'] });
      // The superseded local outbox entry is gone — no echo back to the server.
      expect(await storage.listOutbox()).toHaveLength(0);
    });

    it('applies remote deletes as removals', async () => {
      const place = await storage.createPlace({ name: 'P', lat: 1, lng: 2 });
      await storage.applyRemoteChange({
        entity: 'place',
        id: place.id,
        updatedAt: place.updatedAt + 1,
        deleted: true,
        data: null,
      });
      expect(await storage.listPlaces()).toEqual([]);
    });

    it('creates records from remote changes for ids never seen locally', async () => {
      await storage.applyRemoteChange({
        entity: 'track',
        id: 'remote-track',
        updatedAt: 5,
        deleted: false,
        data: {
          name: 'From phone',
          gpx: '<gpx/>',
          visible: false,
          area: PERMIT_AREA,
          createdAt: 4,
        },
      });
      expect((await storage.listTracks())[0]).toMatchObject({
        id: 'remote-track',
        name: 'From phone',
        visible: false,
        area: PERMIT_AREA,
      });
      expect(await storage.getTrackGpx('remote-track')).toBe('<gpx/>');
    });

    it('round-trips place icon/colour through sync payloads', async () => {
      const place = await storage.createPlace({
        name: 'Cabin',
        lat: 1,
        lng: 2,
        address: 'Karl Johans gate 1, Oslo',
        icon: '🏠',
        color: '#2563eb',
      });
      const payload = await storage.readSyncRecord('place', place.id);
      expect(payload!.data).toMatchObject({
        icon: '🏠',
        color: '#2563eb',
        address: 'Karl Johans gate 1, Oslo',
      });

      // A remote change without icon/colour falls back to the defaults.
      await storage.applyRemoteChange({
        entity: 'place',
        id: 'remote-place',
        updatedAt: 5,
        deleted: false,
        data: { name: 'Legacy', lat: 3, lng: 4, createdAt: 4 },
      });
      const legacy = (await storage.listPlaces()).find((p) => p.id === 'remote-place');
      expect(legacy).toMatchObject({ icon: '📍', color: '#e11d48', address: '' });
    });

    it('round-trips place/folder visibility through sync payloads', async () => {
      const folder = await storage.createCollection('F');
      const place = await storage.createPlace({ name: 'P', lat: 1, lng: 2 });
      await storage.updatePlace(place.id, { visible: false });
      await storage.setCollectionVisible(folder.id, false);

      expect((await storage.readSyncRecord('place', place.id))!.data).toMatchObject({
        visible: false,
      });
      expect((await storage.readSyncRecord('collection', folder.id))!.data).toMatchObject({
        visible: false,
      });

      // A remote change with visible:false applies; a legacy one (no field) shows.
      await storage.applyRemoteChange({
        entity: 'place',
        id: 'remote-hidden',
        updatedAt: 5,
        deleted: false,
        data: { name: 'Hidden', lat: 3, lng: 4, visible: false, createdAt: 4 },
      });
      await storage.applyRemoteChange({
        entity: 'collection',
        id: 'remote-folder',
        updatedAt: 5,
        deleted: false,
        data: { name: 'Legacy', createdAt: 4 },
      });
      expect((await storage.listPlaces()).find((p) => p.id === 'remote-hidden')!.visible).toBe(
        false,
      );
      expect((await storage.listCollections()).find((c) => c.id === 'remote-folder')!.visible).toBe(
        true,
      );
    });

    it('round-trips sort order through sync payloads', async () => {
      const place = await storage.createPlace({ name: 'P', lat: 1, lng: 2 });
      await storage.updatePlace(place.id, { sortIndex: 7 });
      expect((await storage.readSyncRecord('place', place.id))!.data).toMatchObject({
        sortIndex: 7,
      });

      // A remote change carries its order; a legacy one falls back to createdAt.
      await storage.applyRemoteChange({
        entity: 'place',
        id: 'remote-ordered',
        updatedAt: 5,
        deleted: false,
        data: { name: 'First', lat: 3, lng: 4, sortIndex: 1, createdAt: 4 },
      });
      const places = await storage.listPlaces();
      expect(places.map((p) => p.id)).toEqual(['remote-ordered', place.id]);
    });

    it('enqueueFullState queues everything except local settings', async () => {
      await storage.createCollection('C');
      await storage.createPlace({ name: 'P', lat: 1, lng: 2 });
      await storage.createTrack({ name: 'T', gpx: '<gpx/>' });
      await storage.setSetting('theme', 'dark');
      await storage.setSetting('local.syncCursor', '9');
      await storage.clearOutbox(await storage.listOutbox());

      await storage.enqueueFullState();
      const outbox = await storage.listOutbox();
      expect(outbox).toHaveLength(4);
      expect(outbox.every((e) => e.op === 'upsert')).toBe(true);
    });
  });

  it('exports everything', async () => {
    const collection = await storage.createCollection('C');
    await storage.createPlace({ name: 'P', lat: 1, lng: 2, collectionId: collection.id });
    await storage.createTrack({ name: 'T', gpx: '<gpx/>', area: PERMIT_AREA });
    await storage.setSetting('k', 'v');

    const dump = await storage.exportAll();
    expect(dump.collections).toHaveLength(1);
    expect(dump.places).toHaveLength(1);
    expect(dump.tracks[0]).toMatchObject({ name: 'T', gpx: '<gpx/>', area: PERMIT_AREA });
    expect(dump.settings).toEqual({ k: 'v' });
    expect(dump.exportedAt).toBeGreaterThan(0);
  });

  describe('importAll (restore a backup)', () => {
    /** A dump taken from one storage, restored into a fresh empty one. */
    const freshStorage = async (): Promise<AtlasStorage> => {
      const s = new AtlasStorage(createNodeDriver());
      await s.init();
      return s;
    };

    it('round-trips a full export into an empty device', async () => {
      const collection = await storage.createCollection('Trips');
      await storage.createPlace({
        name: 'Preikestolen',
        lat: 58.9864,
        lng: 6.1904,
        collectionId: collection.id,
        address: 'Preikestolvegen 521, Jørpeland',
        notes: 'Steep',
        tags: ['hike'],
      });
      await storage.createTrack({
        name: 'Day 1',
        gpx: '<gpx>original</gpx>',
        area: PERMIT_AREA,
      });
      await storage.setSetting('units', 'metric');
      const dump = await storage.exportAll();

      const restored = await freshStorage();
      const summary = await restored.importAll(dump);
      expect(summary.collections.imported).toBe(1);
      expect(summary.places.imported).toBe(1);
      expect(summary.tracks.imported).toBe(1);
      expect(summary.settings.imported).toBe(1);

      // Ids survive, so a re-import merges rather than duplicating.
      expect(await restored.listCollections()).toEqual(await storage.listCollections());
      expect(await restored.listPlaces()).toEqual(await storage.listPlaces());
      const tracks = await restored.exportAll();
      expect(tracks.tracks[0]).toMatchObject({
        name: 'Day 1',
        gpx: '<gpx>original</gpx>',
        area: PERMIT_AREA,
      });
      expect(await restored.getSetting('units')).toBe('metric');
    });

    it('is idempotent — importing twice changes nothing the second time', async () => {
      await storage.createPlace({ name: 'P', lat: 1, lng: 2 });
      const dump = await storage.exportAll();
      const restored = await freshStorage();

      await restored.importAll(dump);
      const second = await restored.importAll(dump);
      expect(second.places).toEqual({ imported: 0, skipped: 1 });
      expect(await restored.listPlaces()).toHaveLength(1);
    });

    it('never overwrites a newer local edit (LWW), and never deletes', async () => {
      const place = await storage.createPlace({ name: 'Old name', lat: 1, lng: 2 });
      const dump = await storage.exportAll();

      // The local copy is edited after the backup was taken...
      await new Promise((r) => setTimeout(r, 2));
      await storage.updatePlace(place.id, { name: 'New name' });
      // ...and something created since the backup must survive the restore.
      await storage.createPlace({ name: 'Created later', lat: 3, lng: 4 });

      const summary = await storage.importAll(dump);
      expect(summary.places.skipped).toBe(1);
      const names = (await storage.listPlaces()).map((p) => p.name).sort();
      expect(names).toEqual(['Created later', 'New name']);
    });

    it('restores an older record the local device has since lost', async () => {
      const place = await storage.createPlace({ name: 'Deleted by accident', lat: 1, lng: 2 });
      const dump = await storage.exportAll();
      await storage.deletePlace(place.id);
      expect(await storage.listPlaces()).toHaveLength(0);

      await storage.importAll(dump);
      expect((await storage.listPlaces())[0]).toMatchObject({
        id: place.id,
        name: 'Deleted by accident',
      });
    });

    it('enqueues imports so a restore propagates to other devices', async () => {
      await storage.createCollection('C');
      await storage.createPlace({ name: 'P', lat: 1, lng: 2 });
      const dump = await storage.exportAll();

      const restored = await freshStorage();
      await restored.importAll(dump);
      const outbox = await restored.listOutbox();
      expect(outbox.map((e) => e.entity).sort()).toEqual(['collection', 'place']);
      expect(outbox.every((e) => e.op === 'upsert')).toBe(true);
    });

    it('skips local.* settings — device-private state must not travel in a backup', async () => {
      await storage.setSetting('local.sync.cursor', '42');
      await storage.setSetting('units', 'metric');
      const dump = await storage.exportAll();
      expect(dump.settings['local.sync.cursor']).toBe('42');

      const restored = await freshStorage();
      const summary = await restored.importAll(dump);
      expect(await restored.getSetting('local.sync.cursor')).toBeNull();
      expect(await restored.getSetting('units')).toBe('metric');
      expect(summary.settings).toEqual({ imported: 1, skipped: 1 });
    });

    it('leaves an existing setting alone (dumps carry no per-setting timestamp)', async () => {
      await storage.setSetting('units', 'metric');
      const dump = await storage.exportAll();
      const restored = await freshStorage();
      await restored.setSetting('units', 'imperial');

      await restored.importAll(dump);
      expect(await restored.getSetting('units')).toBe('imperial');
    });
  });

  describe('LWW stamps (monotonic hybrid clock)', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('stays monotonic when the wall clock steps backwards', async () => {
      const start = Date.now();
      const clock = vi.spyOn(Date, 'now').mockReturnValue(start);
      const place = await storage.createPlace({ name: 'P', lat: 1, lng: 2 });

      clock.mockReturnValue(start - 60_000); // clock jumps back a minute
      await storage.updatePlace(place.id, { notes: 'later edit' });
      const record = await storage.readSyncRecord('place', place.id);
      expect(record!.updatedAt).toBeGreaterThan(place.updatedAt);
    });

    it('an edit on a lagging clock still outranks remote state it has seen', async () => {
      const remoteStamp = Date.now() + 60_000; // the other device's clock runs ahead
      await storage.applyRemoteChange({
        entity: 'place',
        id: 'shared',
        updatedAt: remoteStamp,
        deleted: false,
        data: { name: 'From ahead-clock device', lat: 1, lng: 2, createdAt: 1 },
      });

      await storage.updatePlace('shared', { name: 'Edited here afterwards' });
      const record = await storage.readSyncRecord('place', 'shared');
      // Without the observed-stamp rule this edit would carry a lower stamp
      // and lose LWW everywhere to the state it was made on top of.
      expect(record!.updatedAt).toBeGreaterThan(remoteStamp);
    });

    it('reseeds the clock from stored stamps after a reopen', async () => {
      const driver = createNodeDriver();
      const first = new AtlasStorage(driver);
      await first.init();
      const futureStamp = Date.now() + 60_000;
      await first.applyRemoteChange({
        entity: 'place',
        id: 'p',
        updatedAt: futureStamp,
        deleted: false,
        data: { name: 'Future-stamped', lat: 1, lng: 2, createdAt: 1 },
      });

      const reopened = new AtlasStorage(driver);
      await reopened.init();
      await reopened.updatePlace('p', { notes: 'after restart' });
      expect((await reopened.readSyncRecord('place', 'p'))!.updatedAt).toBeGreaterThan(futureStamp);
    });

    it('applies an equal-stamp remote change — the server broke the tie', async () => {
      const t = Date.now() + 1000;
      vi.spyOn(Date, 'now').mockReturnValue(t);
      const place = await storage.createPlace({ name: 'Mine', lat: 1, lng: 2 });
      expect(place.updatedAt).toBe(t);

      const outcome = await storage.applyRemoteChange({
        entity: 'place',
        id: place.id,
        updatedAt: t,
        deleted: false,
        data: { name: 'Tie winner from other device', lat: 3, lng: 4, createdAt: 1 },
      });
      expect(outcome).toBe('applied');
      expect((await storage.listPlaces())[0]!.name).toBe('Tie winner from other device');
      // The superseded local outbox entry went with it — no echo back.
      expect(await storage.countOutbox()).toBe(0);
    });
  });

  describe('atomicity under injected failures', () => {
    /** Two views over one database: `good` verifies, `flaky` fails mid-transaction. */
    const split = async (match: RegExp) => {
      const driver = createNodeDriver();
      const good = new AtlasStorage(driver);
      await good.init();
      return { good, flaky: new AtlasStorage(sabotageBatch(driver, match)) };
    };

    it('a create whose outbox write fails leaves no record behind', async () => {
      const { good, flaky } = await split(/INTO outbox/);
      await expect(flaky.createPlace({ name: 'P', lat: 1, lng: 2 })).rejects.toThrow();
      expect(await good.listPlaces()).toEqual([]);
      expect(await good.countOutbox()).toBe(0);
    });

    it('a delete whose outbox write fails leaves the record in place', async () => {
      const { good, flaky } = await split(/INTO outbox/);
      const place = await good.createPlace({ name: 'P', lat: 1, lng: 2 });
      await expect(flaky.deletePlace(place.id)).rejects.toThrow();
      expect(await good.listPlaces()).toHaveLength(1);
      // The original upsert entry is still queued — nothing was half-cleared.
      expect(await good.listOutbox()).toMatchObject([
        { entity: 'place', id: place.id, op: 'upsert' },
      ]);
    });

    it('a folder delete that fails mid-tree rolls the whole reparent back', async () => {
      const { good, flaky } = await split(/DELETE FROM collections/);
      const folder = await good.createCollection('F');
      const child = await good.createCollection('Child', folder.id);
      const place = await good.createPlace({ name: 'P', lat: 1, lng: 2, collectionId: folder.id });
      const outboxBefore = await good.listOutbox();

      await expect(flaky.deleteCollection(folder.id)).rejects.toThrow();

      const collections = await good.listCollections();
      expect(collections.map((c) => c.id).sort()).toEqual([folder.id, child.id].sort());
      expect(collections.find((c) => c.id === child.id)!.parentId).toBe(folder.id);
      expect((await good.listPlaces())[0]!.collectionId).toBe(place.collectionId);
      expect(await good.listOutbox()).toEqual(outboxBefore);
    });

    it('a reorder either lands whole or not at all', async () => {
      const { good, flaky } = await split(/INTO outbox/);
      const a = await good.createPlace({ name: 'A', lat: 1, lng: 1 });
      const b = await good.createPlace({ name: 'B', lat: 2, lng: 2 });
      const before = (await good.listPlaces()).map((p) => p.id);

      await expect(flaky.reorderPlaces([b.id, a.id])).rejects.toThrow();
      expect((await good.listPlaces()).map((p) => p.id)).toEqual(before);
    });

    it('a backup restore is all-or-nothing across entity kinds', async () => {
      const source = new AtlasStorage(createNodeDriver());
      await source.init();
      const collection = await source.createCollection('C');
      await source.createPlace({ name: 'P', lat: 1, lng: 2, collectionId: collection.id });
      await source.createTrack({ name: 'T', gpx: '<gpx/>' });
      const dump = await source.exportAll();

      // The track upsert comes after the collection and place statements.
      const { good: target, flaky } = await split(/INTO tracks/);
      await expect(flaky.importAll(dump)).rejects.toThrow();
      expect(await target.listCollections()).toEqual([]);
      expect(await target.listPlaces()).toEqual([]);
      expect(await target.countOutbox()).toBe(0);
    });

    it('a remote change that fails mid-apply neither applies nor clears the outbox', async () => {
      const { good, flaky } = await split(/DELETE FROM outbox/);
      const place = await good.createPlace({ name: 'Local', lat: 1, lng: 2 });

      await expect(
        flaky.applyRemoteChange({
          entity: 'place',
          id: place.id,
          updatedAt: place.updatedAt + 1000,
          deleted: false,
          data: { name: 'Remote', lat: 9, lng: 9, createdAt: 1 },
        }),
      ).rejects.toThrow();
      expect((await good.listPlaces())[0]!.name).toBe('Local');
      expect(await good.listOutbox()).toMatchObject([{ entity: 'place', id: place.id }]);
    });
  });
});

describe('migrate', () => {
  const userVersion = async (driver: SqlDriver): Promise<number> =>
    Number((await driver.query('PRAGMA user_version'))[0]!['user_version']);

  it('applies each migration script and its version bump as one transaction', async () => {
    const driver = createNodeDriver();
    const first = 'CREATE TABLE a (x INTEGER);';
    await migrate(driver, [first]);
    expect(await userVersion(driver)).toBe(1);

    // The second script fails on its second statement (table a already
    // exists) — its first statement must be rolled back with it.
    const broken = 'CREATE TABLE b (x INTEGER);\nCREATE TABLE a (x INTEGER);';
    await expect(migrate(driver, [first, broken])).rejects.toThrow();
    expect(await userVersion(driver)).toBe(1);
    expect(await driver.query("SELECT name FROM sqlite_master WHERE name = 'b'")).toEqual([]);

    // A corrected script then applies cleanly on the same database — the
    // failed attempt left nothing behind that could make it rerun wrongly.
    await migrate(driver, [first, 'CREATE TABLE b (x INTEGER);']);
    expect(await userVersion(driver)).toBe(2);
  });
});
