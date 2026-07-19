import type { SyncChange } from '@atlas/storage';
import { lwwWins, type SyncPullResponse, type SyncPushResponse } from '@atlas/sync';

export interface UserRecord {
  id: string;
  email: string;
  passwordHash: string;
}

export interface UserStore {
  /** Returns null when the email is already registered. */
  createUser(email: string, passwordHash: string): Promise<UserRecord | null>;
  findUserByEmail(email: string): Promise<UserRecord | null>;
}

export interface SyncStore {
  /** Apply pushed changes last-write-wins against the stored copies. */
  apply(userId: string, deviceId: string, changes: SyncChange[]): Promise<SyncPushResponse>;
  /** Changes after `since`, excluding rows last written by `deviceId`. */
  changesSince(
    userId: string,
    since: number,
    deviceId: string,
    limit: number,
  ): Promise<SyncPullResponse>;
}

export interface Stores {
  users: UserStore;
  sync: SyncStore;
  /** Cheap liveness check for the status page; resolves ok or throws. */
  ping(): Promise<void>;
}

/**
 * In-memory stores: unit tests and `DATABASE_URL=memory` dev/e2e runs.
 * Everything is lost on restart — never for production.
 */
export function createMemoryStores(): Stores {
  const users = new Map<string, UserRecord>();
  const rows = new Map<
    string,
    Map<string, { change: SyncChange; seq: number; deviceId: string }>
  >();
  let seq = 0;

  const userRows = (userId: string) => {
    let m = rows.get(userId);
    if (!m) rows.set(userId, (m = new Map()));
    return m;
  };

  return {
    ping: () => Promise.resolve(),
    users: {
      createUser(email, passwordHash) {
        if (users.has(email)) return Promise.resolve(null);
        const user: UserRecord = { id: crypto.randomUUID(), email, passwordHash };
        users.set(email, user);
        return Promise.resolve(user);
      },
      findUserByEmail(email) {
        return Promise.resolve(users.get(email) ?? null);
      },
    },
    sync: {
      apply(userId, deviceId, changes) {
        const m = userRows(userId);
        let applied = 0;
        let skipped = 0;
        for (const change of changes) {
          const key = `${change.entity}|${change.id}`;
          const existing = m.get(key);
          if (lwwWins(change.updatedAt, existing?.change.updatedAt ?? null)) {
            m.set(key, { change, seq: ++seq, deviceId });
            applied++;
          } else {
            skipped++;
          }
        }
        return Promise.resolve({ applied, skipped });
      },
      changesSince(userId, since, deviceId, limit) {
        const all = [...userRows(userId).values()]
          .filter((r) => r.seq > since && r.deviceId !== deviceId)
          .sort((a, b) => a.seq - b.seq);
        const page = all.slice(0, limit);
        const hasMore = all.length > limit;
        const maxSeq = [...userRows(userId).values()].reduce((m, r) => Math.max(m, r.seq), since);
        const cursor = hasMore ? page[page.length - 1]!.seq : maxSeq;
        return Promise.resolve({ changes: page.map((r) => r.change), cursor, hasMore });
      },
    },
  };
}
