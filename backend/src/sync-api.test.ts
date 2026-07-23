import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { SyncChange } from '@atlas/storage';
import { MAX_CLOCK_SKEW_MS } from '@atlas/sync';
import type { AuthResponse, SyncPullResponse, SyncPushResponse } from '@atlas/sync';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { parseRegistrationMode } from './sync-api.js';

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
  // Auth limiting is exercised in its own test with its own app; leaving it on
  // here would make unrelated tests fail as the suite grows past the quota.
  app = await buildApp({
    dataDir,
    databaseUrl: 'memory',
    jwtSecret: 'test-secret',
    syncApi: { authRateLimit: false },
  });
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

describe('account lifecycle', () => {
  const changePassword = (token: string, currentPassword: string, newPassword: string) =>
    app.inject({
      method: 'POST',
      url: '/api/auth/password',
      headers: { authorization: `Bearer ${token}` },
      payload: { currentPassword, newPassword },
    });

  it('changes the password, revoking tokens issued before the change', async () => {
    const token = await register('rotate@example.com');

    expect((await changePassword(token, 'wrong password', 'new correct horse')).statusCode).toBe(
      401,
    );
    expect((await changePassword(token, 'correct horse', 'short')).statusCode).toBe(400);

    const res = await changePassword(token, 'correct horse', 'new correct horse');
    expect(res.statusCode).toBe(200);
    const fresh = (res.json() as AuthResponse).token;

    // The old token dies with the epoch bump; the returned one keeps this
    // device signed in, and only the new password logs in.
    const old = await app.inject({
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(old.statusCode).toBe(401);
    const still = await app.inject({
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${fresh}` },
    });
    expect(still.statusCode).toBe(200);

    const stale = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'rotate@example.com', password: 'correct horse' },
    });
    expect(stale.statusCode).toBe(401);
    const relogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'rotate@example.com', password: 'new correct horse' },
    });
    expect(relogin.statusCode).toBe(200);
  });

  it('deletes the account with its synced data and invalidates the token', async () => {
    const token = await register('bye@example.com');
    const auth = { authorization: `Bearer ${token}` };
    await app.inject({
      method: 'POST',
      url: '/api/sync/push',
      headers: auth,
      payload: { deviceId: 'dev-a', changes: [change()] },
    });

    const wrong = await app.inject({
      method: 'POST',
      url: '/api/auth/delete',
      headers: auth,
      payload: { password: 'wrong password' },
    });
    expect(wrong.statusCode).toBe(401);

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/delete',
      headers: auth,
      payload: { password: 'correct horse' },
    });
    expect(res.statusCode).toBe(200);

    // Token no longer resolves to an account, and the email is free again —
    // re-registering must not inherit the deleted account's synced rows.
    expect((await app.inject({ url: '/api/auth/me', headers: auth })).statusCode).toBe(401);
    const reborn = await register('bye@example.com');
    const pull = await app.inject({
      url: '/api/sync/pull?since=0&device=dev-b',
      headers: { authorization: `Bearer ${reborn}` },
    });
    expect((pull.json() as SyncPullResponse).changes).toEqual([]);
  });
});

describe('registration gating', () => {
  it('refuses account creation when registration is closed', async () => {
    const closed = await buildApp({
      dataDir,
      databaseUrl: 'memory',
      jwtSecret: 'test-secret',
      syncApi: { registration: 'closed', authRateLimit: false },
    });
    const res = await closed.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'nope@example.com', password: 'correct horse' },
    });
    expect(res.statusCode).toBe(403);
    expect((await closed.inject({ url: '/api/health' })).json()).toMatchObject({
      registration: 'closed',
    });
    await closed.close();
  });

  it('requires the invite code when one is configured', async () => {
    const invite = await buildApp({
      dataDir,
      databaseUrl: 'memory',
      jwtSecret: 'test-secret',
      syncApi: { inviteCode: 'let-me-in', authRateLimit: false },
    });
    // An invite code with no explicit mode implies invite-only.
    expect((await invite.inject({ url: '/api/health' })).json()).toMatchObject({
      registration: 'invite',
    });

    const missing = await invite.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'guest@example.com', password: 'correct horse' },
    });
    expect(missing.statusCode).toBe(403);

    const ok = await invite.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'guest@example.com', password: 'correct horse', invite: 'let-me-in' },
    });
    expect(ok.statusCode).toBe(200);
    await invite.close();
  });

  it('rejects an unrecognised REGISTRATION value instead of failing open', () => {
    expect(() => parseRegistrationMode('yes-please')).toThrow(/open, invite or closed/);
    expect(parseRegistrationMode(undefined)).toBeUndefined();
    expect(parseRegistrationMode(' Closed ')).toBe('closed');
  });
});

describe('auth rate limiting', () => {
  it('starts refusing auth attempts once the quota is spent', async () => {
    const limited = await buildApp({
      dataDir,
      databaseUrl: 'memory',
      jwtSecret: 'test-secret',
      syncApi: { authRateLimit: { max: 2, timeWindow: '1 minute' } },
    });
    const attempt = () =>
      limited.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'brute@example.com', password: 'guessing' },
      });

    expect((await attempt()).statusCode).toBe(401);
    expect((await attempt()).statusCode).toBe(401);
    expect((await attempt()).statusCode).toBe(429);

    // Budgets are per route, so /register still answers — documented in
    // sync-api.ts: each attack path faces the full limit on its own route.
    const other = await limited.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'brute@example.com', password: 'correct horse' },
    });
    expect(other.statusCode).toBe(200);
    await limited.close();
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

  it('breaks equal-stamp ties on device id, independent of push order', async () => {
    const token = await register('tie@example.com');
    const auth = { authorization: `Bearer ${token}` };
    const pushFrom = (deviceId: string, name: string) =>
      app.inject({
        method: 'POST',
        url: '/api/sync/push',
        headers: auth,
        payload: { deviceId, changes: [change({ id: 'tied', updatedAt: 5000, data: { name } })] },
      });

    // Smaller device id lands first; the larger one still wins the tie.
    await pushFrom('dev-a', 'From a');
    const second = await pushFrom('dev-b', 'From b');
    expect(second.json() as SyncPushResponse).toEqual({ applied: 1, skipped: 0 });

    // The reverse order picks the same winner — dev-b's replay is a no-op,
    // dev-a's late arrival is skipped.
    const replay = await pushFrom('dev-b', 'From b');
    expect(replay.json() as SyncPushResponse).toEqual({ applied: 0, skipped: 1 });
    const loser = await pushFrom('dev-a', 'From a');
    expect(loser.json() as SyncPushResponse).toEqual({ applied: 0, skipped: 1 });

    const pull = await app.inject({ url: '/api/sync/pull?since=0&device=other', headers: auth });
    const tied = (pull.json() as SyncPullResponse).changes.find((c) => c.id === 'tied');
    expect(tied!.data).toMatchObject({ name: 'From b' });
  });

  it('clamps stamps claiming to be implausibly far in the future', async () => {
    const token = await register('skew@example.com');
    const auth = { authorization: `Bearer ${token}` };
    const before = Date.now();
    await app.inject({
      method: 'POST',
      url: '/api/sync/push',
      headers: auth,
      payload: {
        deviceId: 'broken-clock',
        changes: [change({ id: 'future', updatedAt: before + 365 * 24 * 3600_000 })],
      },
    });

    const pull = await app.inject({ url: '/api/sync/pull?since=0&device=other', headers: auth });
    const stored = (pull.json() as SyncPullResponse).changes.find((c) => c.id === 'future')!;
    // Clamped to the skew window — a correctly clocked device editing a few
    // minutes later out-ranks it instead of losing for a year.
    expect(stored.updatedAt).toBeLessThanOrEqual(Date.now() + MAX_CLOCK_SKEW_MS);
    expect(stored.updatedAt).toBeGreaterThanOrEqual(before + MAX_CLOCK_SKEW_MS);
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
