import type { AtlasStorage } from '@atlas/storage';
import type { AuthResponse } from '@atlas/sync';
import { SyncEngine, SyncError } from '@atlas/sync';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { SERVER_ORIGIN } from '../config';

/** JWT session, persisted in a local-only setting (never synced). */
const SESSION_SETTING = 'local.sync.session';
/** Which account this device last synced with — a switch forces a re-bootstrap. */
const ACCOUNT_SETTING = 'local.sync.account';
const SYNC_INTERVAL_MS = 60_000;
/** Quiet period after a local change before pushing it. */
const DEBOUNCE_MS = 2_500;

interface Session {
  token: string;
  email: string;
}

export type SyncStatus =
  'unavailable' | 'signedOut' | 'idle' | 'syncing' | 'offline' | 'authExpired' | 'error';

export interface SyncState {
  available: boolean | null;
  status: SyncStatus;
  email: string | null;
  lastSyncAt: number | null;
  error: string | null;
  signIn: (email: string, password: string, mode: 'login' | 'register') => Promise<string | null>;
  signOut: () => void;
  syncNow: () => void;
}

/**
 * Android twin of the web app's useSync (apps/web/src/sync/useSync.ts), over
 * the same @atlas/sync engine. Differences: the JWT session lives in a
 * local-only storage setting instead of localStorage, and "reconnect" is the
 * app returning to the foreground (AppState) instead of a window event.
 */
export function useSync(
  storage: AtlasStorage | null,
  onPulled: () => Promise<void>,
  /** Bump on any local mutation to schedule a debounced push. */
  changeToken: unknown,
): SyncState {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [sessionLoaded, setSessionLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<'offline' | 'authExpired' | 'error' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(null);

  const sessionRef = useRef(session);
  sessionRef.current = session;

  // Probe the server's sync capability (mirrors the web Account panel).
  useEffect(() => {
    let cancelled = false;
    fetch(`${SERVER_ORIGIN}/api/health`, { signal: AbortSignal.timeout(5000) })
      .then((res) => res.json())
      .then((health: { sync?: boolean }) => {
        if (!cancelled) setAvailable(health.sync === true);
      })
      .catch(() => {
        if (!cancelled) setAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Restore the persisted session once storage is open.
  useEffect(() => {
    if (!storage) return;
    let cancelled = false;
    void storage.getSetting(SESSION_SETTING).then((raw) => {
      if (cancelled) return;
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as Partial<Session>;
          if (typeof parsed.token === 'string' && typeof parsed.email === 'string') {
            setSession({ token: parsed.token, email: parsed.email });
          }
        } catch {
          // corrupt session — treat as signed out
        }
      }
      setSessionLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [storage]);

  const engine = useMemo(
    () =>
      storage
        ? new SyncEngine({
            storage,
            baseUrl: SERVER_ORIGIN,
            getToken: () => sessionRef.current?.token ?? null,
          })
        : null,
    [storage],
  );

  const doSync = useCallback(() => {
    if (!engine || !sessionRef.current) return;
    setBusy(true);
    engine
      .sync()
      .then(async (result) => {
        setProblem(null);
        setError(null);
        setLastSyncAt(Date.now());
        if (result.pulled > 0) await onPulled();
      })
      .catch((err: unknown) => {
        if (err instanceof SyncError && err.kind === 'auth') {
          setProblem('authExpired');
          setError('Session expired — sign in again.');
        } else if (err instanceof SyncError && err.kind === 'unavailable') {
          setProblem('offline');
        } else {
          setProblem('error');
          setError(String(err));
        }
      })
      .finally(() => setBusy(false));
  }, [engine, onPulled]);

  const signIn = useCallback(
    async (email: string, password: string, mode: 'login' | 'register') => {
      if (!storage || !engine) return 'Storage is not ready.';
      let res: Response;
      try {
        res = await fetch(
          `${SERVER_ORIGIN}/api/auth/${mode === 'register' ? 'register' : 'login'}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password }),
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
      const next: Session = { token: body.token, email: body.email };
      await storage.setSetting(SESSION_SETTING, JSON.stringify(next));
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
    },
    [storage, engine, doSync],
  );

  const signOut = useCallback(() => {
    void storage?.setSetting(SESSION_SETTING, '');
    setSession(null);
    setProblem(null);
    setError(null);
  }, [storage]);

  // Sync on session restore/sign-in, on foreground, and on a timer.
  useEffect(() => {
    if (!engine || !session) return;
    doSync();
    const interval = setInterval(doSync, SYNC_INTERVAL_MS);
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') doSync();
    });
    return () => {
      clearInterval(interval);
      sub.remove();
    };
  }, [engine, session, doSync]);

  // Debounced push after local edits.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
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
    status,
    email: session?.email ?? null,
    lastSyncAt,
    error,
    signIn,
    signOut,
    syncNow: doSync,
  };
}
