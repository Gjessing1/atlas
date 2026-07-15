import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { SyncChange } from '@atlas/storage';
import type { AuthResponse, SyncPullResponse, SyncPushResponse } from '@atlas/sync';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';

let dataDir: string;
let app: FastifyInstance;

const change = (over: Partial<SyncChange> = {}): SyncChange => ({
  entity: 'place',
  id: 'p1',
  updatedAt: 1000,
  deleted: false,
  data: { name: 'Pin', lat: 59.9, lng: 10.7, createdAt: 900 },
  ...over,
});

async function register(email: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email, password: 'correct horse' },
  });
  expect(res.statusCode).toBe(200);
  return (res.json() as AuthResponse).token;
}

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'atlas-sync-test-'));
  app = await buildApp({ dataDir, databaseUrl: 'memory', jwtSecret: 'test-secret' });
});

afterAll(async () => {
  await app.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe('auth', () => {
  it('registers, logs in, and identifies the user', async () => {
    const token = await register('lars@example.com');
    const me = await app.inject({
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.json()).toEqual({ email: 'lars@example.com' });

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'Lars@Example.com ', password: 'correct horse' },
    });
    expect(login.statusCode).toBe(200);
    expect((login.json() as AuthResponse).email).toBe('lars@example.com');
  });

  it('rejects duplicate accounts, bad credentials and weak passwords', async () => {
    await register('dup@example.com');
    const dup = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'dup@example.com', password: 'correct horse' },
    });
    expect(dup.statusCode).toBe(409);

    const wrong = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'dup@example.com', password: 'wrong password' },
    });
    expect(wrong.statusCode).toBe(401);

    const weak = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'weak@example.com', password: 'short' },
    });
    expect(weak.statusCode).toBe(400);

    const invalid = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'not-an-email', password: 'correct horse' },
    });
    expect(invalid.statusCode).toBe(400);
  });

  it('requires a token on sync routes', async () => {
    const res = await app.inject({ url: '/api/sync/pull?since=0' });
    expect(res.statusCode).toBe(401);
  });
});

describe('sync push/pull', () => {
  it('round-trips changes between devices, excluding the writer', async () => {
    const token = await register('sync@example.com');
    const auth = { authorization: `Bearer ${token}` };

    const push = await app.inject({
      method: 'POST',
      url: '/api/sync/push',
      headers: auth,
      payload: { deviceId: 'dev-a', changes: [change()] },
    });
    expect(push.statusCode).toBe(200);
    expect(push.json() as SyncPushResponse).toEqual({ applied: 1, skipped: 0 });

    // The writer itself pulls nothing back, but its cursor still advances.
    const own = await app.inject({ url: '/api/sync/pull?since=0&device=dev-a', headers: auth });
    const ownBody = own.json() as SyncPullResponse;
    expect(ownBody.changes).toEqual([]);
    expect(ownBody.cursor).toBeGreaterThan(0);

    const other = await app.inject({ url: '/api/sync/pull?since=0&device=dev-b', headers: auth });
    const body = other.json() as SyncPullResponse;
    expect(body.changes).toHaveLength(1);
    expect(body.changes[0]).toMatchObject({ entity: 'place', id: 'p1' });
    expect(body.hasMore).toBe(false);
  });

  it('applies last-write-wins on push', async () => {
    const token = await register('lww@example.com');
    const auth = { authorization: `Bearer ${token}` };
    await app.inject({
      method: 'POST',
      url: '/api/sync/push',
      headers: auth,
      payload: { deviceId: 'a', changes: [change({ updatedAt: 2000 })] },
    });
    const stale = await app.inject({
      method: 'POST',
      url: '/api/sync/push',
      headers: auth,
      payload: {
        deviceId: 'b',
        changes: [change({ updatedAt: 1500, data: { name: 'Stale' } })],
      },
    });
    expect(stale.json() as SyncPushResponse).toEqual({ applied: 0, skipped: 1 });

    const pull = await app.inject({ url: '/api/sync/pull?since=0&device=c', headers: auth });
    const body = pull.json() as SyncPullResponse;
    expect(body.changes[0]!.data).toMatchObject({ name: 'Pin' });
  });

  it('keeps users separate', async () => {
    const tokenA = await register('a@example.com');
    const tokenB = await register('b@example.com');
    await app.inject({
      method: 'POST',
      url: '/api/sync/push',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { deviceId: 'a', changes: [change({ id: 'private' })] },
    });
    const pull = await app.inject({
      url: '/api/sync/pull?since=0&device=x',
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect((pull.json() as SyncPullResponse).changes).toEqual([]);
  });

  it('rejects malformed pushes', async () => {
    const token = await register('bad@example.com');
    const auth = { authorization: `Bearer ${token}` };
    for (const payload of [
      { deviceId: 'a' },
      {
        deviceId: 'a',
        changes: [{ entity: 'nope', id: 'x', updatedAt: 1, deleted: false, data: null }],
      },
      { deviceId: 'a', changes: [change({ id: '' })] },
    ]) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/sync/push',
        headers: auth,
        payload,
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it('pages pulls with hasMore and a resumable cursor', async () => {
    const token = await register('page@example.com');
    const auth = { authorization: `Bearer ${token}` };
    const changes = Array.from({ length: 5 }, (_, i) =>
      change({ id: `p${i}`, updatedAt: 1000 + i }),
    );
    await app.inject({
      method: 'POST',
      url: '/api/sync/push',
      headers: auth,
      payload: { deviceId: 'a', changes },
    });
    const first = await app.inject({
      url: '/api/sync/pull?since=0&device=b&limit=2',
      headers: auth,
    });
    const page1 = first.json() as SyncPullResponse;
    expect(page1.changes).toHaveLength(2);
    expect(page1.hasMore).toBe(true);
    const second = await app.inject({
      url: `/api/sync/pull?since=${page1.cursor}&device=b&limit=10`,
      headers: auth,
    });
    const page2 = second.json() as SyncPullResponse;
    expect(page2.changes).toHaveLength(3);
    expect(page2.hasMore).toBe(false);
  });
});

describe('when sync is not configured', () => {
  it('has no auth routes and reports sync: false', async () => {
    const bare = await buildApp({ dataDir });
    expect((await bare.inject({ url: '/api/health' })).json()).toMatchObject({ sync: false });
    const res = await bare.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'x@example.com', password: 'correct horse' },
    });
    expect(res.statusCode).toBe(404);
    await bare.close();
  });
});
