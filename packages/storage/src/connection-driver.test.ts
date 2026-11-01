import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AsyncSqliteConnection } from './connection-driver.js';
import { createConnectionDriver } from './connection-driver.js';
import { createNodeSqlDriver } from './node-driver.js';
import { serializeDriver } from './serial-driver.js';
import { AtlasStorage } from './storage.js';

/** node:sqlite behind the async surface expo-sqlite gives the Android app. */
function nodeConnection(path: string): AsyncSqliteConnection & { calls: string[] } {
  const db = new DatabaseSync(path);
  const calls: string[] = [];
  return {
    calls,
    execAsync: async (sql) => {
      calls.push(sql);
      db.exec(sql);
    },
    getAllAsync: async <T>(
      sql: string,
      params: Parameters<AsyncSqliteConnection['runAsync']>[1],
    ) => {
      calls.push(sql);
      return db.prepare(sql).all(...params) as T[];
    },
    runAsync: async (sql, params) => db.prepare(sql).run(...params),
    closeAsync: async () => db.close(),
  };
}

const journalMode = (path: string): string => {
  const db = new DatabaseSync(path);
  try {
    return String(db.prepare('PRAGMA journal_mode').get()?.['journal_mode']);
  } finally {
    db.close();
  }
};

let dir: string;
let file: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-conn-'));
  file = join(dir, 'atlas.db');
  // A database the previous version already migrated, still in the
  // rollback-journal mode every install started out in.
  const seed = new AtlasStorage(createNodeSqlDriver(file));
  await seed.init();
  await seed.close();
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('createConnectionDriver', () => {
  it('saves a setting while the old runtime still holds a read, and ends up in WAL', async () => {
    expect(journalMode(file)).toBe('delete');
    // The old runtime's connection, mid-read when the new one starts.
    const stale = new DatabaseSync(file);
    stale.exec('BEGIN');
    stale.prepare('SELECT * FROM settings').all();

    const conn = nodeConnection(file);
    // node:sqlite blocks the event loop while it waits on a lock, so the
    // release below can only land in a retry's pause — the path under test.
    const storage = new AtlasStorage(
      serializeDriver(
        await createConnectionDriver(conn, { busyTimeoutMs: 20, lockedRetryDelaysMs: [50, 50] }),
      ),
    );
    await storage.init();
    setTimeout(() => {
      stale.exec('COMMIT');
      stale.close();
    }, 10);

    await storage.setSetting('local.app.lastRunVersion', '0.263.0');

    expect(await storage.getSetting('local.app.lastRunVersion')).toBe('0.263.0');
    await storage.close();
    expect(journalMode(file)).toBe('wal');
    // The switch failed at open and was retried before the write, not given up on.
    const switches = conn.calls.filter((sql) => sql === 'PRAGMA journal_mode = WAL').length;
    expect(switches).toBeGreaterThan(1);
  });

  it('stops retrying the switch once WAL has taken', async () => {
    const conn = nodeConnection(file);
    const storage = new AtlasStorage(serializeDriver(await createConnectionDriver(conn)));
    await storage.init();
    await storage.setSetting('a', '1');
    await storage.setSetting('b', '2');
    await storage.close();
    expect(conn.calls.filter((sql) => sql === 'PRAGMA journal_mode = WAL')).toHaveLength(1);
  });

  it('reports a lock that outlasts every retry, and writes nothing', async () => {
    const stale = new DatabaseSync(file);
    stale.exec('BEGIN');
    stale.prepare('SELECT * FROM settings').all();

    const storage = new AtlasStorage(
      serializeDriver(
        await createConnectionDriver(nodeConnection(file), {
          busyTimeoutMs: 10,
          lockedRetryDelaysMs: [10],
        }),
      ),
    );
    await storage.init();
    await expect(storage.setSetting('theme', 'dark')).rejects.toThrow(/database is locked/);

    stale.exec('COMMIT');
    stale.close();
    expect(await storage.getSetting('theme')).toBeNull();
    expect(await storage.listOutbox()).toEqual([]);
    await storage.close();
  });
});
