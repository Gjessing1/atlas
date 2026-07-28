import type { BBox, RegionPackLayerFile, RegionPackManifest } from '@atlas/core';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { zipSync } from 'fflate';

import { CELL_MAX_TILE_ZOOM, CELL_ZOOM, cellId, cellsForBbox, type Cell } from './cells.js';
import { readManifest, tilePath } from './derive.js';
import { resolveTarget, type DeriveModel } from './models.js';

/**
 * "Keep this area offline" for a derived surface (ROADMAP § N5 → E7).
 *
 * **Nothing is derived here.** A pack is assembled only from cells that already
 * exist on disk, and that is the design rather than an optimisation: a derive
 * costs seconds against Kartverket/NVE/NIBIO per cell, so letting a download
 * button queue a few hundred of them would turn one tap into an hour of load on
 * public services. The client prepares the area the way it always does — the
 * preparation pill, which the user is already watching — and this endpoint
 * refuses, naming what is still missing, until that is done.
 *
 * That is also why the unit is *an area the user chose*, not a published region
 * pack: Nord-Norge is some six thousand cells, and a published pack carrying
 * every quarry would be days of derives and gigabytes. A permit's worth of
 * ground is the size this feature is honest at, so the cap is deliberately
 * low and stated in the refusal.
 */

/**
 * The most cells one pack may carry (~3 000 km²).
 *
 * Chosen from what the feature is *for*: a hunting or fishing area someone has
 * a permit for, not a county. At the fattest surface (hunt, ~1.2 MB a cell)
 * this is a ~38 MB download, which is a sane thing to ask of a phone on a
 * mobile connection.
 */
export const MAX_PACK_CELLS = 32;

/** How long a built pack stays on the server. Device copies are not affected. */
export const PACK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export class PotentialPackError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    /** Extra fields the client renders — how many cells are still missing. */
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export interface PotentialPackRequest {
  name?: unknown;
  bbox?: unknown;
  surfaces?: unknown;
}

/** One derived surface asked for, resolved against the model registry. */
interface Surface {
  model: DeriveModel;
  target: string;
}

function parseBbox(raw: unknown): BBox {
  const bbox = raw as BBox | undefined;
  const ok =
    bbox &&
    typeof bbox === 'object' &&
    [bbox.sw?.lat, bbox.sw?.lng, bbox.ne?.lat, bbox.ne?.lng].every(
      (v) => typeof v === 'number' && Number.isFinite(v),
    ) &&
    bbox.sw.lat < bbox.ne.lat &&
    bbox.sw.lng < bbox.ne.lng &&
    bbox.sw.lat >= -85 &&
    bbox.ne.lat <= 85 &&
    bbox.sw.lng >= -180 &&
    bbox.ne.lng <= 180;
  if (!ok) throw new PotentialPackError(400, 'invalid bounding box');
  return bbox;
}

function parseName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : '';
  if (!name || name.length > 60) {
    throw new PotentialPackError(400, 'name must be between 1 and 60 characters');
  }
  return name;
}

function parseSurfaces(raw: unknown, models: readonly DeriveModel[]): Surface[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new PotentialPackError(400, 'choose at least one surface to keep offline');
  }
  const surfaces: Surface[] = [];
  for (const entry of raw as { layer?: unknown; target?: unknown }[]) {
    const model = models.find((m) => m.layer === entry?.layer);
    if (!model) throw new PotentialPackError(404, `unknown layer: ${String(entry?.layer)}`);
    const target = resolveTarget(
      model,
      typeof entry.target === 'string' ? entry.target : undefined,
    );
    // The same surface twice would zip the same tiles into two archives.
    if (!surfaces.some((s) => s.model.layer === model.layer && s.target === target)) {
      surfaces.push({ model, target });
    }
  }
  return surfaces;
}

/** Every tile of the z11–z13 pyramid one cell owns. */
export function cellTiles(cell: Cell): { z: number; x: number; y: number }[] {
  const tiles: { z: number; x: number; y: number }[] = [];
  for (let z = CELL_ZOOM; z <= CELL_MAX_TILE_ZOOM; z++) {
    const factor = 2 ** (z - CELL_ZOOM);
    for (let ty = 0; ty < factor; ty++) {
      for (let tx = 0; tx < factor; tx++) {
        tiles.push({ z, x: cell.x * factor + tx, y: cell.y * factor + ty });
      }
    }
  }
  return tiles;
}

/**
 * A pack's id, derived from what is *in* it rather than from when it was built.
 *
 * So taking the same ground offline again replaces the pack instead of leaving
 * the user with two copies of one hillside — the device keys packs by id, and a
 * fresh `version` is all it needs to see an update.
 */
export function potentialPackId(surfaces: readonly Surface[], cells: readonly Cell[]): string {
  const digest = createHash('sha256')
    .update(
      JSON.stringify([
        surfaces.map((s) => [s.model.layer, s.target, s.model.rev]).sort(),
        cells.map(cellId).sort(),
      ]),
    )
    .digest('hex')
    .slice(0, 12);
  return `potential-${digest}`;
}

export interface PotentialPackOptions {
  /** Durable root for derived cells — the same one the derive service writes. */
  dataDir: string;
  models: readonly DeriveModel[];
  now?: () => number;
}

/**
 * Builds and serves "keep this area offline" packs. Artifacts live under
 * `<dataDir>/potential-packs/<id>/` and are swept after `PACK_TTL_MS`; a
 * device's copy is its own and outlives them.
 */
export class PotentialPackBuilder {
  readonly artifactsDir: string;
  private readonly now: () => number;

  constructor(private readonly opts: PotentialPackOptions) {
    this.artifactsDir = path.join(opts.dataDir, 'potential-packs');
    this.now = opts.now ?? Date.now;
  }

  async init(): Promise<void> {
    await mkdir(this.artifactsDir, { recursive: true });
    await this.expireOld();
  }

  /**
   * Drop packs whose time on the server has run out. Cheap: a handful of
   * directories.
   *
   * The verdict comes from each pack's own `expiresAt`, not from the file's
   * mtime: the manifest is the only record stamped by the same clock that
   * built it, and a copy or a restore would reset an mtime. A directory with
   * no readable manifest is left alone — that is a build in flight, and the
   * next build of the same id clears its staging anyway.
   */
  async expireOld(): Promise<void> {
    const now = this.now();
    for (const entry of await readdir(this.artifactsDir, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(this.artifactsDir, entry.name);
      const manifest = await readFile(path.join(dir, 'pack.json'), 'utf8')
        .then((raw) => JSON.parse(raw) as RegionPackManifest)
        .catch(() => null);
      if (manifest?.expiresAt !== undefined && manifest.expiresAt <= now) {
        await rm(dir, { recursive: true, force: true });
      }
    }
  }

  async build(request: PotentialPackRequest): Promise<RegionPackManifest> {
    const name = parseName(request.name);
    const bbox = parseBbox(request.bbox);
    const surfaces = parseSurfaces(request.surfaces, this.opts.models);

    // The full list, not the viewport's twelve: a pack that quietly kept the
    // centre-most cells of too large a rectangle would be a map with holes the
    // user was never told about.
    const cells = cellsForBbox(
      [bbox.sw.lng, bbox.sw.lat, bbox.ne.lng, bbox.ne.lat],
      Number.MAX_SAFE_INTEGER,
    );
    if (cells.length === 0) {
      throw new PotentialPackError(
        400,
        'these surfaces are derived for Norway only, and this area is outside it',
      );
    }
    if (cells.length > MAX_PACK_CELLS) {
      throw new PotentialPackError(
        400,
        `that area is too large to keep offline — it covers ${cells.length} areas and the limit is ${MAX_PACK_CELLS}`,
        { cells: cells.length, limit: MAX_PACK_CELLS },
      );
    }

    // Refuse before writing anything: a pack is only ever made of cells that
    // are already derived, so an unprepared area is the client's cue to keep
    // preparing rather than ours to start hundreds of derives.
    const missing = await this.missingCells(surfaces, cells);
    if (missing > 0) {
      throw new PotentialPackError(
        409,
        missing === cells.length * surfaces.length
          ? 'this area has not been read yet — let the map finish preparing it first'
          : `${missing} of this area's parts have not been read yet — let the map finish preparing them first`,
        { missing, ready: cells.length * surfaces.length - missing },
      );
    }

    const id = potentialPackId(surfaces, cells);
    const finalDir = path.join(this.artifactsDir, id);
    const stagingDir = `${finalDir}.staging`;
    await rm(stagingDir, { recursive: true, force: true });
    await mkdir(stagingDir, { recursive: true });
    try {
      const layers: RegionPackLayerFile[] = [];
      for (const surface of surfaces) {
        layers.push(await this.writeSurface(stagingDir, surface, cells));
      }
      const builtAt = this.now();
      const manifest: RegionPackManifest = {
        id,
        name,
        bbox,
        version: Math.floor(builtAt / 1000),
        builtAt,
        downloadBase: `/potential-packs/${id}`,
        custom: true,
        expiresAt: builtAt + PACK_TTL_MS,
        files: { layers },
      };
      await writeFile(path.join(stagingDir, 'pack.json'), JSON.stringify(manifest, null, 2));
      await rm(finalDir, { recursive: true, force: true });
      await rename(stagingDir, finalDir);
      return manifest;
    } catch (error) {
      await rm(stagingDir, { recursive: true, force: true });
      throw error;
    }
  }

  /** How many (surface, cell) pairs have no derived manifest yet. */
  private async missingCells(surfaces: Surface[], cells: Cell[]): Promise<number> {
    const checks = surfaces.flatMap((surface) =>
      cells.map((cell) =>
        readManifest(this.opts.dataDir, surface.model, surface.target, cell).then(
          (m) => m !== null,
        ),
      ),
    );
    return (await Promise.all(checks)).filter((ready) => !ready).length;
  }

  /** One surface's tiles, zipped as `<z>/<x>/<y>.png` beside the pack manifest. */
  private async writeSurface(
    stagingDir: string,
    surface: Surface,
    cells: Cell[],
  ): Promise<RegionPackLayerFile> {
    const { model, target } = surface;
    const files: Record<string, [Uint8Array, { level: 0 }]> = {};
    for (const cell of cells) {
      for (const tile of cellTiles(cell)) {
        const png = await readFile(
          tilePath(this.opts.dataDir, model, target, tile.z, tile.x, tile.y),
        ).catch(() => null);
        // A cell whose manifest exists but whose tiles were swept: leave the
        // tile out rather than fail the pack. MapLibre draws nothing for a
        // missing tile, which is exactly what an underived cell already does.
        if (png) files[`${tile.z}/${tile.x}/${tile.y}.png`] = [png, { level: 0 }];
      }
    }
    // PNGs are already deflated, so the archive stores rather than recompresses
    // — the zip is a container here, not a compressor.
    const archive = Buffer.from(zipSync(files, { level: 0 }));
    const fileName = `potential-${model.layer}-${target}.zip`;
    await writeFile(path.join(stagingDir, fileName), archive);
    return {
      path: fileName,
      bytes: archive.byteLength,
      sha256: createHash('sha256').update(archive).digest('hex'),
      kind: 'potential',
      layer: model.layer,
      target,
      minzoom: CELL_ZOOM,
      maxzoom: CELL_MAX_TILE_ZOOM,
      cells: cells.map(cellId),
    };
  }
}
