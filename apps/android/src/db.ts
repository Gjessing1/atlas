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
 */
export async function openStorage(): Promise<AtlasStorage> {
  const db = await openDatabaseAsync('atlas.db');
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
      await db.closeAsync();
    },
  };
  const storage = new AtlasStorage(serializeDriver(driver));
  await storage.init();
  return storage;
}
