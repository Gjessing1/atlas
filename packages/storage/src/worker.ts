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
import type { SqlRow } from './driver.js';
import type { StorageWorkerRequest, StorageWorkerResponse } from './protocol.js';

interface WorkerDb {
  exec(opts: {
    sql: string;
    bind?: unknown[];
    rowMode: 'object';
    returnValue: 'resultRows';
  }): SqlRow[];
}

const post = (msg: StorageWorkerResponse) => postMessage(msg);

async function openDatabase(fileName: string): Promise<WorkerDb> {
  const sqlite3 = await sqlite3InitModule();
  const poolUtil = await sqlite3.installOpfsSAHPoolVfs({});
  return new poolUtil.OpfsSAHPoolDb(fileName) as unknown as WorkerDb;
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
      const rows =
        request.kind === 'query'
          ? db.exec({
              sql: request.sql,
              bind: request.params.length > 0 ? request.params : undefined,
              rowMode: 'object',
              returnValue: 'resultRows',
            })
          : (db.exec({ sql: request.sql, rowMode: 'object', returnValue: 'resultRows' }), []);
      post({ type: 'result', id: request.id, rows });
    } catch (err) {
      post({ type: 'error', id: request.id, error: String(err) });
    }
  };
}
