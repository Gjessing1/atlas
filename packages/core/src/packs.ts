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
 * could never be — needed first by derived surfaces kept offline.
 *
 * The fixed slots each name one thing the app cannot work without, so a closed
 * union was right for them. Layer data is the opposite: it is open-ended by
 * construction (the overlay catalog grows without a client release), and one
 * layer can have several offline artifacts — a derived surface is per *target*,
 * so elg and rådyr are two archives of the same layer. Hence an array of
 * self-describing files rather than another named field.
 *
 * Two kinds exist, and they answer "does this archive cover where I am
 * looking?" differently, which is why `cells` is optional:
 *
 * - `potential` — a derived surface. It exists only in whole z11 cells, so the
 *   user's rectangle is the *intent* and `cells` is the fact.
 * - `imagery` — a slab of the satellite mosaic, cut straight to the pack's
 *   rectangle. There are no cells; the pack's own `bbox` is the coverage.
 */
export interface RegionPackLayerFile extends RegionPackFile {
  /** What sort of layer data this is. */
  kind: 'potential' | 'imagery';
  /** Catalog layer id — matches `LayerMeta.id`, e.g. `hunt`. */
  layer: string;
  /**
   * The resolved option variant it was derived for, e.g. `elg`. Absent on an
   * `imagery` archive, which has no variants — one layer, one slab of ground.
   */
  target?: string;
  /** Tile zooms present in the archive; above `maxzoom` a client overzooms. */
  minzoom: number;
  maxzoom: number;
  /**
   * The derive cells inside, as `z/x/y` — coverage as opposed to intent.
   * `potential` only; an `imagery` archive is cut to the pack bbox.
   */
  cells?: string[];
}

/**
 * The manifest shape this build of the app writes and understands.
 *
 * Two numbers, because they answer different questions. `schema` is the shape
 * of the document — bumped when a field is added — and exists so a manifest can
 * be *read* honestly. `minRuntime` is the other question: which client versions
 * can actually *use* the artifacts inside. A pack whose Valhalla tiles or
 * PMTiles spec moved to a format an installed app cannot open is not a
 * download to retry, it is a pack that app must decline — quietly keeping the
 * region it already has rather than replacing it with something unreadable.
 */
export const PACK_SCHEMA_VERSION = 2;

/**
 * What this client can consume. Raised when the app gains the ability to read a
 * new artifact format, never when it merely learns a new optional field.
 */
export const PACK_RUNTIME_VERSION = 1;

/** Compatibility contract a built pack publishes about itself. */
export interface RegionPackCompat {
  /** Shape version of this manifest document (`PACK_SCHEMA_VERSION` when built). */
  schema: number;
  /** Lowest `PACK_RUNTIME_VERSION` that can read the artifacts in this pack. */
  minRuntime: number;
}

/** One master dataset a pack was cut from, as the producer read it. */
export interface RegionPackInput {
  /** Spec slot: `basemap`, `osm`, `outdoor`, `nvdb`, `admins`, `timezones`, `assets`. */
  id: string;
  /** Path relative to the producer's data dir — where it came from, not where it went. */
  path: string;
  bytes: number;
  /** Unix ms mtime of the input when it was read: the dataset's vintage. */
  modifiedAt: number;
  /** Lowercase-hex SHA-256 of the input; absent for a directory input (assets). */
  sha256?: string;
}

/** One pinned container image the build ran. */
export interface RegionPackTool {
  /** Tool slot: `pmtiles`, `osmium`, `valhalla`, `planetiler`, `cleanup`. */
  id: string;
  /** Fully qualified image reference, pinned by digest. */
  image: string;
  /** Human-readable version of the tool inside, e.g. `1.19.0`. */
  version?: string;
}

/**
 * Where a pack came from, recorded in the artifact rather than reconstructible
 * only from host state. "Offline search, map and routing disagree in this
 * region" is diagnosed by reading this: which masters, of what vintage, cut by
 * which tools, against which admin database.
 */
export interface RegionPackProvenance {
  /** The committed build spec: source id, region id, and the spec file's digest. */
  spec: { source: string; region: string; sha256: string };
  /** Host that built it — one line of "where do I look for the masters". */
  builder?: string;
  /**
   * `osmosis_replication_timestamp` of the OSM extract: when the road data was
   * current, as opposed to when this host downloaded it. The one input vintage
   * a file mtime cannot answer.
   */
  osmReplication?: string;
  inputs: RegionPackInput[];
  tools: RegionPackTool[];
  /**
   * Set on a custom pack assembled by the server's job queue: it is the named
   * published pack's own artifacts re-cut to a smaller box, so it inherits that
   * pack's inputs and tools rather than claiming a build of its own.
   */
  derivedFrom?: string;
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
  /**
   * Schema/runtime compatibility. Absent on every pack built before DR7, which
   * is why the check treats a missing contract as compatible: those packs are
   * installed and working, and the app has read them all along.
   */
  compat?: RegionPackCompat;
  /** Build inputs and tools (DR7). Absent on packs built before it existed. */
  provenance?: RegionPackProvenance;
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
     * Offline road-data side dataset: a SQLite mirroring the
     * server's nvdb.sqlite — NVDB speed limits, dedicated turn lanes and ATK cameras clipped to the
     * region, plus OSM `highway=speed_camera` point cameras for coverage
     * outside Norway. Read in place (no unzip), same schema the backend's
     * NvdbStore uses, so speed-limit overrides and camera warnings work with no
     * network. Absent on older packs (and where a region has neither dataset).
     */
    nvdb?: RegionPackFile;
    /**
     * Outdoor overlay archive: a .pmtiles carrying the
     * cabins, gates, ramps and shelters the basemap either drops entirely or
     * hides until z14 (infrastructure/tiles/outdoor-schema.yml). Read in place
     * like the basemap, and clipped to the same bbox. Absent on packs built
     * before it existed, which simply render the basemap-only outdoor layers.
     */
    outdoor?: RegionPackFile;
    /**
     * Per-layer offline artifacts — the open-ended slot
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
    // `imagery` archives carry no target, and `layer:satellite-2025:undefined`
    // would be the name the user reads while it downloads.
    entries.push({
      kind: file.target ? `layer:${file.layer}:${file.target}` : `layer:${file.layer}`,
      file,
    });
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
    (file) => file.kind === 'potential' && file.layer === layer && file.target === target,
  );
}

/** This pack's offline imagery slab for a layer, if it carries one. */
export function packImageryFile(
  manifest: RegionPackManifest,
  layer: string,
): RegionPackLayerFile | undefined {
  return (manifest.files.layers ?? []).find(
    (file) => file.kind === 'imagery' && file.layer === layer,
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

/**
 * Why this client cannot install a pack, or null when it can.
 *
 * Deliberately one-directional: a manifest with a *newer* `schema` than this
 * build knows is still installable, because every field added to the document
 * is optional by construction and the artifacts are what the app reads. What
 * makes a pack unusable is `minRuntime` — the producer's statement that the
 * files inside need a client this one is older than. Called before any download
 * starts, so an incompatible pack costs no bytes and, above all, never replaces
 * the region already installed.
 */
export function packIncompatibleReason(
  manifest: RegionPackManifest,
  runtime: number = PACK_RUNTIME_VERSION,
): string | null {
  const compat = manifest.compat;
  if (!compat) return null; // pre-DR7 pack: no contract, and it has always worked
  if (!Number.isInteger(compat.minRuntime) || compat.minRuntime < 1) {
    return `pack "${manifest.id}" declares an invalid minimum runtime (${compat.minRuntime})`;
  }
  if (compat.minRuntime > runtime) {
    return `pack "${manifest.id}" needs a newer version of Atlas (pack runtime ${compat.minRuntime}, this app reads ${runtime}) — update the app, then download it again`;
  }
  return null;
}
