import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';

let dataDir: string;
let app: FastifyInstance;

const BUNDLE = 'hermes-bytecode-bytes';
const ASSET = 'png-bytes';

const metadata = JSON.stringify({
  version: 0,
  bundler: 'metro',
  fileMetadata: {
    android: {
      bundle: '_expo/static/js/android/index-abc123.hbc',
      assets: [{ path: 'assets/4f2d1e', ext: 'png' }],
    },
  },
});

/** The update id the server derives: sha256 of metadata.json as a UUID. */
const hex = createHash('sha256').update(metadata).digest('hex');
const updateId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;

async function writeExport(dir: string, meta: string = metadata) {
  await mkdir(path.join(dir, '_expo/static/js/android'), { recursive: true });
  await mkdir(path.join(dir, 'assets'), { recursive: true });
  await writeFile(path.join(dir, 'metadata.json'), meta);
  await writeFile(path.join(dir, '_expo/static/js/android/index-abc123.hbc'), BUNDLE);
  await writeFile(path.join(dir, 'assets/4f2d1e'), ASSET);
}

function manifestPart(body: string): Record<string, unknown> {
  const match = /name="manifest"[^]*?\r\n\r\n([^]*?)\r\n--/.exec(body);
  if (!match) throw new Error(`no manifest part in: ${body}`);
  return JSON.parse(match[1]) as Record<string, unknown>;
}

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'atlas-updates-test-'));
  // Two exports for runtime 1 — the newer (later timestamp) one must win.
  await writeExport(
    path.join(dataDir, 'app/updates/1/20260701T000000Z'),
    metadata.replace('index-abc123', 'index-abc123'), // same content, older dir
  );
  await writeExport(path.join(dataDir, 'app/updates/1/20260716T120000Z'));
  app = await buildApp({ dataDir });
});

afterAll(async () => {
  await app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const headers = {
  'expo-platform': 'android',
  'expo-runtime-version': '1',
  'expo-protocol-version': '1',
};

describe('/api/app/manifest', () => {
  it('serves the newest export as a multipart manifest', async () => {
    const res = await app.inject({ url: '/api/app/manifest', headers });
    expect(res.statusCode).toBe(200);
    expect(res.headers['expo-protocol-version']).toBe('1');
    expect(res.headers['expo-sfv-version']).toBe('0');
    expect(res.headers['content-type']).toContain('multipart/mixed');

    const manifest = manifestPart(res.body) as {
      id: string;
      runtimeVersion: string;
      launchAsset: { url: string; hash: string; contentType: string };
      assets: { url: string; fileExtension?: string; contentType: string }[];
    };
    expect(manifest.id).toBe(updateId);
    expect(manifest.runtimeVersion).toBe('1');
    expect(manifest.launchAsset.contentType).toBe('application/javascript');
    expect(manifest.launchAsset.url).toBe(
      'http://localhost:80/app/updates/1/20260716T120000Z/_expo/static/js/android/index-abc123.hbc',
    );
    expect(manifest.launchAsset.hash).toBe(createHash('sha256').update(BUNDLE).digest('base64url'));
    expect(manifest.assets).toHaveLength(1);
    expect(manifest.assets[0].contentType).toBe('image/png');
    expect(manifest.assets[0].fileExtension).toBe('.png');
    expect(res.body).toContain('assetRequestHeaders');
  });

  it('serves the update files themselves', async () => {
    const res = await app.inject({
      url: '/app/updates/1/20260716T120000Z/_expo/static/js/android/index-abc123.hbc',
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(BUNDLE);
  });

  it('answers noUpdateAvailable when the client already runs the newest update', async () => {
    const res = await app.inject({
      url: '/api/app/manifest',
      headers: { ...headers, 'expo-current-update-id': updateId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('"noUpdateAvailable"');
    expect(res.body).not.toContain('launchAsset');
  });

  it('answers noUpdateAvailable for a runtime version with no exports', async () => {
    const res = await app.inject({
      url: '/api/app/manifest',
      headers: { ...headers, 'expo-runtime-version': '99' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('"noUpdateAvailable"');
  });

  it('404s protocol-0 clients when there is nothing to offer', async () => {
    const res = await app.inject({
      url: '/api/app/manifest',
      headers: { ...headers, 'expo-runtime-version': '99', 'expo-protocol-version': '0' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('rejects requests without platform/runtime headers', async () => {
    const res = await app.inject({ url: '/api/app/manifest' });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a runtime version that is not a plain integer', async () => {
    // The header lands in a filesystem path, so traversal must not reach the disk.
    for (const bad of ['../../../etc', '1/../../..', '1; rm -rf /', '']) {
      const res = await app.inject({
        url: '/api/app/manifest',
        headers: { ...headers, 'expo-runtime-version': bad },
      });
      expect(res.statusCode, `runtime version ${JSON.stringify(bad)}`).toBe(400);
    }
  });
});
