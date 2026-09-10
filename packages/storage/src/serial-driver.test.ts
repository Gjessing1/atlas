import { describe, expect, it } from 'vitest';
import type { SqlDriver } from './driver.js';
import { createNodeSqlDriver } from './node-driver.js';
import { serializeDriver } from './serial-driver.js';
import { AtlasStorage } from './storage.js';

/**
 * A driver that fails the way Android's did: a call that starts while another
 * is in flight aborts with SQLite's `database is locked` rather than waiting.
 *
 * The `await` before the real work is the whole fixture — it is the yield point
 * `withExclusiveTransactionAsync` has between its BEGIN and its COMMIT, and
 * without one no second caller could ever get a turn to be refused.
 */
function busyOnOverlap(inner: SqlDriver): SqlDriver & { refusals: number } {
  const guard = async <T>(work: () => Promise<T>): Promise<T> => {
    if (state.inFlight) {
      state.refusals += 1;
      throw new Error('database is locked');
    }
    state.inFlight = true;
    try {
      await Promise.resolve();
      return await work();
    } finally {
      state.inFlight = false;
    }
  };
  const state = {
    inFlight: false,
    refusals: 0,
    query: (sql: string, params?: Parameters<SqlDriver['query']>[1]) =>
      guard(() => inner.query(sql, params)),
    batch: (statements: Parameters<SqlDriver['batch']>[0]) => guard(() => inner.batch(statements)),
    execScript: (sql: string) => guard(() => inner.execScript(sql)),
  };
  return state;
}

const openStorage = async (driver: SqlDriver): Promise<AtlasStorage> => {
  const storage = new AtlasStorage(driver);
  await storage.init();
  return storage;
};

describe('serializeDriver', () => {
  it('runs calls one at a time, in the order they were made', async () => {
    const order: string[] = [];
    let running = 0;
    const driver = serializeDriver({
      query: async (sql) => {
        running += 1;
        expect(running).toBe(1);
        await Promise.resolve();
        order.push(sql);
        running -= 1;
        return [];
      },
      batch: async () => undefined,
      execScript: async () => undefined,
    });

    await Promise.all([driver.query('a'), driver.query('b'), driver.query('c')]);

    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('lets a failed call reject its own caller without poisoning the queue', async () => {
    let calls = 0;
    const driver = serializeDriver({
      query: async () => {
        calls += 1;
        if (calls === 1) throw new Error('constraint failed');
        return [{ ok: 1 }];
      },
      batch: async () => undefined,
      execScript: async () => undefined,
    });

    const failing = driver.query('bad');
    const following = driver.query('good');

    await expect(failing).rejects.toThrow('constraint failed');
    await expect(following).resolves.toEqual([{ ok: 1 }]);
  });

  it('forwards optional members only when the wrapped driver has them', () => {
    const bare = serializeDriver({
      query: async () => [],
      batch: async () => undefined,
      execScript: async () => undefined,
    });
    expect(bare.pause).toBeUndefined();
    expect(bare.close).toBeUndefined();

    let closed = false;
    const closable = serializeDriver({
      query: async () => [],
      batch: async () => undefined,
      execScript: async () => undefined,
      close: async () => {
        closed = true;
      },
    });
    expect(closable.close).toBeTypeOf('function');
    return closable.close?.().then(() => expect(closed).toBe(true));
  });

  // The fixture has to bite before the fix means anything: this is the bug the
  // phone hit, reproduced on a driver that refuses overlap the same way.
  it('the unserialized driver loses a write to the overlap', async () => {
    const hostile = busyOnOverlap(createNodeSqlDriver());
    const storage = await openStorage(hostile);

    const results = await Promise.allSettled([
      storage.setSetting('map.style', 'outdoor'),
      storage.setSetting('units.speed', 'kmh'),
    ]);

    expect(results.some((r) => r.status === 'rejected')).toBe(true);
    expect(hostile.refusals).toBeGreaterThan(0);
  });

  it('keeps concurrent writes off each other on a driver that aborts on overlap', async () => {
    const hostile = busyOnOverlap(createNodeSqlDriver());
    const storage = await openStorage(serializeDriver(hostile));

    await Promise.all([
      storage.setSetting('map.style', 'outdoor'),
      storage.setSetting('units.speed', 'kmh'),
      storage.setSetting('local.sync.cursor', '42'),
    ]);

    expect(await storage.getSetting('map.style')).toBe('outdoor');
    expect(await storage.getSetting('units.speed')).toBe('kmh');
    expect(await storage.getSetting('local.sync.cursor')).toBe('42');
    expect(hostile.refusals).toBe(0);
  });

  it('keeps a read from colliding with the commit of a write', async () => {
    const hostile = busyOnOverlap(createNodeSqlDriver());
    const storage = await openStorage(serializeDriver(hostile));

    const [, value] = await Promise.all([
      storage.setSetting('map.style', 'outdoor'),
      storage.getSetting('map.style'),
    ]);

    // Ordered behind the write it was issued after, not refused by it.
    expect(value).toBe('outdoor');
    expect(hostile.refusals).toBe(0);
  });
});
