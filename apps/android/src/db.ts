import { AtlasStorage } from '@atlas/storage';
import type { SqlDriver, SqlRow } from '@atlas/storage';
import { openDatabaseAsync } from 'expo-sqlite';
import type { SQLiteBindValue } from 'expo-sqlite';

/**
 * Open the persistent user-data database over the device's native SQLite
 * (expo-sqlite). Same storage layer as the web app; only the SqlDriver
 * differs (rule 2: apps go through the storage package, never touch the
 * database directly).
 */
export async function openStorage(): Promise<AtlasStorage> {
  const db = await openDatabaseAsync('atlas.db');
  const driver: SqlDriver = {
    async query(sql, params = []) {
      return db.getAllAsync<SqlRow>(sql, params as SQLiteBindValue[]);
    },
    async batch(statements) {
      // Exclusive so no other statement can interleave with the transaction.
      await db.withExclusiveTransactionAsync(async (txn) => {
        for (const s of statements) {
          await txn.runAsync(s.sql, (s.params ?? []) as SQLiteBindValue[]);
        }
      });
    },
    async execScript(sql) {
      await db.execAsync(sql);
    },
    async close() {
      await db.closeAsync();
    },
  };
  const storage = new AtlasStorage(driver);
  await storage.init();
  return storage;
}
