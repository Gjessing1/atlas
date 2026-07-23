import {
  exploreCategory,
  rankExploreResults,
  type ExploreCategoryId,
  type LatLng,
  type SearchResult,
} from '@atlas/core';

import type { LocalPack } from '../regions/packs';
import { packSearchDb } from './offlineSearch';

/**
 * Category browse over downloaded pack databases. Old packs have no `kind`
 * column and are skipped; ordinary text search remains backward-compatible.
 */
export async function exploreOffline(
  packs: LocalPack[],
  category: ExploreCategoryId,
  center: LatLng,
  radiusM: number,
): Promise<SearchResult[]> {
  const results: SearchResult[] = [];
  // A coarse degree box keeps SQLite from returning an entire country; shared
  // ranking applies the exact great-circle radius afterwards.
  const latDelta = radiusM / 111_320;
  const lngDelta = radiusM / Math.max(1, 111_320 * Math.cos((center.lat * Math.PI) / 180));
  const tags = exploreCategory(category).osmTags;
  const placeholders = tags.map(() => '?').join(',');

  for (const pack of packs.filter((item) => item.manifest.files.search)) {
    try {
      const db = await packSearchDb(pack);
      const columns = await db.getAllAsync<{ name: string }>('PRAGMA table_info(places)');
      if (!columns.some((column) => column.name === 'kind')) continue;
      const rows = await db.getAllAsync<{
        name: string;
        label: string;
        lat: number;
        lng: number;
        kind: string;
      }>(
        `SELECT name, label, lat, lng, kind
           FROM places
          WHERE kind IN (${placeholders})
            AND lat BETWEEN ? AND ?
            AND lng BETWEEN ? AND ?
          LIMIT 100`,
        [
          ...tags,
          center.lat - latDelta,
          center.lat + latDelta,
          center.lng - lngDelta,
          center.lng + lngDelta,
        ],
      );
      results.push(
        ...rows.map((row) => ({
          name: row.name,
          label: row.label,
          kind: row.kind,
          position: { lat: Number(row.lat), lng: Number(row.lng) },
        })),
      );
    } catch {
      // A damaged/old pack must not block the other downloaded regions.
    }
  }
  return rankExploreResults(results, center, radiusM);
}
