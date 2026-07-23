import { DatabaseSync } from 'node:sqlite';

import type { SqlDriver, SqlRow, SqlStatement, SqlValue } from './driver.js';

/**
 * SqlDriver over Node's built-in SQLite. Exported at `@atlas/storage/node`
 * (never from the main entry — web bundles must not resolve `node:sqlite`).
 * Used by package tests across the workspace; a future desktop/server-side
 * consumer of AtlasStorage would use it as-is.
 */
export function createNodeSqlDriver(path = ':memory:'): SqlDriver {
  const db = new DatabaseSync(path);
  return {
    query: (sql: string, params: SqlValue[] = []) =>
      Promise.resolve(db.prepare(sql).all(...params) as SqlRow[]),
    batch: (statements: SqlStatement[]) => {
      db.exec('BEGIN');
      try {
        for (const s of statements) db.prepare(s.sql).run(...(s.params ?? []));
        db.exec('COMMIT');
      } catch (err) {
        try {
          db.exec('ROLLBACK');
        } catch {
          // Some failures abort the transaction on their own; nothing to roll back.
        }
        throw err;
      }
      return Promise.resolve();
    },
    execScript: (sql: string) => {
      db.exec(sql);
      return Promise.resolve();
    },
    close: () => {
      try {
        db.close();
      } catch {
        // Closing twice is a no-op, matching the worker driver's behaviour.
      }
      return Promise.resolve();
    },
  };
}
