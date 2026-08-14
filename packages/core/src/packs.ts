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

/**
 * One layer's offline artifact — **the generic slot** the fixed kinds below
 * could never be (ROADMAP § N6's architectural note, needed for the first time
 * by § N5 → E7).
 *
 * The fixed slots each name one thing the app cannot work without, so a closed
 * union was right for them. Layer data is the opposite: it is open-ended by
 * construction (the overlay catalog grows without a client release), and one
 * layer can have several offline artifacts — a derived surface is per *target*,
 * so elg and rådyr are two archives of the same layer. Hence an array of
 * self-describing files rather than another named field.
 *
 * `bbox` is the user's rectangle, but a derived surface only exists in whole
 * z11 cells, so `cells` is what the archive actually covers and the only honest
 * answer to "can this view be drawn from disk".
 */
export interface RegionPackLayerFile extends RegionPackFile {
  /** What sort of layer data this is. Only derived potential exists today. */
  kind: 'potential';
  /** Catalog layer id — matches `LayerMeta.id`, e.g. `hunt`. */
  layer: string;
  /** The resolved option variant it was derived for, e.g. `elg`. */
  target: string;
  /** Tile zooms present in the archive; above `maxzoom` a client overzooms. */
  minzoom: number;
  maxzoom: number;
  /** The derive cells inside, as `z/x/y`. Coverage, as opposed to intent. */
  cells: string[];
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
    /**
     * Offline road-data side dataset (ROADMAP §2.1): a SQLite mirroring the
     * server's nvdb.sqlite — NVDB speed limits, dedicated turn lanes and ATK cameras clipped to the
     * region, plus OSM `highway=speed_camera` point cameras for coverage
     * outside Norway. Read in place (no unzip), same schema the backend's
     * NvdbStore uses, so speed-limit overrides and camera warnings work with no
     * network. Absent on older packs (and where a region has neither dataset).
     */
    nvdb?: RegionPackFile;
    /**
     * Outdoor overlay archive (ROADMAP §4.1/§4.4): a .pmtiles carrying the
     * cabins, gates, ramps and shelters the basemap either drops entirely or
     * hides until z14 (infrastructure/tiles/outdoor-schema.yml). Read in place
     * like the basemap, and clipped to the same bbox. Absent on packs built
     * before it existed, which simply render the basemap-only outdoor layers.
     */
    outdoor?: RegionPackFile;
    /**
     * Per-layer offline artifacts (ROADMAP § N5 → E7) — the open-ended slot
     * beside the fixed ones. Absent on every pack built before it existed, and
     * on any pack whose region carries no layer data.
     */
    layers?: RegionPackLayerFile[];
  };
}

/** One downloadable file of a pack, with the slot it came from. */
export interface RegionPackEntry {
  /**
   * Which slot this is, for messages and for telling two files apart: a fixed
   * kind (`basemap`), or `layer:<layer>:<target>` for a layer artifact.
   */
  kind: string;
  file: RegionPackFile;
}

/**
 * Every file a pack references, fixed slots and layer artifacts alike.
 *
 * Exists because `files` stopped being a flat object of optional files the
 * moment it grew an array: `Object.entries(files)` used to be a safe way to
 * walk a pack, and a client doing that would now hand an *array* to code
 * expecting a `RegionPackFile`. One helper, used by every walker on both sides,
 * is what keeps that from being rediscovered per call site.
 */
export function packFileEntries(manifest: RegionPackManifest): RegionPackEntry[] {
  const entries: RegionPackEntry[] = [];
  for (const [kind, value] of Object.entries(manifest.files)) {
    if (!value || kind === 'layers') continue;
    entries.push({ kind, file: value as RegionPackFile });
  }
  for (const file of manifest.files.layers ?? []) {
    entries.push({ kind: `layer:${file.layer}:${file.target}`, file });
  }
  return entries;
}

/**
 * Where an archive unpacks to, relative to the pack directory: its own path
 * without the `.zip`. Derived from the path rather than the slot name so a
 * layer artifact needs no naming rule of its own — and it keeps `assets.zip`
 * unpacking to `assets/`, exactly where every already-installed pack has it.
 */
export function packUnzipDir(file: RegionPackFile): string {
  return file.path.replace(/\.zip$/, '');
}

/** The layer artifact for one derived surface, if this pack carries it. */
export function packLayerFile(
  manifest: RegionPackManifest,
  layer: string,
  target: string,
): RegionPackLayerFile | undefined {
  return (manifest.files.layers ?? []).find(
    (file) => file.layer === layer && file.target === target,
  );
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
