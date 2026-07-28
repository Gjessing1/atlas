import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assetLinks } from './applinks.js';
import { buildApp } from './app.js';

let dataDir: string;
let app: FastifyInstance;

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'atlas-applinks-test-'));
  app = await buildApp({ dataDir });
});

afterAll(async () => {
  await app.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe('assetLinks', () => {
  it('names the app package and the release fingerprint', () => {
    const [statement] = assetLinks();
    expect(statement!.relation).toEqual(['delegate_permission/common.handle_all_urls']);
    expect(statement!.target.package_name).toBe('io.gjessing.atlas');
    expect(statement!.target.sha256_cert_fingerprints[0]).toMatch(
      /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/,
    );
  });

  it('accepts an override, so a self-hoster can sign their own build', () => {
    const own = 'aa:bb:cc';
    expect(assetLinks(own)[0]!.target.sha256_cert_fingerprints).toEqual(['AA:BB:CC']);
  });

  it('takes several fingerprints, so a re-signed build verifies alongside the old one', () => {
    expect(assetLinks('aa:bb , cc:dd')[0]!.target.sha256_cert_fingerprints).toEqual([
      'AA:BB',
      'CC:DD',
    ]);
  });
});

describe('GET /.well-known/assetlinks.json', () => {
  it('serves JSON the Android verifier can read', async () => {
    const res = await app.inject({ method: 'GET', url: '/.well-known/assetlinks.json' });
    expect(res.statusCode).toBe(200);
    // Android rejects the document outright on the wrong content type — and the
    // SPA fallback would have answered with text/html.
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(JSON.parse(res.body)).toEqual(assetLinks());
  });
});
