/**
 * Offline region packs (Phase 6): pre-built per-region bundles the Android app
 * downloads for offline use. Built out-of-band by infrastructure/packs/
 * build-pack.sh into `<dataDir>/packs/<id>/` next to a `pack.json` manifest;
 * the backend lists manifests at /api/regions and serves the files under
 * /packs/<id>/<file> (range requests supported).
 */

import type { BBox } from './geo.js';

/** One downloadable file inside a region pack; `path` is relative to the pack dir. */
export interface RegionPackFile {
  path: string;
  bytes: number;
  /**
   * Lowercase-hex SHA-256 of the file exactly as served. Written by packs built
   * after this field was introduced; older manifests omit it, in which case a
   * client can only size-check. Lets a same-size-but-corrupt download be caught
   * before it is allowed to replace a known-good pack.
   */
  sha256?: string;
}

export interface RegionPackManifest {
  id: string;
  /** Human-readable region name, e.g. "Oslo". */
  name: string;
  bbox: BBox;
  /** Monotonic content version — bump on rebuild so clients see updates. */
  version: number;
  /** Unix ms timestamp of the pack build. */
  builtAt: number;
  /** Custom packs use their job-scoped file endpoint instead of /packs/<id>. */
  downloadBase?: string;
  /** True for a user-selected region assembled by the background job queue. */
  custom?: boolean;
  /** Job artifacts are temporary on the server; downloaded device files are not. */
  expiresAt?: number;
  files: {
    /** Vector basemap, a .pmtiles archive (MapLibre Native reads it via pmtiles://file://…). */
    basemap?: RegionPackFile;
    /** Offline search database: SQLite with an FTS5 `places` index. */
    search?: RegionPackFile;
    /** Offline routing tiles: a Valhalla tile extract (.tar, read in place). */
    routing?: RegionPackFile;
    /** Map assets (glyphs + sprites) as a zip, for offline label/icon rendering. */
    assets?: RegionPackFile;
  };
}

/** GET /api/regions */
export interface RegionsResponse {
  regions: RegionPackManifest[];
}

export type RegionPackJobStatus = 'queued' | 'extracting' | 'assembling' | 'done' | 'failed';

/** Persistent background job returned by POST/GET /api/region-jobs. */
export interface RegionPackJob {
  id: string;
  name: string;
  bbox: BBox;
  status: RegionPackJobStatus;
  progress: number;
  detail: string;
  createdAt: number;
  updatedAt: number;
  manifest?: RegionPackManifest;
  error?: string;
}

export interface CreateRegionPackJobRequest {
  name: string;
  bbox: BBox;
}
