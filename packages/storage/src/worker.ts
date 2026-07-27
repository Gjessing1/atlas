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

/**
 * Where the SAH pool keeps its files, under the OPFS root. These are the
 * library's defaults (we install with them), named here because `poolIsFree`
 * has to look inside the directory before a pool object exists — change one and
 * you change both.
 */
const POOL_DIR = '.opfs-sahpool';
const POOL_FILES_DIR = '.opaque';

/** The pool's files are locked by another page: second, not broken. */
class PoolBusyError extends Error {
  constructor() {
    super('the local database is open in another page');
    this.name = 'PoolBusyError';
  }
}

/**
 * Whether every file in the SAH pool can be locked right now.
 *
 * The pool takes one *exclusive* sync access handle per file, so only one page
 * per origin can have the database. Learning that by letting
 * `installOpfsSAHPoolVfs` fail is the expensive way to find out: it logs a wall
 * of DOMExceptions no user can act on, and its cleanup path calls `removeVfs()`
 * — which deletes the pool directory, i.e. the user's data, and fails to do so
 * here only because the other page's handles hold it open. Asking first turns a
 * contended open into a quiet, correctly named "busy".
 *
 * Fails open: no pool on disk yet, or a directory shape we don't recognise,
 * means "install as before".
 */
async function poolIsFree(): Promise<boolean> {
  // Finding the pool and locking it fail open and closed respectively, so they
  // are deliberately separate steps: not knowing what is on disk must never be
  // reported as "another page has it", or an unrecognised layout would wedge
  // the app on a database nothing is actually holding.
  let entries: FileSystemFileHandle[];
  try {
    const root = await navigator.storage.getDirectory();
    const pool = await root.getDirectoryHandle(POOL_DIR);
    const files = await pool.getDirectoryHandle(POOL_FILES_DIR);
    entries = [];
    for await (const entry of files.values()) {
      if (entry.kind === 'file') entries.push(entry as FileSystemFileHandle);
    }
  } catch {
    return true;
  }
  const held: FileSystemSyncAccessHandle[] = [];
  try {
    // Whatever refuses us here refuses sqlite's pool the same way — it takes
    // an exclusive handle on every one of these files.
    for (const entry of entries) held.push(await entry.createSyncAccessHandle());
    return true;
  } catch {
    return false;
  } finally {
    // Held only long enough to prove they can be held.
    for (const handle of held) handle.close();
  }
}

interface OpenDatabase {
  db: WorkerDb;
  /** Close the database and give the pool's file handles back. */
  release: () => void;
}

async function openDatabase(fileName: string): Promise<OpenDatabase> {
  if (!(await poolIsFree())) throw new PoolBusyError();
  const sqlite3 = await sqlite3InitModule();
  const poolUtil = await sqlite3.installOpfsSAHPoolVfs({});
  const db = new poolUtil.OpfsSAHPoolDb(fileName) as unknown as WorkerDb;
  return {
    db,
    release: () => {
      db.close();
      // Closing the database returns its file to the pool, but the pool keeps
      // an access handle on *every* file until it is paused. Releasing them
      // here means the next opener finds them free the moment close() resolves,
      // instead of racing a worker teardown nobody can observe.
      poolUtil.pauseVfs();
    },
  };
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
  const openPromise = openDatabase(fileName);
  openPromise.then(
    () => post({ type: 'ready' }),
    (err: unknown) =>
      post({
        type: 'init-error',
        error: err instanceof Error ? err.message : String(err),
        // Says which failure this is, so the app can wait it out rather than
        // guess from the text of a DOMException.
        busy: err instanceof PoolBusyError,
      }),
  );

  onmessage = async (event: MessageEvent<StorageWorkerRequest>) => {
    const request = event.data;
    try {
      const open = await openPromise;
      const db = open.db;
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
          open.release();
          break;
      }
      post({ type: 'result', id: request.id, rows });
    } catch (err) {
      post({ type: 'error', id: request.id, error: String(err) });
    }
  };
}
