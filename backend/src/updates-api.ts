import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';

/**
 * Over-the-air JS updates for the Android app (expo-updates protocol,
 * https://docs.expo.dev/technical-specs/expo-updates-1/).
 *
 * Updates are `expo export` output directories published by
 * infrastructure/packs/publish-update.sh into
 * `<dataDir>/app/updates/<runtimeVersion>/<timestamp>/`. The app polls
 * /api/app/manifest on launch; when the newest export differs from what it is
 * running, it downloads just the JS bundle + changed assets (served from
 * /app/updates/... by the packs static route) — no APK reinstall. A full APK
 * (packs-api's /api/app/version flow) is only needed when native code changes,
 * which is what bumping `runtimeVersion` signals.
 */

interface ExportMetadata {
  fileMetadata: {
    android?: {
      bundle: string;
      assets: { path: string; ext: string }[];
    };
  };
}

interface UpdateAsset {
  hash: string;
  key: string;
  contentType: string;
  fileExtension?: string;
  /** Path relative to the app dir; absolutized per request. */
  urlPath: string;
}

interface BuiltUpdate {
  id: string;
  createdAt: string;
  launchAsset: UpdateAsset;
  assets: UpdateAsset[];
}

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  ttf: 'font/ttf',
  otf: 'font/otf',
  json: 'application/json',
  js: 'application/javascript',
};

/** sha256 of metadata.json, formatted as the update's UUID (per the protocol spec examples). */
function hashToUuid(hex: string): string {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

async function buildAsset(
  appDir: string,
  relPath: string,
  ext: string | null,
  isLaunchAsset: boolean,
): Promise<UpdateAsset> {
  const content = await readFile(path.join(appDir, relPath));
  return {
    hash: createHash('sha256').update(content).digest('base64url'),
    key: createHash('md5').update(content).digest('hex'),
    contentType: isLaunchAsset
      ? 'application/javascript'
      : ((ext && MIME[ext]) ?? 'application/octet-stream'),
    ...(ext ? { fileExtension: `.${ext}` } : {}),
    urlPath: `/app/${relPath}`,
  };
}

/** Exports are immutable once published, so built manifests are cached forever. */
const cache = new Map<string, Promise<BuiltUpdate>>();

function buildUpdate(appDir: string, updateRel: string): Promise<BuiltUpdate> {
  const key = path.join(appDir, updateRel);
  let built = cache.get(key);
  if (!built) {
    built = (async () => {
      const metadataPath = path.join(appDir, updateRel, 'metadata.json');
      const raw = await readFile(metadataPath);
      const metadata = JSON.parse(raw.toString('utf8')) as ExportMetadata;
      const android = metadata.fileMetadata.android;
      if (!android) throw new Error('export has no android platform');
      return {
        id: hashToUuid(createHash('sha256').update(raw).digest('hex')),
        createdAt: (await stat(metadataPath)).mtime.toISOString(),
        launchAsset: await buildAsset(appDir, `${updateRel}/${android.bundle}`, null, true),
        assets: await Promise.all(
          android.assets.map((a) => buildAsset(appDir, `${updateRel}/${a.path}`, a.ext, false)),
        ),
      };
    })();
    cache.set(key, built);
    built.catch(() => cache.delete(key));
  }
  return built;
}

/** Newest export dir for a runtime version — publish dirs are UTC timestamps, so name order is age order. */
async function latestUpdateDir(updatesDir: string, runtimeVersion: string): Promise<string | null> {
  try {
    const entries = await readdir(path.join(updatesDir, runtimeVersion), { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    return dirs[dirs.length - 1] ?? null;
  } catch {
    return null;
  }
}

/** Client origin as seen through the reverse proxy, for absolute asset URLs. */
function requestOrigin(request: FastifyRequest): string {
  const proto = (request.headers['x-forwarded-proto'] as string | undefined) ?? request.protocol;
  return `${proto}://${request.headers.host ?? 'localhost'}`;
}

function multipart(
  reply: { header: (k: string, v: string) => unknown },
  parts: [string, string][],
) {
  const boundary = 'atlas-updates-boundary';
  const body =
    parts
      .map(
        ([name, json]) =>
          `--${boundary}\r\ncontent-disposition: form-data; name="${name}"\r\n` +
          `content-type: application/json; charset=utf-8\r\n\r\n${json}\r\n`,
      )
      .join('') + `--${boundary}--\r\n`;
  reply.header('content-type', `multipart/mixed; boundary=${boundary}`);
  return body;
}

export function registerUpdatesApi(app: FastifyInstance, dataDir: string): void {
  const appDir = path.join(dataDir, 'app');
  const updatesDir = path.join(appDir, 'updates');

  app.get('/api/app/manifest', async (request, reply) => {
    const platform = request.headers['expo-platform'];
    const runtimeVersion = request.headers['expo-runtime-version'];
    const protocolVersion = Number(request.headers['expo-protocol-version'] ?? 0);
    reply.header('expo-protocol-version', String(protocolVersion));
    reply.header('expo-sfv-version', '0');
    reply.header('cache-control', 'private, max-age=0');

    if (platform !== 'android' || typeof runtimeVersion !== 'string') {
      return reply.code(400).send({ error: 'expo-platform and expo-runtime-version required' });
    }

    const dir = await latestUpdateDir(updatesDir, runtimeVersion);
    let update: BuiltUpdate | null = null;
    if (dir) {
      try {
        update = await buildUpdate(appDir, `updates/${runtimeVersion}/${dir}`);
      } catch (err) {
        request.log.warn({ err, dir }, 'unreadable update export');
      }
    }

    // Nothing newer to offer: protocol 1 has an explicit directive for it,
    // protocol 0 clients treat a 404 as "check failed / no update".
    if (!update || update.id === request.headers['expo-current-update-id']) {
      if (protocolVersion >= 1) {
        return multipart(reply, [['directive', JSON.stringify({ type: 'noUpdateAvailable' })]]);
      }
      return reply.code(404).send({ error: 'no update published' });
    }

    const origin = requestOrigin(request);
    const withUrl = ({ urlPath, ...asset }: UpdateAsset) => ({
      ...asset,
      url: `${origin}${urlPath}`,
    });
    const manifest = {
      id: update.id,
      createdAt: update.createdAt,
      runtimeVersion,
      launchAsset: withUrl(update.launchAsset),
      assets: update.assets.map(withUrl),
      metadata: {},
      extra: {},
    };
    return multipart(reply, [
      ['manifest', JSON.stringify(manifest)],
      ['extensions', JSON.stringify({ assetRequestHeaders: {} })],
    ]);
  });
}
