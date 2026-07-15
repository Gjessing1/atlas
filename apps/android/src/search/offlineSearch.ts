import type { SearchResult } from '@atlas/core';
import { openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';

import type { LocalPack } from '../regions/packs';

/**
 * Offline geocoding over the packs' search databases: SQLite files built by
 * infrastructure/packs/build-search-db.mjs with an FTS5 `places` table
 * (name, label, lat, lng — see that script for the schema). Used when the
 * server's /api/search is unreachable.
 */

const open = new Map<string, Promise<SQLiteDatabase>>();

function packDb(pack: LocalPack): Promise<SQLiteDatabase> {
  let db = open.get(pack.dir);
  if (!db) {
    // expo-sqlite takes a plain directory path for its second argument.
    db = openDatabaseAsync('search.sqlite', {}, pack.dir);
    open.set(pack.dir, db);
  }
  return db;
}

/** Turn free text into an FTS5 prefix query, quoting out any operator syntax. */
function ftsQuery(text: string): string | null {
  const tokens = text
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((t) => `"${t}"`);
  if (tokens.length === 0) return null;
  return `${tokens.join(' ')}*`;
}

export async function searchOffline(
  packs: LocalPack[],
  query: string,
  limit = 8,
): Promise<SearchResult[]> {
  const match = ftsQuery(query.trim());
  if (!match) return [];
  const results: SearchResult[] = [];
  for (const pack of packs.filter((p) => p.manifest.files.search)) {
    try {
      const db = await packDb(pack);
      const rows = await db.getAllAsync<{
        name: string;
        label: string;
        lat: number;
        lng: number;
      }>('SELECT name, label, lat, lng FROM places WHERE places MATCH ? ORDER BY rank LIMIT ?', [
        match,
        limit,
      ]);
      for (const row of rows) {
        results.push({
          name: row.name,
          label: row.label,
          position: { lat: Number(row.lat), lng: Number(row.lng) },
        });
      }
    } catch {
      // a bad pack database must not break search over the others
    }
  }
  return results.slice(0, limit);
}
