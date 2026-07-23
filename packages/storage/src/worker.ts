/**
 * Web Worker entry for the storage layer: hosts the SQLite-WASM instance with
 * the OPFS "SAH pool" VFS (persistent, no COOP/COEP headers required — but OPFS
 * sync access handles only exist in dedicated workers, hence this file).
 *
 * The app wraps this in its own worker module:
 *   // storage.worker.ts
 *   import { runStorageWorker } from '@atlas/storage/worker';
 *   runStorageWorker();
 */
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import type { SqlRow, SqlStatement } from './driver.js';
import type { StorageWorkerRequest, StorageWorkerResponse } from './protocol.js';

interface WorkerDb {
  exec(opts: {
    sql: string;
    bind?: unknown[];
    rowMode: 'object';
    returnValue: 'resultRows';
  }): SqlRow[];
  close(): void;
}

const post = (msg: StorageWorkerResponse) => postMessage(msg);

async function openDatabase(fileName: string): Promise<WorkerDb> {
  const sqlite3 = await sqlite3InitModule();
  const poolUtil = await sqlite3.installOpfsSAHPoolVfs({});
  return new poolUtil.OpfsSAHPoolDb(fileName) as unknown as WorkerDb;
}

function runScript(db: WorkerDb, sql: string): void {
  db.exec({ sql, rowMode: 'object', returnValue: 'resultRows' });
}

/**
 * All statements applied, or none. `db.exec` is synchronous, so the whole
 * transaction runs inside one message turn — no other request can interleave.
 */
function runBatch(db: WorkerDb, statements: SqlStatement[]): void {
  runScript(db, 'BEGIN');
  try {
    for (const s of statements) {
      db.exec({
        sql: s.sql,
        bind: s.params && s.params.length > 0 ? s.params : undefined,
        rowMode: 'object',
        returnValue: 'resultRows',
      });
    }
    runScript(db, 'COMMIT');
  } catch (err) {
    try {
      runScript(db, 'ROLLBACK');
    } catch {
      // Some failures abort the transaction on their own; nothing to roll back.
    }
    throw err;
  }
}

/** Start serving storage queries; call once from the app's worker module. */
export function runStorageWorker(fileName = '/atlas.db'): void {
  const dbPromise = openDatabase(fileName);
  dbPromise.then(
    () => post({ type: 'ready' }),
    (err: unknown) => post({ type: 'init-error', error: String(err) }),
  );

  onmessage = async (event: MessageEvent<StorageWorkerRequest>) => {
    const request = event.data;
    try {
      const db = await dbPromise;
      let rows: SqlRow[] = [];
      switch (request.kind) {
        case 'query':
          rows = db.exec({
            sql: request.sql,
            bind: request.params.length > 0 ? request.params : undefined,
            rowMode: 'object',
            returnValue: 'resultRows',
          });
          break;
        case 'batch':
          runBatch(db, request.statements);
          break;
        case 'script':
          runScript(db, request.sql);
          break;
        case 'close':
          // Releases the SAH-pool file handles before the main thread
          // terminates the worker, so a reopen in the same context succeeds.
          db.close();
          break;
      }
      post({ type: 'result', id: request.id, rows });
    } catch (err) {
      post({ type: 'error', id: request.id, error: String(err) });
    }
  };
}
