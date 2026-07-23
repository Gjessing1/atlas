import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StorageWorkerRequest, StorageWorkerResponse } from './protocol.js';
import { createWorkerSqlDriver } from './worker-driver.js';

/** Scripted stand-in for the storage worker (no real Worker in node). */
class FakeWorker {
  onmessage: ((event: MessageEvent<StorageWorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  requests: StorageWorkerRequest[] = [];
  terminated = false;

  postMessage(msg: StorageWorkerRequest): void {
    this.requests.push(msg);
  }
  terminate(): void {
    this.terminated = true;
  }

  emit(msg: StorageWorkerResponse): void {
    this.onmessage?.({ data: msg } as MessageEvent<StorageWorkerResponse>);
  }
  crash(message: string): void {
    this.onerror?.({ message } as ErrorEvent);
  }
  asWorker(): Worker {
    return this as unknown as Worker;
  }
}

describe('createWorkerSqlDriver', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves on ready and round-trips query, batch and script requests', async () => {
    const worker = new FakeWorker();
    const ready = createWorkerSqlDriver(worker.asWorker());
    worker.emit({ type: 'ready' });
    const driver = await ready;

    const query = driver.query('SELECT 1', [7]);
    const batch = driver.batch([{ sql: 'INSERT', params: ['a'] }, { sql: 'UPDATE' }]);
    const script = driver.execScript('PRAGMA x');
    expect(worker.requests).toMatchObject([
      { id: 1, kind: 'query', sql: 'SELECT 1', params: [7] },
      { id: 2, kind: 'batch', statements: [{ sql: 'INSERT', params: ['a'] }, { sql: 'UPDATE' }] },
      { id: 3, kind: 'script', sql: 'PRAGMA x' },
    ]);

    worker.emit({ type: 'result', id: 1, rows: [{ n: 1 }] });
    worker.emit({ type: 'error', id: 2, error: 'constraint failed' });
    worker.emit({ type: 'result', id: 3, rows: [] });
    expect(await query).toEqual([{ n: 1 }]);
    await expect(batch).rejects.toThrow('constraint failed');
    await expect(script).resolves.toBeUndefined();
  });

  it('terminates the worker when initialisation fails', async () => {
    const worker = new FakeWorker();
    const ready = createWorkerSqlDriver(worker.asWorker());
    worker.emit({ type: 'init-error', error: 'OPFS unavailable' });
    await expect(ready).rejects.toThrow('OPFS unavailable');
    expect(worker.terminated).toBe(true);
  });

  it('rejects every in-flight request when the worker crashes', async () => {
    const worker = new FakeWorker();
    const ready = createWorkerSqlDriver(worker.asWorker());
    worker.emit({ type: 'ready' });
    const driver = await ready;

    const a = driver.query('SELECT 1');
    const b = driver.query('SELECT 2');
    worker.crash('worker blew up');
    await expect(a).rejects.toThrow('worker blew up');
    await expect(b).rejects.toThrow('worker blew up');
  });

  it('close() lets the worker close the database before terminating', async () => {
    const worker = new FakeWorker();
    const ready = createWorkerSqlDriver(worker.asWorker());
    worker.emit({ type: 'ready' });
    const driver = await ready;

    const hung = driver.query('SELECT 1');
    const closing = driver.close!();
    expect(worker.requests.at(-1)).toMatchObject({ kind: 'close' });
    expect(worker.terminated).toBe(false);
    worker.emit({ type: 'result', id: worker.requests.at(-1)!.id, rows: [] });
    await closing;
    expect(worker.terminated).toBe(true);
    await expect(hung).rejects.toThrow('terminated');
    await expect(driver.query('SELECT 2')).rejects.toThrow('closed');
  });

  it('close() terminates anyway when the worker never answers', async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const ready = createWorkerSqlDriver(worker.asWorker());
    worker.emit({ type: 'ready' });
    const driver = await ready;

    const closing = driver.close!();
    await vi.advanceTimersByTimeAsync(2100);
    await closing;
    expect(worker.terminated).toBe(true);
  });
});
