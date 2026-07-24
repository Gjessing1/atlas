import type { LayerMeta } from '@atlas/core';
import type { FastifyInstance } from 'fastify';
import type { StatusRegistry } from '../status.js';
import type { OverlayLayer } from './catalog.js';

export interface OverlayApiOptions {
  /** Disk tile cache root (disposable volume — wipe freely). */
  cacheDir: string;
  /** Test seam: replaces the built-in Norwegian registry. */
  layers?: OverlayLayer[];
  /**
   * Vector layers appended to the /api/layers catalog. They have no upstream —
   * their `/api/overlay/:id/features` route is registered by whoever owns the
   * data (the NVDB speed-camera layer lives beside the other NVDB routes), so
   * the raster registry only lists them and never probes or proxies them.
   */
  extraMeta?: LayerMeta[];
  /** Test seam: upstream HTTP. */
  fetchImpl?: typeof fetch;
  /** Test seam: env for token gating / URL substitution. */
  env?: Record<string, string | undefined>;
  /** Health registry: each configured layer is a probed source. */
  status?: StatusRegistry;
}

/**
 * Per-registration state the tile, identify and label routes share. Built once
 * by `registerOverlayApi`; nothing here is module-level, so two app instances
 * (and two tests) never see each other's layers, caches or fetch stub.
 */
export interface OverlayContext {
  app: FastifyInstance;
  /** Configured layers, tokenless ones already dropped. */
  layers: OverlayLayer[];
  byId: Map<string, OverlayLayer>;
  fetchImpl: typeof fetch;
  env: Record<string, string | undefined>;
  cacheDir: string;
  /** Records upstream reachability for a layer on the status page. */
  record(layerId: string, ok: boolean, detail?: string): void;
}
