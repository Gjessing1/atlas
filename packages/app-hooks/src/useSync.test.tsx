// @vitest-environment jsdom
import { AtlasStorage } from '@atlas/storage';
import type { SyncChange } from '@atlas/storage';
import { createNodeSqlDriver as createNodeDriver } from '@atlas/storage/node';
import { lwwWins } from '@atlas/sync';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SyncPlatform, SyncSession } from './useSync.js';
import { useSync } from './useSync.js';

/** Fake backend: health + auth + the LWW sync store the engine talks to. */
class FakeServer {
  syncEnabled = true;
  authorized = true;
  /** False makes fetch reject, the way an offline device fails. */
  reachable = true;
  registration: 'open' | 'invite' | 'closed' | undefined = 'open';
  password = 'pw';
  deleted = false;
  pushes = 0;
  pulls = 0;
  private rows = new Map<string, { change: SyncChange; seq: number; deviceId: string }>();
  private seq = 0;

  seed(change: SyncChange): void {
    this.rows.set(`${change.entity}|${change.id}`, { change, seq: ++this.seq, deviceId: 'other' });
  }

  get rowCount(): number {
    return this.rows.size;
  }

  readonly fetchFn: typeof fetch = (input, init) => {
    const url = new URL(String(input), 'http://server');
    if (!this.reachable) return Promise.reject(new TypeError('Failed to fetch'));
    if (url.pathname === '/api/health') {
      return Promise.resolve(
        Response.json({ status: 'ok', sync: this.syncEnabled, registration: this.registration }),
      );
    }
    if (url.pathname === '/api/auth/login' || url.pathname === '/api/auth/register') {
      const body = JSON.parse(String(init?.body)) as {
        email: string;
        password: string;
        invite?: string;
      };
      if (!this.authorized) {
        return Promise.resolve(Response.json({ error: 'invalid credentials' }, { status: 401 }));
      }
      if (url.pathname === '/api/auth/register') {
        if (this.registration === 'closed') {
          return Promise.resolve(
            Response.json({ error: 'registration is closed' }, { status: 403 }),
          );
        }
        if (this.registration === 'invite' && body.invite !== 'let-me-in') {
          return Promise.resolve(Response.json({ error: 'invalid invite code' }, { status: 403 }));
        }
      }
      return Promise.resolve(Response.json({ token: 'jwt-token', email: body.email }));
    }
    if (url.pathname === '/api/auth/password') {
      const body = JSON.parse(String(init?.body)) as {
        currentPassword: string;
        newPassword: string;
      };
      if (body.currentPassword !== this.password) {
        return Promise.resolve(Response.json({ error: 'wrong password' }, { status: 401 }));
      }
      this.password = body.newPassword;
      // The real server rotates the token epoch and hands back a replacement.
      return Promise.resolve(Response.json({ token: 'jwt-token-2', email: 'a@b.c' }));
    }
    if (url.pathname === '/api/auth/delete') {
      const body = JSON.parse(String(init?.body)) as { password: string };
      if (body.password !== this.password) {
        return Promise.resolve(Response.json({ error: 'wrong password' }, { status: 401 }));
      }
      this.deleted = true;
      this.rows.clear();
      return Promise.resolve(Response.json({ deleted: true }));
    }
    if (!this.authorized) {
      return Promise.resolve(Response.json({ error: 'nope' }, { status: 401 }));
    }
    if (url.pathname === '/api/sync/push') {
      this.pushes++;
      const body = JSON.parse(String(init?.body)) as { deviceId: string; changes: SyncChange[] };
      let applied = 0;
      let skipped = 0;
      for (const change of body.changes) {
        const key = `${change.entity}|${change.id}`;
        const existing = this.rows.get(key);
        const stored = existing
          ? { updatedAt: existing.change.updatedAt, deviceId: existing.deviceId }
          : null;
        if (lwwWins({ updatedAt: change.updatedAt, deviceId: body.deviceId }, stored)) {
          this.rows.set(key, { change, seq: ++this.seq, deviceId: body.deviceId });
          applied++;
        } else {
          skipped++;
        }
      }
      return Promise.resolve(Response.json({ applied, skipped }));
    }
    if (url.pathname === '/api/sync/pull') {
      this.pulls++;
      const since = Number(url.searchParams.get('since'));
      const device = url.searchParams.get('device');
      const all = [...this.rows.values()]
        .filter((r) => r.seq > since && r.deviceId !== device)
        .sort((a, b) => a.seq - b.seq);
      const cursor = all.length > 0 ? all[all.length - 1]!.seq : this.seq;
      return Promise.resolve(
        Response.json({ changes: all.map((r) => r.change), cursor: String(cursor), done: true }),
      );
    }
    return Promise.resolve(Response.json({ error: 'not found' }, { status: 404 }));
  };
}

interface Harness {
  server: FakeServer;
  storage: AtlasStorage;
  platform: SyncPlatform;
  onPulled: ReturnType<typeof vi.fn<() => Promise<void>>>;
  persisted: () => SyncSession | null;
}

async function createHarness(opts?: {
  session?: SyncSession | null;
  syncEnabled?: boolean;
}): Promise<Harness> {
  const server = new FakeServer();
  server.syncEnabled = opts?.syncEnabled ?? true;
  const storage = new AtlasStorage(createNodeDriver());
  await storage.init();
  let session: SyncSession | null = opts?.session ?? null;
  const platform: SyncPlatform = {
    loadSession: () => session,
    saveSession: (_storage, next) => {
      session = next;
    },
    fetchImpl: server.fetchFn,
  };
  const onPulled = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  return { server, storage, platform, onPulled, persisted: () => session };
}

const SESSION: SyncSession = { token: 'jwt-token', email: 'a@b.c' };

afterEach(() => {
  vi.useRealTimers();
});

describe('useSync', () => {
  it('reports unavailable when the server has no sync configured', async () => {
    const h = await createHarness({ syncEnabled: false });
    const { result } = renderHook(() => useSync(h.storage, h.onPulled, undefined, h.platform));
    await waitFor(() => expect(result.current.available).toBe(false));
    expect(result.current.status).toBe('unavailable');
  });

  it('restores a persisted session and syncs on start', async () => {
    const h = await createHarness({ session: SESSION });
    await h.storage.createPlace({ name: 'Home', lat: 59.9, lng: 10.7 });
    const { result } = renderHook(() => useSync(h.storage, h.onPulled, undefined, h.platform));
    await waitFor(() => expect(result.current.lastSyncAt).not.toBeNull());
    expect(result.current.email).toBe('a@b.c');
    expect(result.current.status).toBe('idle');
    expect(h.server.rowCount).toBe(1); // the local place got pushed
  });

  it('signIn stores the session, bootstraps a new account, and reports bad credentials', async () => {
    const h = await createHarness();
    await h.storage.createPlace({ name: 'Cabin', lat: 61, lng: 9 });
    const { result } = renderHook(() => useSync(h.storage, h.onPulled, undefined, h.platform));
    await waitFor(() => expect(result.current.available).toBe(true));
    expect(result.current.status).toBe('signedOut');

    h.server.authorized = false;
    let message: string | null = null;
    await act(async () => {
      message = await result.current.signIn('a@b.c', 'wrong', 'login');
    });
    expect(message).toBe('invalid credentials');

    h.server.authorized = true;
    await act(async () => {
      message = await result.current.signIn('a@b.c', 'pw', 'login');
    });
    expect(message).toBeNull();
    expect(h.persisted()).toEqual(SESSION);
    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(h.server.rowCount).toBe(1); // bootstrap pushed the pre-existing place
    expect(await h.storage.getSetting('local.sync.account')).toBe('a@b.c');
  });

  it('flags an expired session and recovers on the next successful sync', async () => {
    const h = await createHarness({ session: SESSION });
    const { result } = renderHook(() => useSync(h.storage, h.onPulled, undefined, h.platform));
    await waitFor(() => expect(result.current.status).toBe('idle'));

    h.server.authorized = false;
    act(() => result.current.syncNow());
    await waitFor(() => expect(result.current.status).toBe('authExpired'));
    expect(result.current.error).toMatch(/expired/i);

    h.server.authorized = true;
    act(() => result.current.syncNow());
    await waitFor(() => expect(result.current.status).toBe('idle'));
  });

  it('reports the pending outbox depth and drains it on a successful sync', async () => {
    const h = await createHarness({ session: SESSION });
    const { result, rerender } = renderHook(
      ({ token }: { token: number }) => useSync(h.storage, h.onPulled, token, h.platform),
      { initialProps: { token: 0 } },
    );
    await waitFor(() => expect(result.current.status).toBe('idle'));
    await waitFor(() => expect(result.current.pending).toBe(0));

    // Two local edits, made while the server is unreachable, must show up as
    // queued work rather than vanishing into a green status light.
    h.server.reachable = false;
    await act(async () => {
      await h.storage.createPlace({ name: 'A', lat: 1, lng: 1 });
      await h.storage.createPlace({ name: 'B', lat: 2, lng: 2 });
    });
    rerender({ token: 1 });
    await waitFor(() => expect(result.current.pending).toBe(2));

    h.server.reachable = true;
    act(() => result.current.syncNow());
    await waitFor(() => expect(result.current.pending).toBe(0));
  });

  it('keeps the last sync error visible after a later success', async () => {
    const h = await createHarness({ session: SESSION });
    const { result } = renderHook(() => useSync(h.storage, h.onPulled, undefined, h.platform));
    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(result.current.lastError).toBeNull();

    h.server.authorized = false;
    act(() => result.current.syncNow());
    await waitFor(() => expect(result.current.status).toBe('authExpired'));
    expect(result.current.lastError?.message).toMatch(/expired/i);

    // Recovered: `error` clears, but the record of the failure survives — a
    // sync that breaks and silently fixes itself must leave a trace.
    h.server.authorized = true;
    act(() => result.current.syncNow());
    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(result.current.error).toBeNull();
    expect(result.current.lastError?.message).toMatch(/expired/i);
    expect(result.current.lastError?.at).toBeGreaterThan(0);
  });

  it('does not log going offline as a sync problem', async () => {
    const h = await createHarness({ session: SESSION });
    const { result } = renderHook(() => useSync(h.storage, h.onPulled, undefined, h.platform));
    await waitFor(() => expect(result.current.status).toBe('idle'));

    h.server.reachable = false;
    act(() => result.current.syncNow());
    await waitFor(() => expect(result.current.status).toBe('offline'));
    expect(result.current.lastError).toBeNull();
  });

  it('reports the server registration mode and passes an invite code through', async () => {
    const h = await createHarness();
    h.server.registration = 'invite';
    const { result } = renderHook(() => useSync(h.storage, h.onPulled, undefined, h.platform));
    await waitFor(() => expect(result.current.registration).toBe('invite'));

    let message: string | null = null;
    await act(async () => {
      message = await result.current.signIn('a@b.c', 'pw', 'register');
    });
    expect(message).toBe('invalid invite code');

    await act(async () => {
      message = await result.current.signIn('a@b.c', 'pw', 'register', 'let-me-in');
    });
    expect(message).toBeNull();
  });

  it('treats a server that reports no registration mode as open', async () => {
    const h = await createHarness();
    h.server.registration = undefined; // pre-gating backend
    const { result } = renderHook(() => useSync(h.storage, h.onPulled, undefined, h.platform));
    await waitFor(() => expect(result.current.registration).toBe('open'));
  });

  it('changePassword adopts the replacement token instead of signing the device out', async () => {
    const h = await createHarness({ session: SESSION });
    const { result } = renderHook(() => useSync(h.storage, h.onPulled, undefined, h.platform));
    await waitFor(() => expect(result.current.status).toBe('idle'));

    let message: string | null = null;
    await act(async () => {
      message = await result.current.changePassword('wrong', 'new-password');
    });
    expect(message).toBe('wrong password');

    await act(async () => {
      message = await result.current.changePassword('pw', 'new-password');
    });
    expect(message).toBeNull();
    // The old token is dead server-side; the persisted session must be the new
    // one, and this device stays signed in and able to sync.
    expect(h.persisted()).toEqual({ token: 'jwt-token-2', email: 'a@b.c' });
    expect(result.current.status).not.toBe('signedOut');
    act(() => result.current.syncNow());
    await waitFor(() => expect(result.current.status).toBe('idle'));
  });

  it('deleteAccount signs out and clears the account marker, keeping local data', async () => {
    const h = await createHarness({ session: SESSION });
    await h.storage.createPlace({ name: 'Keep me', lat: 59.9, lng: 10.7 });
    const { result } = renderHook(() => useSync(h.storage, h.onPulled, undefined, h.platform));
    await waitFor(() => expect(result.current.status).toBe('idle'));

    let message: string | null = null;
    await act(async () => {
      message = await result.current.deleteAccount('wrong');
    });
    expect(message).toBe('wrong password');
    expect(result.current.status).toBe('idle');

    await act(async () => {
      message = await result.current.deleteAccount('pw');
    });
    expect(message).toBeNull();
    expect(h.server.deleted).toBe(true);
    await waitFor(() => expect(result.current.status).toBe('signedOut'));
    expect(h.persisted()).toBeNull();
    // Local data survives — deletion removes the server copy, not this device.
    expect((await h.storage.listPlaces()).map((p) => p.name)).toContain('Keep me');
    // A later sign-in must re-bootstrap rather than assume the server has it.
    expect(await h.storage.getSetting('local.sync.account')).not.toBe('a@b.c');
  });

  it('refreshes the UI after a pull and does not re-push in response (pull echo)', async () => {
    const h = await createHarness({ session: SESSION });
    h.server.seed({
      entity: 'place',
      id: 'remote-1',
      updatedAt: Date.now(),
      deleted: false,
      data: { name: 'Remote', lat: 60, lng: 10 },
    });

    let token = 0;
    const { rerender } = renderHook(
      ({ changeToken }) => useSync(h.storage, h.onPulled, changeToken, h.platform),
      { initialProps: { changeToken: token } },
    );
    // Startup sync pulls the seeded remote row and refreshes the UI.
    await waitFor(() => expect(h.onPulled).toHaveBeenCalledTimes(1));
    const pushesAfterPull = h.server.pushes;
    const pullsAfterPull = h.server.pulls;

    // The refresh bumps the change token (list identities changed) — that must
    // NOT schedule another sync cycle (an empty-outbox cycle still pulls).
    vi.useFakeTimers();
    rerender({ changeToken: ++token });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(h.server.pushes).toBe(pushesAfterPull);
    expect(h.server.pulls).toBe(pullsAfterPull);

    // A genuine local edit (mutation + token bump) does schedule the debounced push.
    await act(async () => {
      await h.storage.createPlace({ name: 'Local edit', lat: 59, lng: 10 });
    });
    rerender({ changeToken: ++token });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(h.server.pushes).toBeGreaterThan(pushesAfterPull);
    expect(h.server.rowCount).toBe(2); // remote seed + the local edit
  });
});
