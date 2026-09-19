import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { POI_CATEGORIES, POI_TILE_LIMIT, type PoiResult } from '@atlas/core';

/** One (tile, category) answer as PoiSource keeps it. */
export interface PoiPairEntry {
  results: PoiResult[];
  complete: boolean;
  expires: number;
}

/** Where PoiSource keeps answers beyond its in-memory working set. */
export interface PoiPairStore {
  get(key: string, now: number): PoiPairEntry | undefined;
  set(key: string, entry: PoiPairEntry): void;
}

/**
 * Bump when a cached answer's shape changes without POI_CATEGORIES changing
 * (a new PoiResult field, a different name fallback).
 */
const RESULT_VERSION = 1;
/** Rows kept at most; beyond it, the soonest to expire go first. */
const MAX_ROWS = 1_000_000;
const SWEEP_EVERY = 500;

/**
 * What a cached answer was computed from. An answer outlives the process by
 * weeks, so a category that gains a tag (as pharmacies gained
 * `healthcare=pharmacy`) must not keep serving the answers it had without it.
 */
export function poiCacheRevision(): string {
  return createHash('sha256')
    .update(JSON.stringify({ RESULT_VERSION, POI_TILE_LIMIT, POI_CATEGORIES }))
    .digest('hex')
    .slice(0, 16);
}

/**
 * The POI cache on disk, so a deploy does not throw away a month of answers
 * and send every view back to Overpass at once.
 */
export class PoiPairDb implements PoiPairStore {
  private sets = 0;
  private readonly read;
  private readonly write;

  private constructor(private readonly db: DatabaseSync) {
    this.read = db.prepare('SELECT results, complete, expires FROM pair WHERE key = ?');
    this.write = db.prepare(
      'INSERT OR REPLACE INTO pair (key, results, complete, expires) VALUES (?, ?, ?, ?)',
    );
  }

  /** Open (or create) the cache under `dataDir`; null when the disk refuses, so POIs still work from memory. */
  static open(
    dataDir: string,
    revision = poiCacheRevision(),
    now = Date.now(),
    onError?: (error: unknown) => void,
  ): PoiPairDb | null {
    try {
      const dir = path.join(dataDir, 'poi-cache');
      mkdirSync(dir, { recursive: true });
      const db = new DatabaseSync(path.join(dir, 'pois.sqlite'));
      db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        CREATE TABLE IF NOT EXISTS meta (name TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS pair (
          key TEXT PRIMARY KEY,
          results TEXT NOT NULL,
          complete INTEGER NOT NULL,
          expires INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS pair_expires ON pair (expires);
      `);
      const stored = db.prepare("SELECT value FROM meta WHERE name = 'revision'").get() as
        { value: string } | undefined;
      if (stored?.value !== revision) {
        db.exec('DELETE FROM pair');
        db.prepare("INSERT OR REPLACE INTO meta (name, value) VALUES ('revision', ?)").run(
          revision,
        );
      }
      const store = new PoiPairDb(db);
      store.sweep(now);
      return store;
    } catch (error) {
      onError?.(error);
      return null;
    }
  }

  get(key: string, now: number): PoiPairEntry | undefined {
    const row = this.read.get(key) as
      { results: string; complete: number; expires: number } | undefined;
    if (!row || row.expires <= now) return undefined;
    return {
      results: JSON.parse(row.results) as PoiResult[],
      complete: row.complete === 1,
      expires: row.expires,
    };
  }

  set(key: string, entry: PoiPairEntry): void {
    this.write.run(key, JSON.stringify(entry.results), entry.complete ? 1 : 0, entry.expires);
    if (++this.sets % SWEEP_EVERY === 0) this.sweep(Date.now());
  }

  /** Drop expired answers, then the soonest-expiring past MAX_ROWS. */
  sweep(now: number): void {
    this.db.prepare('DELETE FROM pair WHERE expires <= ?').run(now);
    this.db
      .prepare(
        'DELETE FROM pair WHERE key IN (SELECT key FROM pair ORDER BY expires DESC LIMIT -1 OFFSET ?)',
      )
      .run(MAX_ROWS);
  }

  close(): void {
    this.db.close();
  }
}
