import type { AtlasStorage, OutboxEntry, SyncChange } from '@atlas/storage';
import type { SyncPullResponse, SyncPushRequest, SyncPushResponse } from './protocol.js';

/** Local-only settings keys the engine owns (never synced — see LOCAL_SETTING_PREFIX). */
export const SYNC_CURSOR_KEY = 'local.sync.cursor';
export const SYNC_DEVICE_KEY = 'local.sync.device';

export type SyncErrorKind = 'auth' | 'unavailable' | 'protocol';

export class SyncError extends Error {
  constructor(
    public readonly kind: SyncErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'SyncError';
  }
}

export interface SyncResult {
  /** Local changes accepted by the server. */
  pushed: number;
  /** Remote changes applied locally. */
  pulled: number;
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
  private inflight: Promise<SyncResult> | null = null;

  constructor(opts: SyncEngineOptions) {
    this.storage = opts.storage;
    this.getToken = opts.getToken;
    this.baseUrl = opts.baseUrl ?? '';
    this.fetchFn = opts.fetchFn ?? ((...args) => fetch(...args));
    this.batchSize = opts.batchSize ?? 25;
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
    const pushed = await this.push(deviceId);
    const pulled = await this.pull(deviceId);
    return { pushed, pulled };
  }

  private async push(deviceId: string): Promise<number> {
    const outbox = await this.storage.listOutbox();
    let pushed = 0;
    for (let i = 0; i < outbox.length; i += this.batchSize) {
      const batch = outbox.slice(i, i + this.batchSize);
      const changes: SyncChange[] = [];
      for (const entry of batch) {
        const change = await this.entryToChange(entry);
        if (change) changes.push(change);
      }
      if (changes.length > 0) {
        const body: SyncPushRequest = { deviceId, changes };
        await this.request<SyncPushResponse>('POST', '/api/sync/push', body);
        pushed += changes.length;
      }
      // Guarded by updated_at — entries that changed mid-push stay queued.
      await this.storage.clearOutbox(batch);
    }
    return pushed;
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
      });
    } catch (err) {
      throw new SyncError('unavailable', `sync server unreachable: ${String(err)}`);
    }
    if (res.status === 401 || res.status === 403) {
      throw new SyncError('auth', 'session expired or unauthorized');
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
