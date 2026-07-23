import type { AtlasStorage } from '@atlas/storage';
import type { AuthResponse, RegistrationMode } from '@atlas/sync';
import { SyncEngine, SyncError } from '@atlas/sync';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/** Which account this device last synced with — a switch forces a re-bootstrap. */
const ACCOUNT_SETTING = 'local.sync.account';
const SYNC_INTERVAL_MS = 60_000;
/** Quiet period after a local change before pushing it. */
const DEBOUNCE_MS = 2_500;
const HEALTH_TIMEOUT_MS = 5_000;

export interface SyncSession {
  token: string;
  email: string;
}

/**
 * Platform seams for useSync. Must be referentially stable across renders
 * (module const or useMemo) — its identity gates the health probe and
 * session-restore effects.
 */
export interface SyncPlatform {
  /** Server origin, e.g. `http://host:3100`; `''` for same-origin (web). */
  baseUrl?: string;
  /** Load the persisted JWT session; called once storage is ready. */
  loadSession: (storage: AtlasStorage) => Promise<SyncSession | null> | SyncSession | null;
  /** Persist the JWT session; null clears it (sign-out). */
  saveSession: (storage: AtlasStorage, session: SyncSession | null) => void | Promise<void>;
  /**
   * Subscribe to the platform's "connectivity may be back" signal — browser
   * `online`, app foregrounding on mobile. Returns the unsubscribe.
   */
  onReconnect?: (sync: () => void) => () => void;
  /** Test seam. */
  fetchImpl?: typeof fetch;
}

export type SyncStatus =
  | 'unavailable' // server has no sync configured — anonymous local-only
  | 'signedOut'
  | 'idle'
  | 'syncing'
  | 'offline'
  | 'authExpired'
  | 'error';

export interface SyncState {
  /** Null while the server capability is still being probed. */
  available: boolean | null;
  /** Whether this server accepts new accounts; null while probing. */
  registration: RegistrationMode | null;
  /** Local storage and the persisted session have finished opening. */
  ready: boolean;
  status: SyncStatus;
  email: string | null;
  lastSyncAt: number | null;
  /** Human-readable auth/sync problem, if any. Cleared by the next success. */
  error: string | null;
  /**
   * Local changes still waiting to be pushed. Surfaced so a stalled sync is
   * visible as a growing number rather than only as a status colour.
   */
  pending: number;
  /**
   * The most recent sync failure, kept after a later success (unlike `error`).
   * A sync that fails and then recovers otherwise leaves no trace at all, which
   * is how the wedged-push bug stayed invisible.
   */
  lastError: { message: string; at: number } | null;
  /** Resolve to an error message, or null on success. */
  signIn: (
    email: string,
    password: string,
    mode: 'login' | 'register',
    invite?: string,
  ) => Promise<string | null>;
  signOut: () => void;
  /** Rotates the password; keeps this device signed in with a fresh token. */
  changePassword: (currentPassword: string, newPassword: string) => Promise<string | null>;
  /** Deletes the server account (local data stays); signs out on success. */
  deleteAccount: (password: string) => Promise<string | null>;
  syncNow: () => void;
}

/**
 * Thin adapter over @atlas/sync's SyncEngine: owns the JWT session (persisted
 * via the platform seam), decides when to sync (sign-in, reconnect, interval,
 * and a debounce after local changes), and refreshes the UI when a pull
 * applied remote data. Anonymous local-only stays the default — no account,
 * no sync.
 *
 * `changeToken` must change identity on local mutations (and may also change
 * on pull-applied refreshes — those are recognized and not re-pushed).
 */
export function useSync(
  storage: AtlasStorage | null,
  onPulled: () => Promise<void>,
  changeToken: unknown,
  platform: SyncPlatform,
): SyncState {
  const { baseUrl = '' } = platform;
  // Wrapped, not passed bare: browser fetch throws "Illegal invocation" when
  // called with a foreign `this` (the engine calls it as `this.fetchFn(...)`).
  const fetchImpl = useMemo(
    () => platform.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args)),
    [platform.fetchImpl],
  );
  const [available, setAvailable] = useState<boolean | null>(null);
  const [registration, setRegistration] = useState<RegistrationMode | null>(null);
  const [session, setSession] = useState<SyncSession | null>(null);
  const [sessionLoaded, setSessionLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<'offline' | 'authExpired' | 'error' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(null);
  const [pending, setPending] = useState(0);
  const [lastError, setLastError] = useState<{ message: string; at: number } | null>(null);

  const sessionRef = useRef(session);
  sessionRef.current = session;

  // Probe the server's sync capability (the Account UI keys off it).
  useEffect(() => {
    let cancelled = false;
    setAvailable(null);
    fetchImpl(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) })
      .then((res) => res.json() as Promise<{ sync?: boolean; registration?: RegistrationMode }>)
      .then((health) => {
        if (cancelled) return;
        setAvailable(health.sync === true);
        // Older servers don't report the mode; they predate gating, so they
        // are open by definition.
        setRegistration(health.sync === true ? (health.registration ?? 'open') : 'closed');
      })
      .catch(() => {
        if (!cancelled) {
          setAvailable(false);
          setRegistration('closed');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [baseUrl, fetchImpl]);

  // Restore the persisted session once storage is open.
  useEffect(() => {
    if (!storage) return;
    let cancelled = false;
    void Promise.resolve(platform.loadSession(storage)).then((restored) => {
      if (cancelled) return;
      if (restored) setSession(restored);
      setSessionLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [storage, platform]);

  const engine = useMemo(
    () =>
      storage
        ? new SyncEngine({
            storage,
            baseUrl,
            fetchFn: fetchImpl,
            getToken: () => sessionRef.current?.token ?? null,
          })
        : null,
    [storage, baseUrl, fetchImpl],
  );

  // Set (not reset) around onPulled so the change-token effect can tell a
  // pull-applied refresh from a genuine local edit — see the debounce effect.
  const pullEcho = useRef(0);

  /** Read the outbox depth; best-effort, never allowed to break a sync. */
  const refreshPending = useCallback(() => {
    if (!storage) return;
    void storage
      .countOutbox()
      .then(setPending)
      .catch(() => undefined);
  }, [storage]);

  /** Record a failure both as the current problem and in the sticky log. */
  const reportFailure = useCallback((kind: 'authExpired' | 'error', message: string) => {
    setProblem(kind);
    setError(message);
    setLastError({ message, at: Date.now() });
  }, []);

  const doSync = useCallback(() => {
    if (!engine || !sessionRef.current) return;
    setBusy(true);
    engine
      .sync()
      .then(async (result) => {
        if (result.failed.length > 0) {
          // Abandoned rather than retried forever — say so, or the data silently
          // stops syncing while the status light stays green.
          reportFailure(
            'error',
            `${result.failed.length} item(s) could not be synced: ${result.failed[0]!.reason}.`,
          );
        } else {
          setProblem(null);
          setError(null);
        }
        setLastSyncAt(Date.now());
        if (result.pulled > 0) {
          pullEcho.current += 1;
          await onPulled();
        }
      })
      .catch((err: unknown) => {
        if (err instanceof SyncError && err.kind === 'auth') {
          reportFailure('authExpired', 'Session expired — sign in again.');
        } else if (err instanceof SyncError && err.kind === 'unavailable') {
          // Offline is an expected state, not a fault — no sticky entry.
          setProblem('offline');
        } else {
          reportFailure('error', String(err));
          console.error('Sync failed', err);
        }
      })
      .finally(() => {
        setBusy(false);
        // After a push the outbox has drained; after a failure it has not.
        refreshPending();
      });
  }, [engine, onPulled, reportFailure, refreshPending]);

  // Single-flight, like SyncEngine.sync(): a second sign-in while the first is
  // still bootstrapping must not interleave (cursor reset vs in-flight push).
  const signInFlight = useRef(false);
  const signIn = useCallback(
    async (email: string, password: string, mode: 'login' | 'register', invite?: string) => {
      if (!storage || !engine) return 'Storage is not ready.';
      if (signInFlight.current) return 'Sign-in already in progress.';
      signInFlight.current = true;
      try {
        let res: Response;
        try {
          res = await fetchImpl(
            `${baseUrl}/api/auth/${mode === 'register' ? 'register' : 'login'}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ email, password, ...(invite ? { invite } : {}) }),
            },
          );
        } catch {
          return 'Server unreachable.';
        }
        const body = (await res.json().catch(() => ({}))) as Partial<AuthResponse> & {
          error?: string;
        };
        if (!res.ok || typeof body.token !== 'string' || typeof body.email !== 'string') {
          return body.error ?? `Sign-in failed (${res.status}).`;
        }
        const next: SyncSession = { token: body.token, email: body.email };
        await platform.saveSession(storage, next);
        sessionRef.current = next;
        setSession(next);
        setProblem(null);
        setError(null);
        // First sync for this account on this device pushes everything local.
        if ((await storage.getSetting(ACCOUNT_SETTING)) !== body.email) {
          await engine.bootstrap();
          await storage.setSetting(ACCOUNT_SETTING, body.email);
        }
        doSync();
        return null;
      } finally {
        signInFlight.current = false;
      }
    },
    [storage, engine, doSync, baseUrl, fetchImpl, platform],
  );

  const signOut = useCallback(() => {
    if (storage) void platform.saveSession(storage, null);
    setSession(null);
    setProblem(null);
    setError(null);
  }, [storage, platform]);

  /** POST to an authenticated auth route, normalizing the error shapes. */
  const authedPost = useCallback(
    async (path: string, body: unknown): Promise<{ error: string } | { body: unknown }> => {
      const token = sessionRef.current?.token;
      if (!token) return { error: 'Not signed in.' };
      let res: Response;
      try {
        res = await fetchImpl(`${baseUrl}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify(body),
        });
      } catch {
        return { error: 'Server unreachable.' };
      }
      const parsed = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) return { error: parsed.error ?? `Request failed (${res.status}).` };
      return { body: parsed };
    },
    [baseUrl, fetchImpl],
  );

  const changePassword = useCallback(
    async (currentPassword: string, newPassword: string) => {
      if (!storage) return 'Storage is not ready.';
      const result = await authedPost('/api/auth/password', { currentPassword, newPassword });
      if ('error' in result) return result.error;
      // The server rotated the token epoch, so the token we hold is now dead —
      // adopt the replacement it handed back or this device signs itself out.
      const fresh = result.body as Partial<AuthResponse>;
      if (typeof fresh.token !== 'string' || typeof fresh.email !== 'string') {
        return 'Password changed, but the server sent no new session — sign in again.';
      }
      const next: SyncSession = { token: fresh.token, email: fresh.email };
      await platform.saveSession(storage, next);
      sessionRef.current = next;
      setSession(next);
      setProblem(null);
      setError(null);
      return null;
    },
    [storage, authedPost, platform],
  );

  const deleteAccount = useCallback(
    async (password: string) => {
      const result = await authedPost('/api/auth/delete', { password });
      if ('error' in result) return result.error;
      // Server-side data is gone; local data deliberately stays, so the app
      // falls back to anonymous local-only exactly as before sign-in.
      if (storage) await storage.setSetting(ACCOUNT_SETTING, '');
      signOut();
      return null;
    },
    [authedPost, storage, signOut],
  );

  // Sync on session restore/sign-in, on reconnect, and on a timer.
  useEffect(() => {
    if (!engine || !session) return;
    doSync();
    const interval = setInterval(doSync, SYNC_INTERVAL_MS);
    const unsubscribe = platform.onReconnect?.(doSync);
    return () => {
      clearInterval(interval);
      unsubscribe?.();
    };
  }, [engine, session, doSync, platform]);

  // Local edits change the outbox depth whether or not a sync follows (there
  // is no account in the anonymous case), so track it off the change token.
  useEffect(refreshPending, [changeToken, refreshPending]);

  // Debounced push after local edits. A pull-applied refresh also bumps the
  // change token; consume the pullEcho marker instead of scheduling a push
  // for it (the push would be a no-op, but it used to churn a whole cycle).
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (pullEcho.current > 0) {
      pullEcho.current -= 1;
      return;
    }
    if (!session) return;
    const t = setTimeout(doSync, DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [changeToken, session, doSync]);

  const status: SyncStatus =
    available === false
      ? 'unavailable'
      : !sessionLoaded || !session
        ? 'signedOut'
        : busy
          ? 'syncing'
          : (problem ?? 'idle');

  return {
    available,
    registration,
    ready: storage !== null && sessionLoaded,
    status,
    email: session?.email ?? null,
    lastSyncAt,
    error,
    pending,
    lastError,
    signIn,
    signOut,
    changePassword,
    deleteAccount,
    syncNow: doSync,
  };
}
