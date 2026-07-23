import type { SyncChange } from '@atlas/storage';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPgStores } from './pg.js';

/**
 * Exercises the real Postgres store — skipped unless ATLAS_TEST_DATABASE_URL
 * points at a throwaway database (the schema is created on connect, and these
 * tests write freely). Run with:
 *
 *   ATLAS_TEST_DATABASE_URL=postgres://atlas:pw@127.0.0.1:5433/atlas_test npm test -w @atlas/backend
 */
const url = process.env.ATLAS_TEST_DATABASE_URL;

describe.skipIf(!url)('createPgStores', () => {
  let stores: Awaited<ReturnType<typeof createPgStores>>;
  let userId: string;

  beforeAll(async () => {
    stores = await createPgStores(url!);
    const email = `race-${Date.now()}@example.test`;
    const user = await stores.users.createUser(email, 'hash');
    userId = user!.id;
  });

  afterAll(async () => {
    await stores?.close();
  });

  const change = (id: string, updatedAt: number): SyncChange => ({
    entity: 'place',
    id,
    updatedAt,
    deleted: false,
    data: { name: id, lat: 1, lng: 2 },
  });

  it('reads back a user by id with its token epoch', async () => {
    const user = await stores.users.findUserById(userId);
    expect(user).toMatchObject({ id: userId, passwordHash: 'hash' });
    // Set from now() at insert, in milliseconds — the same unit the JWT carries.
    expect(user!.tokenEpoch).toBeGreaterThan(Date.now() - 60_000);
    expect(await stores.users.findUserById('00000000-0000-0000-0000-000000000000')).toBeNull();
  });

  it('updates the password hash and epoch, and deletes the account with its rows', async () => {
    const victim = await stores.users.createUser(`gone-${Date.now()}@example.test`, 'hash');
    await stores.users.updatePassword(victim!.id, 'new-hash', 4242);
    expect(await stores.users.findUserById(victim!.id)).toMatchObject({
      passwordHash: 'new-hash',
      tokenEpoch: 4242,
    });

    await stores.sync.apply(victim!.id, 'writer', [change('doomed', 1000)]);
    await stores.users.deleteUser(victim!.id);
    expect(await stores.users.findUserById(victim!.id)).toBeNull();
    // sync_records cascades — the deleted account leaves no data behind.
    const orphans = await stores.sync.changesSince(victim!.id, 0, 'reader', 10);
    expect(orphans.changes).toEqual([]);
  });

  it('applies changes and returns them to another device', async () => {
    const res = await stores.sync.apply(userId, 'writer', [change('p1', 1000)]);
    expect(res.applied).toBe(1);

    const pull = await stores.sync.changesSince(userId, 0, 'reader', 10);
    expect(pull.changes.map((c) => c.id)).toContain('p1');

    // The writer's own rows are filtered out of its pull.
    const own = await stores.sync.changesSince(userId, 0, 'writer', 10);
    expect(own.changes.map((c) => c.id)).not.toContain('p1');
  });

  it('skips older writes (last-write-wins)', async () => {
    await stores.sync.apply(userId, 'writer', [change('lww', 5000)]);
    const stale = await stores.sync.apply(userId, 'writer', [change('lww', 4000)]);
    expect(stale.applied).toBe(0);
    expect(stale.skipped).toBe(1);
  });

  it('breaks equal-stamp ties on device id, and replays stay no-ops', async () => {
    // Smaller device id first: the larger one wins the tie.
    await stores.sync.apply(userId, 'dev-a', [
      { ...change('tie', 5500), data: { name: 'from a', lat: 1, lng: 2 } },
    ]);
    const winner = await stores.sync.apply(userId, 'dev-b', [
      { ...change('tie', 5500), data: { name: 'from b', lat: 1, lng: 2 } },
    ]);
    expect(winner).toEqual({ applied: 1, skipped: 0 });

    // Reverse arrival picks the same winner: b's replay and a's late push both skip.
    expect(await stores.sync.apply(userId, 'dev-b', [change('tie', 5500)])).toMatchObject({
      applied: 0,
    });
    expect(await stores.sync.apply(userId, 'dev-a', [change('tie', 5500)])).toMatchObject({
      applied: 0,
    });

    const pull = await stores.sync.changesSince(userId, 0, 'reader', 100);
    expect(pull.changes.find((c) => c.id === 'tie')!.data).toMatchObject({ name: 'from b' });
  });

  it('applies a whole batch in one statement, including deletes and null data', async () => {
    const batch: SyncChange[] = [
      change('b1', 6000),
      change('b2', 6000),
      { entity: 'track', id: 'b3', updatedAt: 6000, deleted: true, data: null },
    ];
    const res = await stores.sync.apply(userId, 'batcher', batch);
    expect(res).toEqual({ applied: 3, skipped: 0 });

    const pull = await stores.sync.changesSince(userId, 0, 'reader', 100);
    const byId = new Map(pull.changes.map((c) => [c.id, c]));
    expect(byId.get('b1')).toMatchObject({ data: { name: 'b1' }, deleted: false });
    expect(byId.get('b3')).toMatchObject({ entity: 'track', deleted: true, data: null });
  });

  /**
   * ON CONFLICT DO UPDATE cannot touch the same row twice in one statement, so
   * `apply` collapses same-key changes before the upsert. The surviving row must
   * be the newest one, and the dropped duplicates must count as skipped.
   */
  it('collapses duplicate keys within one batch, keeping the newest', async () => {
    const res = await stores.sync.apply(userId, 'dupes', [
      { ...change('dup', 7000), data: { name: 'old', lat: 1, lng: 2 } },
      { ...change('dup', 9000), data: { name: 'new', lat: 1, lng: 2 } },
      { ...change('dup', 8000), data: { name: 'middle', lat: 1, lng: 2 } },
    ]);
    expect(res).toEqual({ applied: 1, skipped: 2 });

    const pull = await stores.sync.changesSince(userId, 0, 'reader', 100);
    const row = pull.changes.find((c) => c.id === 'dup');
    expect(row).toMatchObject({ updatedAt: 9000, data: { name: 'new' } });
  });

  /**
   * The pull-cursor skip race: `seq` is assigned by nextval at write time but
   * only becomes visible at commit, so without per-user serialization a pull can
   * read seq N+1 while seq N is still uncommitted — and then move its cursor past
   * N forever. A reader that follows its cursor while writes are in flight must
   * still end up having seen every row.
   */
  it('never skips a row when pulls interleave with concurrent writes', async () => {
    const writers = ['w1', 'w2', 'w3'];
    const perWriter = 25;
    const expected = new Set<string>();
    for (const w of writers) {
      for (let i = 0; i < perWriter; i++) expected.add(`${w}-${i}`);
    }

    let writing = true;
    const writes = Promise.all(
      writers.map(async (w) => {
        for (let i = 0; i < perWriter; i++) {
          await stores.sync.apply(userId, w, [change(`${w}-${i}`, 10_000 + i)]);
        }
      }),
    ).finally(() => {
      writing = false;
    });

    // A reader that only ever advances its cursor, exactly like SyncEngine.pull.
    const seen = new Set<string>();
    let cursor = 0;
    const read = async (): Promise<void> => {
      const page = await stores.sync.changesSince(userId, cursor, 'reader', 5);
      for (const c of page.changes) seen.add(c.id);
      cursor = page.cursor;
    };

    while (writing) await read();
    await writes;
    // Final drain, as the client would do on its next sync.
    for (let i = 0; i < 40; i++) await read();

    const missed = [...expected].filter((id) => !seen.has(id));
    expect(missed).toEqual([]);
  });
});
