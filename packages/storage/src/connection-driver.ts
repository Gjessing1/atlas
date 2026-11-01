import type { SqlDriver, SqlRow, SqlValue } from './driver.js';

/**
 * The slice of an async SQLite connection this driver needs — expo-sqlite's
 * `SQLiteDatabase` satisfies it as-is, and tests wrap `node:sqlite` in it.
 */
export interface AsyncSqliteConnection {
  execAsync(source: string): Promise<void>;
  getAllAsync<T>(source: string, params: SqlValue[]): Promise<T[]>;
  runAsync(source: string, params: SqlValue[]): Promise<unknown>;
  closeAsync(): Promise<void>;
}

export interface ConnectionDriverOptions {
  /** How long SQLite itself waits on a lock before reporting it. */
  busyTimeoutMs?: number;
  /** Pauses before each retry of a batch that still came back locked. */
  lockedRetryDelaysMs?: number[];
}

const LOCKED = /database is locked|SQLITE_BUSY/i;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * SqlDriver over a file-backed async SQLite connection that may not be the
 * only one on its file — Android's atlas.db, over expo-sqlite. Wrap it in
 * `serializeDriver`: the queue excludes everything this runtime does, and this
 * driver handles the one thing it cannot exclude, another connection.
 *
 * One exists for a moment on every OTA restart: `Updates.reloadAsync()` starts
 * the new JS runtime while the old one's connection is still open — sometimes
 * reading. In rollback-journal mode a single reader there fails our COMMIT
 * with `database is locked`, and the first write of every new version lost
 * exactly that race. So:
 *
 * - The file runs in WAL, where readers never block a commit. The switch
 *   itself needs the file to itself, so the stale reader that makes WAL
 *   necessary is also what makes the switch fail — loudly or by quietly
 *   answering the old mode. The answer is checked, and the switch retried
 *   before every write until it takes; WAL is persistent from then on.
 * - A busy timeout waits out an overlapping writer instead of reporting it.
 * - A batch that comes back locked anyway is retried after a pause. Safe
 *   because a failed batch is rolled back whole, and needed because some
 *   lock conflicts skip the busy handler entirely; `BEGIN IMMEDIATE` removes
 *   the commonest of those (a read transaction that cannot upgrade).
 */
export async function createConnectionDriver(
  db: AsyncSqliteConnection,
  { busyTimeoutMs = 5000, lockedRetryDelaysMs = [250, 1000] }: ConnectionDriverOptions = {},
): Promise<SqlDriver> {
  let wal = false;

  const ensureWal = async (): Promise<void> => {
    if (wal) return;
    try {
      const rows = await db.getAllAsync<SqlRow>('PRAGMA journal_mode = WAL', []);
      wal = String(rows[0]?.['journal_mode']).toLowerCase() === 'wal';
    } catch {
      // Still locked: the write that follows waits on the busy timeout, and
      // the next one tries the switch again.
    }
  };

  // Busy timeout first, so the first WAL switch gets the same patience.
  await db.execAsync(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
  await ensureWal();

  const transaction = async (statements: Parameters<SqlDriver['batch']>[0]): Promise<void> => {
    await db.execAsync('BEGIN IMMEDIATE');
    try {
      for (const s of statements) await db.runAsync(s.sql, s.params ?? []);
      await db.execAsync('COMMIT');
    } catch (err) {
      try {
        await db.execAsync('ROLLBACK');
      } catch {
        // Some failures abort the transaction on their own; nothing to roll
        // back, and the error worth reporting is the one below.
      }
      throw err;
    }
  };

  return {
    query: (sql, params = []) => db.getAllAsync<SqlRow>(sql, params),
    async batch(statements) {
      for (let attempt = 0; ; attempt++) {
        await ensureWal();
        try {
          // Spelled out rather than delegated to expo's `withTransactionAsync`
          // for the rollback, which has to survive a failure that already
          // ended the transaction — expo's lets that second throw replace the
          // first, so the caller hears "cannot rollback" instead of the cause.
          await transaction(statements);
          return;
        } catch (err) {
          const delay = lockedRetryDelaysMs[attempt];
          if (delay === undefined || !LOCKED.test(String((err as Error)?.message ?? err)))
            throw err;
          await sleep(delay);
        }
      }
    },
    async execScript(sql) {
      await ensureWal();
      await db.execAsync(sql);
    },
    close: () => db.closeAsync(),
  };
}
