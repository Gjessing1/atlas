import { AtlasStorage } from '@atlas/storage';
import type { SyncChange } from '@atlas/storage';
import { createNodeSqlDriver as createNodeDriver } from '@atlas/storage/node';
import { describe, expect, it, vi } from 'vitest';
import { SYNC_CURSOR_KEY, SyncEngine, SyncError } from './engine.js';
import type { SyncPullResponse, SyncPushRequest } from './protocol.js';
import { MAX_CLOCK_SKEW_MS, clampFutureStamps, lwwWins } from './protocol.js';

/** In-memory model of the backend sync store: LWW rows + a pull sequence. */
class FakeServer {
  online = true;
  authorized = true;
  acceptsTrackMetadata = true;
  pushes = 0;
  /** Mirrors Fastify's bodyLimit: an oversized push is rejected with 413. */
  bodyLimit = Infinity;
  rejections = 0;
  pushedChanges: SyncChange[][] = [];
  private rows = new Map<string, { change: SyncChange; seq: number; deviceId: string }>();
  private seq = 0;

  /** Inject a row as if another device had written it (for pull-side tests). */
  seed(change: SyncChange): void {
    this.rows.set(`${change.entity}|${change.id}`, {
      change,
      seq: ++this.seq,
      deviceId: 'other-device',
    });
  }

  readonly fetchFn: typeof fetch = (input, init) => {
    const url = new URL(String(input), 'http://server');
    if (!this.online) return Promise.reject(new TypeError('fetch failed'));
    if (!this.authorized) return Promise.resolve(Response.json({ error: 'nope' }, { status: 401 }));
    if (url.pathname === '/api/sync/push') {
      this.pushes++;
      if (String(init?.body).length > this.bodyLimit) {
        this.rejections++;
        return Promise.resolve(Response.json({ error: 'too large' }, { status: 413 }));
      }
      const body = JSON.parse(String(init?.body)) as SyncPushRequest;
      this.pushedChanges.push(body.changes);
      if (body.changes.length === 0) {
        return Promise.resolve(
          Response.json({
            applied: 0,
            skipped: 0,
            ...(this.acceptsTrackMetadata ? { acceptsTrackMetadata: true } : {}),
          }),
        );
      }
      let applied = 0;
      let skipped = 0;
      const requiresFull: { entity: SyncChange['entity']; id: string }[] = [];
      for (const change of body.changes) {
        const key = `${change.entity}|${change.id}`;
        const existing = this.rows.get(key);
        const stored = existing
          ? { updatedAt: existing.change.updatedAt, deviceId: existing.deviceId }
          : null;
        if (lwwWins({ updatedAt: change.updatedAt, deviceId: body.deviceId }, stored)) {
          if (
            change.partial &&
            (!existing ||
              existing.change.deleted ||
              existing.change.data === null ||
              change.data === null ||
              (change.entity === 'track' && typeof existing.change.data['gpx'] !== 'string'))
          ) {
            requiresFull.push({ entity: change.entity, id: change.id });
            continue;
          }
          const storedChange = change.partial
            ? {
                ...change,
                partial: undefined,
                data: { ...existing!.change.data!, ...change.data! },
              }
            : change;
          this.rows.set(key, { change: storedChange, seq: ++this.seq, deviceId: body.deviceId });
          applied++;
        } else {
          skipped++;
        }
      }
      return Promise.resolve(
        Response.json({
          applied,
          skipped,
          ...(requiresFull.length > 0 ? { requiresFull } : {}),
        }),
      );
    }
    if (url.pathname === '/api/sync/pull') {
      const since = Number(url.searchParams.get('since'));
      const device = url.searchParams.get('device');
      const limit = Number(url.searchParams.get('limit')) || 100;
      const all = [...this.rows.values()]
        .filter((r) => r.seq > since && r.deviceId !== device)
        .sort((a, b) => a.seq - b.seq);
      const page = all.slice(0, limit);
      const cursor = page.length > 0 ? page[page.length - 1]!.seq : this.seq;
      const body: SyncPullResponse = {
        changes: page.map((r) => r.change),
        cursor,
        hasMore: all.length > limit,
      };
      return Promise.resolve(Response.json(body));
    }
    return Promise.resolve(Response.json({ error: 'not found' }, { status: 404 }));
  };
}

async function createDevice(
  server: FakeServer,
  opts: { maxPushBytes?: number } = {},
): Promise<{ storage: AtlasStorage; engine: SyncEngine }> {
  const storage = new AtlasStorage(createNodeDriver());
  await storage.init();
  const engine = new SyncEngine({
    storage,
    getToken: () => 'test-token',
    fetchFn: server.fetchFn,
    batchSize: 3,
    ...opts,
  });
  return { storage, engine };
}

describe('lwwWins', () => {
  const stamp = (updatedAt: number, deviceId = 'a') => ({ updatedAt, deviceId });

  it('applies newer, keeps older', () => {
    expect(lwwWins(stamp(2), null)).toBe(true);
    expect(lwwWins(stamp(2), stamp(1))).toBe(true);
    expect(lwwWins(stamp(1), stamp(2))).toBe(false);
  });

  it('breaks equal stamps deterministically on device id', () => {
    // A genuine two-device tie resolves the same way whichever push lands
    // first — larger device id wins.
    expect(lwwWins(stamp(2, 'b'), stamp(2, 'a'))).toBe(true);
    expect(lwwWins(stamp(2, 'a'), stamp(2, 'b'))).toBe(false);
    // A replay from the same device stays a no-op.
    expect(lwwWins(stamp(2, 'a'), stamp(2, 'a'))).toBe(false);
  });
});

describe('clampFutureStamps', () => {
  it('clamps only stamps beyond the skew window', () => {
    const now = 1_000_000;
    const change = (updatedAt: number): SyncChange => ({
      entity: 'place',
      id: 'p',
      updatedAt,
      deleted: false,
      data: {},
    });
    const [past, nearFuture, farFuture] = clampFutureStamps(
      [change(now - 1), change(now + MAX_CLOCK_SKEW_MS), change(now + MAX_CLOCK_SKEW_MS + 1)],
      now,
    );
    expect(past!.updatedAt).toBe(now - 1);
    expect(nearFuture!.updatedAt).toBe(now + MAX_CLOCK_SKEW_MS);
    expect(farFuture!.updatedAt).toBe(now + MAX_CLOCK_SKEW_MS);
  });
});

describe('SyncEngine', () => {
  it('pushes local changes and pulls them onto a second device', async () => {
    const server = new FakeServer();
    const a = await createDevice(server);
    const b = await createDevice(server);

    const folder = await a.storage.createCollection('Hikes');
    await a.storage.createPlace({
      name: 'Preikestolen',
      lat: 58.98,
      lng: 6.19,
      collectionId: folder.id,
    });
    await a.storage.createTrack({ name: 'Run', gpx: '<gpx/>', stats: { d: 1 } });
    await a.storage.setSetting('theme', 'dark');

    const pushResult = await a.engine.sync();
    expect(pushResult.pushed).toBe(4);
    expect(await a.storage.listOutbox()).toEqual([]);

    const pullResult = await b.engine.sync();
    expect(pullResult.pulled).toBe(4);
    expect((await b.storage.listCollections())[0]!.name).toBe('Hikes');
    expect((await b.storage.listPlaces())[0]!.collectionId).toBe(folder.id);
    expect(await b.storage.getTrackGpx((await b.storage.listTracks())[0]!.id)).toBe('<gpx/>');
    expect(await b.storage.getSetting('theme')).toBe('dark');
    // Nothing echoes back: b's pull created no outbox entries.
    expect(await b.storage.listOutbox()).toEqual([]);
  });

  it('syncs a track rename as metadata only and preserves GPX on every device', async () => {
    const server = new FakeServer();
    const a = await createDevice(server);
    const b = await createDevice(server);
    const gpx = `<gpx>${'point'.repeat(20_000)}</gpx>`;
    const track = await a.storage.createTrack({ name: 'Original', gpx, stats: { d: 1 } });
    await a.engine.sync();
    await b.engine.sync();

    server.pushedChanges = [];
    await a.storage.updateTrack(track.id, { name: 'Renamed', notes: 'small change' });
    await a.engine.sync();

    const sent = server.pushedChanges.flat().find((change) => change.id === track.id)!;
    expect(sent.partial).toBe(true);
    expect(sent.data).toMatchObject({ name: 'Renamed', notes: 'small change' });
    expect(sent.data).not.toHaveProperty('gpx');

    await b.engine.sync();
    expect((await b.storage.listTracks())[0]).toMatchObject({
      name: 'Renamed',
      notes: 'small change',
    });
    expect(await b.storage.getTrackGpx(track.id)).toBe(gpx);
  });

  it('sends a full track rename until the active server confirms partial support', async () => {
    const server = new FakeServer();
    server.acceptsTrackMetadata = false;
    const a = await createDevice(server);
    const gpx = `<gpx>${'legacy-compatible'.repeat(1000)}</gpx>`;
    const track = await a.storage.createTrack({ name: 'Original', gpx, stats: {} });
    await a.engine.sync();

    server.pushedChanges = [];
    await a.storage.updateTrack(track.id, { name: 'Safe rolling deploy' });
    await a.engine.sync();

    const sent = server.pushedChanges.flat().find((change) => change.id === track.id)!;
    expect(sent.partial).toBeUndefined();
    expect(sent.data).toMatchObject({ name: 'Safe rolling deploy', gpx });
  });

  it('retries a metadata-only track as full when the server has no base', async () => {
    const server = new FakeServer();
    const a = await createDevice(server);
    const track = await a.storage.createTrack({ name: 'Local', gpx: '<gpx/>', stats: {} });
    // Simulate a previously-synced row whose server-side base was lost.
    await a.storage.clearOutbox(await a.storage.listOutbox());
    await a.storage.updateTrack(track.id, { name: 'Needs full fallback' });

    const result = await a.engine.sync();
    expect(result).toMatchObject({ pushed: 1, failed: [] });
    const pushes = server.pushedChanges.flat().filter((change) => change.id === track.id);
    expect(pushes).toHaveLength(2);
    expect(pushes[0]).toMatchObject({ partial: true });
    expect(pushes[0]!.data).not.toHaveProperty('gpx');
    expect(pushes[1]!.partial).toBeUndefined();
    expect(pushes[1]!.data).toMatchObject({ gpx: '<gpx/>' });

    const b = await createDevice(server);
    await b.engine.sync();
    expect(await b.storage.getTrackGpx(track.id)).toBe('<gpx/>');
  });

  it('does not re-download changes this device pushed', async () => {
    const server = new FakeServer();
    const a = await createDevice(server);
    await a.storage.createPlace({ name: 'P', lat: 1, lng: 2 });
    const result = await a.engine.sync();
    expect(result.pulled).toBe(0);
    // Cursor still advances past our own writes.
    const again = await a.engine.sync();
    expect(again.pulled).toBe(0);
  });

  it('keeps the outbox and cursor intact while offline, then replays', async () => {
    const server = new FakeServer();
    const a = await createDevice(server);
    await a.storage.createPlace({ name: 'Offline pin', lat: 1, lng: 2 });

    server.online = false;
    await expect(a.engine.sync()).rejects.toMatchObject({ kind: 'unavailable' });
    expect(await a.storage.listOutbox()).toHaveLength(1);

    server.online = true;
    const result = await a.engine.sync();
    expect(result.pushed).toBe(1);
    expect(await a.storage.listOutbox()).toEqual([]);

    const b = await createDevice(server);
    await b.engine.sync();
    expect((await b.storage.listPlaces())[0]!.name).toBe('Offline pin');
  });

  it('surfaces auth failures as SyncError kind auth', async () => {
    const server = new FakeServer();
    const a = await createDevice(server);
    await a.storage.createPlace({ name: 'P', lat: 1, lng: 2 });
    server.authorized = false;
    await expect(a.engine.sync()).rejects.toSatisfy(
      (e: unknown) => e instanceof SyncError && e.kind === 'auth',
    );
    const noToken = new SyncEngine({
      storage: a.storage,
      getToken: () => null,
      fetchFn: server.fetchFn,
    });
    await expect(noToken.sync()).rejects.toMatchObject({ kind: 'auth' });
  });

  it('resolves concurrent edits by last write wins across devices', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const server = new FakeServer();
    const a = await createDevice(server);
    const b = await createDevice(server);

    const place = await a.storage.createPlace({ name: 'Original', lat: 1, lng: 2 });
    await a.engine.sync();
    await b.engine.sync();

    // b edits after a — b's write is newer and must win everywhere. Use an
    // explicit wall clock so host clock adjustments cannot reverse the order.
    clock.mockReturnValue(1_000_100);
    await a.storage.updatePlace(place.id, { name: 'From A' });
    clock.mockReturnValue(1_000_200);
    await b.storage.updatePlace(place.id, { name: 'From B' });

    await a.engine.sync();
    await b.engine.sync();
    await a.engine.sync();

    expect((await a.storage.listPlaces())[0]!.name).toBe('From B');
    expect((await b.storage.listPlaces())[0]!.name).toBe('From B');
    clock.mockRestore();
  });

  it('propagates deletes as tombstones', async () => {
    const server = new FakeServer();
    const a = await createDevice(server);
    const b = await createDevice(server);

    const place = await a.storage.createPlace({ name: 'Doomed', lat: 1, lng: 2 });
    await a.engine.sync();
    await b.engine.sync();
    expect(await b.storage.listPlaces()).toHaveLength(1);

    await a.storage.deletePlace(place.id);
    await a.engine.sync();
    await b.engine.sync();
    expect(await b.storage.listPlaces()).toEqual([]);
  });

  it('pages large pulls until hasMore is false', async () => {
    const server = new FakeServer();
    const a = await createDevice(server);
    const b = await createDevice(server);
    for (let i = 0; i < 8; i++) await a.storage.createPlace({ name: `P${i}`, lat: i, lng: i });
    await a.engine.sync();
    const result = await b.engine.sync(); // batchSize 3 → 3 pages
    expect(result.pulled).toBe(8);
    expect(await b.storage.listPlaces()).toHaveLength(8);
  });

  it('bootstrap queues pre-login data and resets the cursor', async () => {
    const server = new FakeServer();
    const a = await createDevice(server);
    // Data created "anonymously", then synced once, outbox drained.
    await a.storage.createPlace({ name: 'Old pin', lat: 1, lng: 2 });
    await a.engine.sync();

    // Fresh account on the same server: bootstrap re-queues everything.
    await a.engine.bootstrap();
    expect(await a.storage.getSetting(SYNC_CURSOR_KEY)).toBe('0');
    const outbox = await a.storage.listOutbox();
    expect(outbox.some((e) => e.entity === 'place')).toBe(true);
    // Device id is local-only and never queued.
    expect(outbox.every((e) => !e.id.startsWith('local.'))).toBe(true);
    const result = await a.engine.sync();
    expect(result.pushed).toBeGreaterThan(0);
  });

  it('splits pushes by payload size, not just count', async () => {
    const server = new FakeServer();
    // A batch of 3 large tracks would overflow the server; 2 fit comfortably.
    server.bodyLimit = 2800;
    const a = await createDevice(server, { maxPushBytes: 2400 });
    const gpx = '<gpx>' + 'x'.repeat(1000) + '</gpx>';
    for (let i = 0; i < 3; i++) {
      await a.storage.createTrack({ name: `T${i}`, gpx, stats: {} });
    }

    const result = await a.engine.sync();

    expect(result.failed).toEqual([]);
    expect(result.pushed).toBe(3);
    // The budget sized the batches correctly up front — no 413 round-trip was
    // needed. (Count-only batching would have sent one oversized body first.)
    expect(server.rejections).toBe(0);
    expect(server.pushes).toBeGreaterThan(1);
    expect(await a.storage.listOutbox()).toEqual([]);

    const b = await createDevice(server);
    expect((await b.engine.sync()).pulled).toBe(3);
    expect(await b.storage.listTracks()).toHaveLength(3);
  });

  it('abandons a permanently oversized change instead of wedging the outbox', async () => {
    const server = new FakeServer();
    server.bodyLimit = 2000;
    const a = await createDevice(server, { maxPushBytes: 1500 });
    const huge = await a.storage.createTrack({
      name: 'Huge',
      gpx: '<gpx>' + 'x'.repeat(5000) + '</gpx>',
      stats: {},
    });
    await a.storage.createPlace({ name: 'Small pin', lat: 1, lng: 2 });

    const result = await a.engine.sync();

    // The oversized track is reported and dropped; the small place still lands.
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.entity).toBe('track');
    expect(result.failed[0]!.id).toBe(huge.id);
    expect(result.pushed).toBe(1);
    // The wedge fix: the outbox drains, so the next sync doesn't replay it.
    expect(await a.storage.listOutbox()).toEqual([]);
    const pushesAfterFirst = server.pushes;
    const second = await a.engine.sync();
    expect(second.failed).toEqual([]);
    expect(server.pushes).toBe(pushesAfterFirst);

    // The local record is untouched — only the upload was abandoned.
    expect(await a.storage.listTracks()).toHaveLength(1);
  });

  it('ignores local.* settings arriving from the server', async () => {
    const server = new FakeServer();
    const a = await createDevice(server);
    await a.storage.createPlace({ name: 'P', lat: 1, lng: 2 });
    await a.engine.sync();
    const cursorBefore = await a.storage.getSetting(SYNC_CURSOR_KEY);

    // A buggy or hostile server echoing a device-private key back at us.
    server.seed({
      entity: 'setting',
      id: SYNC_CURSOR_KEY,
      updatedAt: Date.now() + 10_000,
      deleted: false,
      data: { value: '999999' },
    });
    await a.engine.sync();

    expect(await a.storage.getSetting(SYNC_CURSOR_KEY)).not.toBe('999999');
    expect(Number(await a.storage.getSetting(SYNC_CURSOR_KEY))).toBeGreaterThanOrEqual(
      Number(cursorBefore),
    );
  });

  it('coalesces concurrent sync calls into one run', async () => {
    const server = new FakeServer();
    const a = await createDevice(server);
    await a.storage.createPlace({ name: 'P', lat: 1, lng: 2 });
    const [r1, r2] = await Promise.all([a.engine.sync(), a.engine.sync()]);
    expect(r1).toBe(r2);
    expect(server.pushes).toBe(1);
  });
});
