import {
  POI_TILE_LIMIT,
  poiCategory,
  poiResultFromElement,
  poiTileBbox,
  poiTileKey,
  type OverpassPoiElement,
  type PoiTile,
  type PoiTilePair,
  type PoiTileResults,
} from '@atlas/core';
import { statSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { StatusRegistry } from './status.js';

const STATUS_ID = 'pois';
const FORMAT_VERSION = '1';
const STALE_AFTER_MS = 70 * 24 * 60 * 60_000;

type Point = readonly [number, number];

interface Coverage {
  outers: Point[][];
  holes: Point[][];
}

interface DbIdentity {
  ino: number;
  size: number;
  mtimeMs: number;
}

interface PoiRow {
  osm_type: string;
  osm_id: string;
  lat: number;
  lng: number;
  tags: string;
}

interface OpenDatabase {
  db: DatabaseSync;
  identity: DbIdentity;
  query: StatementSync;
  coverage: Coverage;
  sourceTimestamp: number;
  detail: string;
}

function sameIdentity(a: DbIdentity, b: DbIdentity): boolean {
  return a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

function pointInRing([x, y]: Point, ring: readonly Point[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function covered(point: Point, coverage: Coverage): boolean {
  return (
    coverage.outers.some((ring) => pointInRing(point, ring)) &&
    !coverage.holes.some((ring) => pointInRing(point, ring))
  );
}

function tileCenter(tile: PoiTile): Point {
  const [west, south, east, north] = poiTileBbox(tile);
  return [(west + east) / 2, (south + north) / 2];
}

function identity(file: string): DbIdentity | null {
  try {
    const stat = statSync(file);
    return { ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs };
  } catch {
    return null;
  }
}

function metadata(db: DatabaseSync): Map<string, string> {
  return new Map(
    (db.prepare('SELECT name, value FROM metadata').all() as { name: string; value: string }[]).map(
      ({ name, value }) => [name, value],
    ),
  );
}

function readableBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

/**
 * Read-only Europe POI database. The live path is statted before every request:
 * a producer can atomically replace it and the process opens the new inode
 * before closing the old one, so no restart or unavailable window is needed.
 */
export class LocalPoiSource {
  private readonly file: string;
  private opened: OpenDatabase | null = null;
  private rejected: DbIdentity | null = null;
  private replacementRejected = false;

  constructor(
    dataDir: string,
    private readonly status?: StatusRegistry,
    private readonly now: () => number = Date.now,
    private readonly onError?: (error: unknown) => void,
  ) {
    this.file = path.join(dataDir, 'poi', 'europe.sqlite');
    status?.register(STATUS_ID, 'OpenStreetMap places (local)', 'Search');
  }

  /** True only when the local database is open and this tile belongs to its extract. */
  covers(tile: PoiTile): boolean {
    this.reload();
    return this.opened !== null && covered(tileCenter(tile), this.opened.coverage);
  }

  /** Split one request with a single inode check, even when it contains hundreds of pairs. */
  partition(pairs: readonly PoiTilePair[]): { local: PoiTilePair[]; remote: PoiTilePair[] } {
    this.reload();
    const local: PoiTilePair[] = [];
    const remote: PoiTilePair[] = [];
    for (const pair of pairs) {
      (this.opened && covered(tileCenter(pair.tile), this.opened.coverage) ? local : remote).push(
        pair,
      );
    }
    return { local, remote };
  }

  get(pairs: readonly PoiTilePair[], signal?: AbortSignal): PoiTileResults[] {
    this.reload();
    const opened = this.opened;
    if (!opened) throw new Error('local POI database is unavailable');
    const answers: PoiTileResults[] = [];
    for (const pair of pairs) {
      if (signal?.aborted) throw new DOMException('The POI request was aborted', 'AbortError');
      const [west, south, east, north] = poiTileBbox(pair.tile);
      const rows = opened.query.all(
        west,
        east,
        south,
        north,
        pair.category,
        POI_TILE_LIMIT + 1,
      ) as unknown as PoiRow[];
      const category = poiCategory(pair.category);
      const results = rows
        .slice(0, POI_TILE_LIMIT)
        .map((row) =>
          poiResultFromElement(
            {
              type: row.osm_type,
              id: Number(row.osm_id),
              lat: row.lat,
              lon: row.lng,
              tags: JSON.parse(row.tags) as Record<string, string>,
            } satisfies OverpassPoiElement,
            category,
          ),
        )
        .filter((result) => result !== null);
      answers.push({
        tile: poiTileKey(pair.tile),
        category: pair.category,
        results,
        complete: rows.length <= POI_TILE_LIMIT,
      });
    }
    this.report(opened);
    return answers;
  }

  /** Refresh the file identity and freshness line for GET /api/status. */
  refreshStatus(): void {
    this.reload();
    if (this.opened) this.report(this.opened);
    else this.status?.setDetail(STATUS_ID, 'no local Europe database · using Overpass fallback');
  }

  close(): void {
    this.opened?.db.close();
    this.opened = null;
  }

  private reload(): void {
    const nextIdentity = identity(this.file);
    if (!nextIdentity) {
      if (this.opened) {
        this.status?.warn(STATUS_ID, 'local POI database disappeared; serving the last open build');
      }
      return;
    }
    if (this.opened && sameIdentity(this.opened.identity, nextIdentity)) return;
    if (this.rejected && sameIdentity(this.rejected, nextIdentity)) return;

    let next: DatabaseSync | null = null;
    try {
      next = new DatabaseSync(this.file, { readOnly: true });
      const meta = metadata(next);
      if (meta.get('format_version') !== FORMAT_VERSION) {
        throw new Error(
          `unsupported POI database format ${meta.get('format_version') ?? 'missing'}`,
        );
      }
      const coverage = JSON.parse(meta.get('coverage') ?? '') as Coverage;
      if (!coverage.outers?.length) throw new Error('POI database has no coverage polygon');
      const sourceTimestamp = Date.parse(meta.get('source_timestamp') ?? '');
      if (!Number.isFinite(sourceTimestamp))
        throw new Error('POI database has no source timestamp');
      const count = Number(meta.get('feature_count'));
      next.exec('PRAGMA query_only = ON; PRAGMA mmap_size = 268435456;');
      const query = next.prepare(`
        SELECT p.osm_type, p.osm_id, p.lat, p.lng, p.tags
        FROM poi_rtree r
        JOIN pois p ON p.id = r.id
        WHERE r.max_lng >= ? AND r.min_lng <= ?
          AND r.max_lat >= ? AND r.min_lat <= ?
          AND EXISTS (
            SELECT 1 FROM poi_categories c
            WHERE c.poi_id = p.id AND c.category_id = ?
          )
        LIMIT ?
      `);
      // Prepare alone does not catch a missing R-tree shadow table.
      query.all(0, 0, 0, 0, 'coffee', 0);
      const date = new Date(sourceTimestamp).toISOString().slice(0, 10);
      const detail = `OSM data from ${date} · ${count.toLocaleString('en')} places · ${readableBytes(nextIdentity.size)}`;
      const previous = this.opened;
      this.opened = { db: next, identity: nextIdentity, query, coverage, sourceTimestamp, detail };
      next = null;
      this.rejected = null;
      this.replacementRejected = false;
      previous?.db.close();
    } catch (error) {
      next?.close();
      this.rejected = nextIdentity;
      this.replacementRejected = true;
      this.status?.record(STATUS_ID, false, 'local database is unreadable');
      this.status?.warn(
        STATUS_ID,
        'replacement POI database was rejected; keeping the last good build',
      );
      this.onError?.(error);
    }
  }

  private report(opened: OpenDatabase): void {
    this.status?.record(STATUS_ID, true);
    this.status?.setDetail(STATUS_ID, opened.detail);
    const age = this.now() - opened.sourceTimestamp;
    const warning = this.replacementRejected
      ? 'replacement POI database was rejected; keeping the last good build'
      : age > STALE_AFTER_MS
        ? `POI data is ${Math.floor(age / 86_400_000)} days old`
        : null;
    this.status?.warn(STATUS_ID, warning);
  }
}
