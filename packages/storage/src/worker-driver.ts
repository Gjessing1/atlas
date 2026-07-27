import type { SqlDriver, SqlRow, SqlValue } from './driver.js';
import type { StorageWorkerRequest, StorageWorkerResponse } from './protocol.js';
import { StorageUnavailableError } from './unavailable.js';

/** How long close() waits for the worker to release the database before terminating anyway. */
const CLOSE_TIMEOUT_MS = 2000;

/**
 * Main-thread SqlDriver that forwards statements to a storage worker (see
 * worker.ts). Resolves once the worker's database is open, so callers can fail
 * fast when OPFS/WASM is unavailable — and terminates the worker on a failed
 * init, so the half-started worker cannot keep holding OPFS handles.
 *
 * Failure containment: a worker crash rejects every in-flight request (not
 * just the ready promise), and `close()` asks the worker to close the SQLite
 * handle — releasing the exclusive SAH-pool locks — before terminating it.
 */
export function createWorkerSqlDriver(worker: Worker): Promise<SqlDriver> {
  let nextId = 1;
  let closed = false;
  const pending = new Map<
    number,
    { resolve: (rows: SqlRow[]) => void; reject: (e: Error) => void }
  >();

  const rejectAllPending = (error: Error): void => {
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  };

  type Request = StorageWorkerRequest extends infer R
    ? R extends { id: number }
      ? Omit<R, 'id'>
      : never
    : never;

  const send = (request: Request): Promise<SqlRow[]> =>
    new Promise((resolve, reject) => {
      if (closed) {
        reject(new Error('storage driver is closed'));
        return;
      }
      const id = nextId++;
      pending.set(id, { resolve, reject });
      worker.postMessage({ ...request, id });
    });

  const driver: SqlDriver = {
    query: (sql, params = []) => send({ kind: 'query', sql, params }),
    batch: async (statements) => {
      await send({ kind: 'batch', statements });
    },
    execScript: async (sql) => {
      await send({ kind: 'script', sql });
    },
    close: async () => {
      if (closed) return;
      // Let the worker close the database first (flushes and releases the
      // OPFS handles); a wedged worker must not make close() hang, so the
      // wait is bounded and termination happens regardless.
      await Promise.race([
        send({ kind: 'close' }).catch(() => []),
        new Promise((resolve) => setTimeout(resolve, CLOSE_TIMEOUT_MS)),
      ]);
      closed = true;
      worker.terminate();
      rejectAllPending(new Error('storage worker terminated'));
    },
  };

  return new Promise((resolveReady, rejectReady) => {
    worker.onmessage = (event: MessageEvent<StorageWorkerResponse>) => {
      const msg = event.data;
      switch (msg.type) {
        case 'ready':
          resolveReady(driver);
          break;
        case 'init-error':
          worker.terminate();
          rejectReady(
            msg.busy ? new StorageUnavailableError('busy', msg.error) : new Error(msg.error),
          );
          break;
        case 'result':
          pending.get(msg.id)?.resolve(msg.rows);
          pending.delete(msg.id);
          break;
        case 'error':
          pending.get(msg.id)?.reject(new Error(msg.error));
          pending.delete(msg.id);
          break;
      }
    };
    worker.onerror = (event) => {
      const error = new Error(`storage worker failed: ${event.message}`);
      rejectReady(error);
      rejectAllPending(error);
    };
  });
}

export type { SqlValue };
