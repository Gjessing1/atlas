import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import type { AppVersionResponse, RegionPackManifest, RegionsResponse } from '@atlas/core';
import type { FastifyInstance } from 'fastify';

/**
 * Offline content for the Android app (Phase 6):
 *
 * - Region packs: `<dataDir>/packs/<id>/pack.json` manifests plus their files
 *   (basemap.pmtiles, search.sqlite, graph.zip), produced out-of-band by
 *   infrastructure/packs/build-pack.sh. Listed at /api/regions, downloaded
 *   from /packs/<id>/<file> (range requests supported for resume).
 * - App self-update: `<dataDir>/app/version.json` naming the newest .apk in
 *   the same directory. Queried at /api/app/version, fetched from /app/<file>.
 *
 * Everything is optional: without the directories the endpoints answer with
 * empty/404 responses and the app simply hides the corresponding UI.
 */
export async function registerPacksApi(app: FastifyInstance, dataDir: string): Promise<void> {
  const packsDir = path.join(dataDir, 'packs');
  const appDir = path.join(dataDir, 'app');

  app.get('/api/regions', async (request): Promise<RegionsResponse> => {
    if (!existsSync(packsDir)) return { regions: [] };
    const regions: RegionPackManifest[] = [];
    for (const entry of await readdir(packsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifestPath = path.join(packsDir, entry.name, 'pack.json');
      try {
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as RegionPackManifest;
        // The directory is the id — a manifest can't claim someone else's URL space.
        regions.push({ ...manifest, id: entry.name });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          request.log.warn({ err, manifestPath }, 'unreadable pack manifest');
        }
      }
    }
    regions.sort((a, b) => a.name.localeCompare(b.name));
    return { regions };
  });

  if (existsSync(packsDir)) {
    await app.register(fastifyStatic, {
      root: packsDir,
      prefix: '/packs/',
      decorateReply: false,
      // Pack contents are immutable per version; clients re-check manifests instead.
      maxAge: '1h',
    });
  }

  app.get('/api/app/version', async (request, reply) => {
    try {
      const meta = JSON.parse(await readFile(path.join(appDir, 'version.json'), 'utf8')) as {
        versionCode?: number;
        versionName?: string;
        file?: string;
      };
      if (
        typeof meta.versionCode !== 'number' ||
        typeof meta.versionName !== 'string' ||
        typeof meta.file !== 'string'
      ) {
        throw new Error('version.json missing versionCode/versionName/file');
      }
      const apk = await stat(path.join(appDir, path.basename(meta.file)));
      const response: AppVersionResponse = {
        versionCode: meta.versionCode,
        versionName: meta.versionName,
        apkUrl: `/app/${path.basename(meta.file)}`,
        bytes: apk.size,
      };
      return response;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        request.log.warn({ err }, 'app version metadata unreadable');
      }
      return reply.code(404).send({ error: 'no app build published' });
    }
  });

  if (existsSync(appDir)) {
    await app.register(fastifyStatic, {
      root: appDir,
      prefix: '/app/',
      decorateReply: false,
      allowedPath: (pathname) => pathname.endsWith('.apk'),
      maxAge: '5m',
    });
  }
}
