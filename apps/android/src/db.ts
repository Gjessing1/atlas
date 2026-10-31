import { AtlasStorage, serializeDriver } from '@atlas/storage';
import type { SqlDriver, SqlRow } from '@atlas/storage';
import { openDatabaseAsync } from 'expo-sqlite';
import type { SQLiteBindValue } from 'expo-sqlite';

/**
 * Open the persistent user-data database over the device's native SQLite
 * (expo-sqlite). Same storage layer as the web app; only the SqlDriver
 * differs (rule 2: apps go through the storage package, never touch the
 * database directly).
 *
 * Everything runs on **one** connection, behind {@link serializeDriver}. Those
 * two facts are the same decision: a transaction is only atomic against writes
 * it can actually exclude, and this driver's only concurrency is JavaScript's,
 * so a queue excludes all of it. The alternative on offer,
 * `withExclusiveTransactionAsync`, excludes by opening a second connection and
 * letting SQLite arbitrate — which, with no busy timeout on either side, means
 * the second of two overlapping batches aborts with `database is locked` and
 * its write is simply gone. That is what shipped until v0.202.0; it lost
 * settings quietly until `setSetting` started reporting failures, at which
 * point it started losing them loudly.
 *
 * The queue cannot exclude a connection it does not own, and one exists for a
 * moment on every OTA restart: `Updates.reloadAsync()` starts the new JS
 * runtime while the old one's connection is still open — sometimes reading.
 * In rollback-journal mode a single reader there fails our COMMIT with
 * `database is locked`, and the first write of every new version (the
 * last-run marker) lost exactly that race. So the file runs in WAL, where
 * readers never block a commit, with a busy timeout so an overlapping writer
 * is waited out rather than reported; and {@link releaseStorage} lets the
 * restart close our connection first, so it never outlives its runtime with a
 * half-run batch.
 */
let live: AtlasStorage | null = null;

export async function openStorage(): Promise<AtlasStorage> {
  const db = await openDatabaseAsync('atlas.db');
  // Busy timeout first: switching to WAL itself needs a moment alone with the
  // file. A switch that still loses (a lock held past the timeout) leaves the
  // old journal mode for this session — worth a retry next launch, not a
  // database the app cannot open. WAL is persistent once it takes.
  await db.execAsync('PRAGMA busy_timeout = 5000');
  try {
    await db.execAsync('PRAGMA journal_mode = WAL');
  } catch {
    // Retried on the next open; the busy timeout still covers this session.
  }
  const driver: SqlDriver = {
    async query(sql, params = []) {
      return db.getAllAsync<SqlRow>(sql, params as SQLiteBindValue[]);
    },
    async batch(statements) {
      // Safe on the shared connection *because* the queue holds every other
      // statement back: the interleaving expo's own `withTransactionAsync`
      // warns about cannot arise when nothing else is allowed to run until this
      // resolves. Spelled out rather than delegated to it for the rollback,
      // which has to survive a failure that already ended the transaction —
      // expo's version lets that second throw replace the first, so the caller
      // is told "cannot rollback" instead of what actually went wrong.
      await db.execAsync('BEGIN');
      try {
        for (const s of statements) {
          await db.runAsync(s.sql, (s.params ?? []) as SQLiteBindValue[]);
        }
        await db.execAsync('COMMIT');
      } catch (err) {
        try {
          await db.execAsync('ROLLBACK');
        } catch {
          // Some failures abort the transaction on their own; nothing to roll
          // back, and the error worth reporting is the one below.
        }
        throw err;
      }
    },
    async execScript(sql) {
      await db.execAsync(sql);
    },
    async close() {
      if (live === storage) live = null;
      await db.closeAsync();
    },
  };
  const storage = new AtlasStorage(serializeDriver(driver));
  await storage.init();
  live = storage;
  return storage;
}

/**
 * Close the open user-data database, after every call already queued on it.
 * For a JS restart only (the OTA relaunch): the storage handed to the app is
 * dead afterwards, and nothing reopens it in this runtime.
 */
export async function releaseStorage(): Promise<void> {
  const storage = live;
  live = null;
  await storage?.close();
}
