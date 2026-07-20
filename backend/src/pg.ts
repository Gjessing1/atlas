import type { SyncChange } from '@atlas/storage';
import pg from 'pg';
import type { Stores, UserRecord } from './stores.js';

/**
 * Server-side persistence: PostgreSQL (+PostGIS) as the sync source of truth.
 * Sync state is one generic LWW table — each row is the latest copy of one
 * record, `seq` orders rows for incremental pulls (see @atlas/sync protocol).
 */

const SCHEMA = `
  CREATE EXTENSION IF NOT EXISTS postgis;

  CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  -- Added after the initial release; existing rows get epoch 0 (no revocation
  -- until their owner changes a password, which is the pre-existing behaviour).
  ALTER TABLE users ADD COLUMN IF NOT EXISTS token_epoch BIGINT NOT NULL DEFAULT 0;

  CREATE SEQUENCE IF NOT EXISTS sync_records_seq;

  CREATE TABLE IF NOT EXISTS sync_records (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    entity TEXT NOT NULL,
    id TEXT NOT NULL,
    updated_at BIGINT NOT NULL,
    deleted BOOLEAN NOT NULL,
    data JSONB,
    device_id TEXT NOT NULL DEFAULT '',
    seq BIGINT NOT NULL,
    PRIMARY KEY (user_id, entity, id)
  );

  CREATE INDEX IF NOT EXISTS sync_records_pull ON sync_records (user_id, seq);
`;

export async function createPgStores(
  databaseUrl: string,
): Promise<Stores & { close: () => Promise<void> }> {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  await pool.query(SCHEMA);

  /**
   * Run `fn` inside a transaction holding a per-user advisory lock.
   *
   * `seq` comes from `nextval` at write time, but rows only become *visible* at
   * commit — so without serialization a pull can read seq N+1 while the writer of
   * seq N is still uncommitted, and the client cursor then moves past N forever.
   * Writers take the lock exclusively (nextval..commit is atomic per user);
   * readers take it shared, so a pull never overlaps an in-flight write and the
   * "no gaps below MAX(seq)" assumption in changesSince actually holds.
   */
  async function withUserLock<T>(
    userId: string,
    mode: 'exclusive' | 'shared',
    fn: (client: pg.PoolClient) => Promise<T>,
  ): Promise<T> {
    const lock = mode === 'shared' ? 'pg_advisory_xact_lock_shared' : 'pg_advisory_xact_lock';
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT ${lock}(hashtextextended($1, 0))`, [userId]);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  const rowToUser = (r: Record<string, unknown>): UserRecord => ({
    id: String(r['id']),
    email: String(r['email']),
    passwordHash: String(r['password_hash']),
    tokenEpoch: Number(r['token_epoch']),
  });

  const USER_COLUMNS = 'id, email, password_hash, token_epoch';

  return {
    close: () => pool.end(),

    async ping() {
      await pool.query('SELECT 1');
    },

    users: {
      async createUser(email, passwordHash) {
        const res = await pool.query(
          `INSERT INTO users (email, password_hash, token_epoch)
           VALUES ($1, $2, (EXTRACT(EPOCH FROM now()) * 1000)::bigint)
           ON CONFLICT (email) DO NOTHING
           RETURNING ${USER_COLUMNS}`,
          [email, passwordHash],
        );
        return res.rows.length > 0 ? rowToUser(res.rows[0] as Record<string, unknown>) : null;
      },
      async findUserByEmail(email) {
        const res = await pool.query(`SELECT ${USER_COLUMNS} FROM users WHERE email = $1`, [email]);
        return res.rows.length > 0 ? rowToUser(res.rows[0] as Record<string, unknown>) : null;
      },
      async findUserById(id) {
        const res = await pool.query(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [id]);
        return res.rows.length > 0 ? rowToUser(res.rows[0] as Record<string, unknown>) : null;
      },
      async updatePassword(id, passwordHash, tokenEpoch) {
        await pool.query('UPDATE users SET password_hash = $2, token_epoch = $3 WHERE id = $1', [
          id,
          passwordHash,
          tokenEpoch,
        ]);
      },
      async deleteUser(id) {
        // sync_records has ON DELETE CASCADE, so the user's data goes too.
        await pool.query('DELETE FROM users WHERE id = $1', [id]);
      },
    },

    sync: {
      async apply(userId, deviceId, changes) {
        return withUserLock(userId, 'exclusive', async (client) => {
          let applied = 0;
          for (const c of changes) {
            // LWW guard lives in the WHERE clause: older/equal writes touch nothing.
            const res = await client.query(
              `INSERT INTO sync_records (user_id, entity, id, updated_at, deleted, data, device_id, seq)
               VALUES ($1, $2, $3, $4, $5, $6, $7, nextval('sync_records_seq'))
               ON CONFLICT (user_id, entity, id) DO UPDATE SET
                 updated_at = EXCLUDED.updated_at,
                 deleted = EXCLUDED.deleted,
                 data = EXCLUDED.data,
                 device_id = EXCLUDED.device_id,
                 seq = nextval('sync_records_seq')
               WHERE sync_records.updated_at < EXCLUDED.updated_at`,
              [userId, c.entity, c.id, c.updatedAt, c.deleted, c.data, deviceId],
            );
            applied += res.rowCount ?? 0;
          }
          return { applied, skipped: changes.length - applied };
        });
      },

      async changesSince(userId, since, deviceId, limit) {
        return withUserLock(userId, 'shared', async (client) => {
          const res = await client.query(
            `SELECT entity, id, updated_at, deleted, data, seq FROM sync_records
             WHERE user_id = $1 AND seq > $2 AND device_id <> $3
             ORDER BY seq
             LIMIT $4`,
            [userId, since, deviceId, limit + 1],
          );
          const hasMore = res.rows.length > limit;
          const page = (hasMore ? res.rows.slice(0, limit) : res.rows) as Record<string, unknown>[];
          let cursor = page.length > 0 ? Number(page[page.length - 1]!['seq']) : since;
          if (!hasMore) {
            // Advance past this device's own rows so future pulls scan nothing.
            // Safe only inside the lock: no writer can hold an uncommitted seq
            // below this MAX, so nothing can be skipped by the fast-forward.
            const max = await client.query(
              'SELECT COALESCE(MAX(seq), $2::bigint) AS max FROM sync_records WHERE user_id = $1',
              [userId, since],
            );
            cursor = Math.max(cursor, Number((max.rows[0] as { max: string }).max));
          }
          const changes: SyncChange[] = page.map((r) => ({
            entity: String(r['entity']) as SyncChange['entity'],
            id: String(r['id']),
            updatedAt: Number(r['updated_at']),
            deleted: Boolean(r['deleted']),
            data: (r['data'] as Record<string, unknown> | null) ?? null,
          }));
          return { changes, cursor, hasMore };
        });
      },
    },
  };
}
