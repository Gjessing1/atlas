import type { AtlasStorage, OutboxEntry, SyncChange } from '@atlas/storage';
import type { SyncPullResponse, SyncPushRequest, SyncPushResponse } from './protocol.js';

/** Local-only settings keys the engine owns (never synced — see LOCAL_SETTING_PREFIX). */
export const SYNC_CURSOR_KEY = 'local.sync.cursor';
export const SYNC_DEVICE_KEY = 'local.sync.device';

export type SyncErrorKind = 'auth' | 'unavailable' | 'protocol' | 'too-large';

export class SyncError extends Error {
  constructor(
    public readonly kind: SyncErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'SyncError';
  }
}

/** A change the server will never accept, dropped from the outbox so it can't wedge the queue. */
export interface SyncFailure {
  entity: SyncChange['entity'];
  id: string;
  reason: string;
}

export interface SyncResult {
  /** Local changes accepted by the server. */
  pushed: number;
  /** Remote changes applied locally. */
  pulled: number;
  /** Changes abandoned as permanently un-pushable (empty on a clean sync). */
  failed: SyncFailure[];
}

export interface SyncEngineOptions {
  storage: AtlasStorage;
  /** Current JWT, or null when logged out (sync() then fails with kind 'auth'). */
  getToken: () => string | null;
  /** API origin; defaults to same-origin relative URLs. */
  baseUrl?: string;
  /** Injectable for tests and non-browser platforms. */
  fetchFn?: typeof fetch;
  /** Changes per push request / rows per pull page. */
  batchSize?: number;
  /**
   * Serialized-byte budget per push request. Payloads embed whole GPX documents,
   * so a count-only limit says nothing about request size; this keeps a batch
   * comfortably under the server's body limit (32 MB today).
   */
  maxPushBytes?: number;
  /**
   * Per-request bound in milliseconds (default 30 s — generous enough for a
   * multi-megabyte GPX push on a slow link). Without it, one half-open
   * connection leaves sync() pending forever: no error, no retry, and the
   * single-flight guard then blocks every later sync attempt too.
   */
  requestTimeoutMs?: number;
}

/**
 * Serialized size of one change. `length` counts UTF-16 units rather than UTF-8
 * bytes, so it can undercount by up to ~3x on non-ASCII text — the default
 * budget leaves enough headroom below the server limit to absorb that.
 */
function changeBytes(change: SyncChange): number {
  return JSON.stringify(change).length;
}

/**
 * The offline queue replayer: pushes the storage outbox to the server and
 * pulls newer remote state back, both last-write-wins (ARCHITECTURE.md,
 * "Synchronization Strategy"). Platform-neutral — reconnect/interval triggers
 * live in the app, which simply calls sync() again; failures leave the outbox
 * intact so the next attempt resumes where this one stopped.
 */
export class SyncEngine {
  private readonly storage: AtlasStorage;
  private readonly getToken: () => string | null;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly batchSize: number;
  private readonly maxPushBytes: number;
  private readonly requestTimeoutMs: number;
  private inflight: Promise<SyncResult> | null = null;

  constructor(opts: SyncEngineOptions) {
    this.storage = opts.storage;
    this.getToken = opts.getToken;
    this.baseUrl = opts.baseUrl ?? '';
    this.fetchFn = opts.fetchFn ?? ((...args) => fetch(...args));
    this.batchSize = opts.batchSize ?? 25;
    this.maxPushBytes = opts.maxPushBytes ?? 8 * 1024 * 1024;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 30_000;
  }

  /**
   * Push then pull. Concurrent calls coalesce into the in-flight run; a change
   * that lands mid-sync stays in the outbox and rides the next call.
   */
  sync(): Promise<SyncResult> {
    this.inflight ??= this.doSync().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  /**
   * Prepare a full-state upload: queue every local record and restart the pull
   * cursor. Call when sync becomes active for an account this device has not
   * synced before (first login, or switching accounts).
   */
  async bootstrap(): Promise<void> {
    await this.storage.enqueueFullState();
    await this.storage.setSetting(SYNC_CURSOR_KEY, '0');
  }

  private async doSync(): Promise<SyncResult> {
    const deviceId = await this.deviceId();
    const { pushed, failed } = await this.push(deviceId);
    const pulled = await this.pull(deviceId);
    return { pushed, pulled, failed };
  }

  /**
   * Drain the outbox in batches bounded by both count and serialized size.
   * Sizing matters because a track's payload embeds its whole GPX document: 25
   * large tracks (a `bootstrap()` after an import, say) can blow past the
   * server's body limit, and a rejected batch that never clears would be
   * retried identically by every later sync — a permanent wedge.
   */
  private async push(deviceId: string): Promise<{ pushed: number; failed: SyncFailure[] }> {
    const outbox = await this.storage.listOutbox();
    let pushed = 0;
    const failed: SyncFailure[] = [];

    let batch: OutboxEntry[] = [];
    let changes: SyncChange[] = [];
    let bytes = 0;

    const flush = async (): Promise<void> => {
      if (changes.length > 0) {
        const outcome = await this.sendChanges(deviceId, changes);
        pushed += outcome.pushed;
        failed.push(...outcome.failed);
      }
      // Guarded by updated_at — entries that changed mid-push stay queued.
      if (batch.length > 0) await this.storage.clearOutbox(batch);
      batch = [];
      changes = [];
      bytes = 0;
    };

    for (const entry of outbox) {
      const change = await this.entryToChange(entry);
      if (change) {
        const size = changeBytes(change);
        // Close the batch *before* adding an overflowing change; a change that
        // exceeds the budget on its own still goes out alone (sendChanges then
        // decides whether the server can take it at all).
        if (
          changes.length > 0 &&
          (changes.length >= this.batchSize || bytes + size > this.maxPushBytes)
        ) {
          await flush();
        }
        changes.push(change);
        bytes += size;
      }
      batch.push(entry);
    }
    await flush();
    return { pushed, failed };
  }

  /**
   * Push one batch, halving it on a 413 until either it fits or a lone change is
   * identified as un-pushable. That change is then abandoned (its outbox entry
   * clears with the batch) and reported, because keeping it queued would block
   * every other change behind it forever.
   */
  private async sendChanges(
    deviceId: string,
    changes: SyncChange[],
  ): Promise<{ pushed: number; failed: SyncFailure[] }> {
    const body: SyncPushRequest = { deviceId, changes };
    try {
      await this.request<SyncPushResponse>('POST', '/api/sync/push', body);
      return { pushed: changes.length, failed: [] };
    } catch (err) {
      if (!(err instanceof SyncError) || err.kind !== 'too-large') throw err;
      const only = changes[0];
      if (changes.length === 1 && only) {
        return {
          pushed: 0,
          failed: [{ entity: only.entity, id: only.id, reason: 'rejected by server as too large' }],
        };
      }
      const mid = Math.ceil(changes.length / 2);
      const head = await this.sendChanges(deviceId, changes.slice(0, mid));
      const tail = await this.sendChanges(deviceId, changes.slice(mid));
      return {
        pushed: head.pushed + tail.pushed,
        failed: [...head.failed, ...tail.failed],
      };
    }
  }

  private async entryToChange(entry: OutboxEntry): Promise<SyncChange | null> {
    if (entry.op === 'delete') {
      return {
        entity: entry.entity,
        id: entry.id,
        updatedAt: entry.updatedAt,
        deleted: true,
        data: null,
      };
    }
    const record = await this.storage.readSyncRecord(entry.entity, entry.id);
    if (record === null) return null; // record vanished since enqueue; nothing to say
    return {
      entity: entry.entity,
      id: entry.id,
      updatedAt: record.updatedAt,
      deleted: false,
      data: record.data,
    };
  }

  private async pull(deviceId: string): Promise<number> {
    let cursor = Number((await this.storage.getSetting(SYNC_CURSOR_KEY)) ?? '0') || 0;
    let applied = 0;
    for (;;) {
      const query = `since=${cursor}&device=${encodeURIComponent(deviceId)}&limit=${this.batchSize}`;
      const page = await this.request<SyncPullResponse>('GET', `/api/sync/pull?${query}`);
      for (const change of page.changes) {
        if ((await this.storage.applyRemoteChange(change)) === 'applied') applied++;
      }
      cursor = page.cursor;
      await this.storage.setSetting(SYNC_CURSOR_KEY, String(cursor));
      if (!page.hasMore) return applied;
    }
  }

  /** Stable random id for this installation, created on first use. */
  private async deviceId(): Promise<string> {
    const existing = await this.storage.getSetting(SYNC_DEVICE_KEY);
    if (existing) return existing;
    const id = crypto.randomUUID();
    await this.storage.setSetting(SYNC_DEVICE_KEY, id);
    return id;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = this.getToken();
    if (!token) throw new SyncError('auth', 'not signed in');
    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        // A timed-out request surfaces as 'unavailable' below — an expected,
        // retryable state — instead of hanging sync() (and, through the
        // single-flight guard, every later sync) forever.
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch (err) {
      throw new SyncError('unavailable', `sync server unreachable: ${String(err)}`);
    }
    if (res.status === 401 || res.status === 403) {
      throw new SyncError('auth', 'session expired or unauthorized');
    }
    if (res.status === 413) {
      throw new SyncError('too-large', 'push body rejected as too large');
    }
    if (!res.ok) {
      throw new SyncError(
        res.status >= 500 ? 'unavailable' : 'protocol',
        `sync failed (${res.status})`,
      );
    }
    try {
      return (await res.json()) as T;
    } catch {
      throw new SyncError('protocol', 'malformed sync response');
    }
  }
}
