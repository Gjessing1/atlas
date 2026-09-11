import { mkdir, mkdtemp, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { registerDiagnosticsApi } from './diagnostics-api.js';

const dirs: string[] = [];

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function harness(options: Parameters<typeof registerDiagnosticsApi>[2] = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'atlas-diagnostics-'));
  dirs.push(dataDir);
  const app = Fastify();
  registerDiagnosticsApi(app, dataDir, options);
  return { app, dataDir };
}

describe('navigation diagnostics upload', () => {
  it('stores a private JSONL log and returns only a support reference', async () => {
    const { app, dataDir } = await harness({ makeReference: () => 'ABCDE-12345' });
    const log =
      '{"event":"trip-start","appVersion":"0.152.0"}\n' +
      '{"event":"gps-fix-batch","coords":{"lat":59.9,"lng":10.7}}\n';
    const response = await app.inject({
      method: 'POST',
      url: '/api/diagnostics/navigation',
      headers: { 'content-type': 'text/plain' },
      payload: log,
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ reference: 'ABCDE-12345' });
    const file = path.join(dataDir, 'diagnostics', 'ABCDE12345.jsonl');
    expect(await readFile(file, 'utf8')).toBe(log);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await app.inject({ url: '/api/diagnostics/navigation' })).statusCode).toBe(404);
    await app.close();
  });

  it('rejects arbitrary text instead of becoming a public file drop', async () => {
    const { app } = await harness();
    const response = await app.inject({
      method: 'POST',
      url: '/api/diagnostics/navigation',
      headers: { 'content-type': 'text/plain' },
      payload: 'not a navigation log',
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it('keeps uploaded logs for 90 days and removes them after', async () => {
    const now = Date.UTC(2026, 7, 5);
    const { app, dataDir } = await harness({ now: () => now, makeReference: () => 'FRESH-00001' });
    const dir = path.join(dataDir, 'diagnostics');
    await mkdir(dir);
    const daysAgo = async (name: string, days: number) => {
      const file = path.join(dir, name);
      await writeFile(file, `{"event":"${name}"}\n`);
      const date = new Date(now - days * 24 * 60 * 60 * 1000);
      await utimes(file, date, date);
      return file;
    };
    const recent = await daysAgo('RECENT.jsonl', 89);
    const old = await daysAgo('OLD.jsonl', 91);

    const response = await app.inject({
      method: 'POST',
      url: '/api/diagnostics/navigation',
      headers: { 'content-type': 'text/plain' },
      payload: '{"event":"new"}\n',
    });
    expect(response.statusCode).toBe(201);
    expect(await readFile(recent, 'utf8')).toBe('{"event":"RECENT.jsonl"}\n');
    await expect(readFile(old, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await app.close();
  });
});
