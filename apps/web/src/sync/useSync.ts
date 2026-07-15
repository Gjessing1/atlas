import type { AuthResponse } from '@atlas/sync';
import { SyncEngine, SyncError } from '@atlas/sync';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { UserData } from '../storage/useUserData.js';

const AUTH_STORAGE_KEY = 'atlas.auth';
/** Which account this device last synced with — a switch forces a re-bootstrap. */
const ACCOUNT_SETTING = 'local.sync.account';
const SYNC_INTERVAL_MS = 60_000;
/** Quiet period after a local change before pushing it. */
const DEBOUNCE_MS = 2_500;

interface Session {
  token: string;
  email: string;
}

function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(AUTH_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Session>;
    return typeof parsed.token === 'string' && typeof parsed.email === 'string'
      ? { token: parsed.token, email: parsed.email }
      : null;
  } catch {
    return null;
  }
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
  status: SyncStatus;
  email: string | null;
  lastSyncAt: number | null;
  /** Human-readable auth/sync problem, if any. */
  error: string | null;
  /** Resolve to an error message, or null on success. */
  signIn: (email: string, password: string, mode: 'login' | 'register') => Promise<string | null>;
  signOut: () => void;
  syncNow: () => void;
}

/**
 * Thin adapter over @atlas/sync's SyncEngine: owns the JWT session
 * (localStorage), decides when to sync (sign-in, reconnect, interval, and a
 * debounce after local changes), and refreshes the UI when a pull applied
 * remote data. Anonymous local-only stays the default — no account, no sync.
 */
export function useSync(data: UserData): SyncState {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [session, setSession] = useState<Session | null>(loadSession);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<'offline' | 'authExpired' | 'error' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(null);

  const sessionRef = useRef(session);
  sessionRef.current = session;
  const { storage, refreshAll } = data;

  useEffect(() => {
    let cancelled = false;
    fetch('/api/health')
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

  const engine = useMemo(
    () =>
      storage
        ? new SyncEngine({ storage, getToken: () => sessionRef.current?.token ?? null })
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
        if (result.pulled > 0) await refreshAll();
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
          console.error('Sync failed', err);
        }
      })
      .finally(() => setBusy(false));
  }, [engine, refreshAll]);

  const signIn = useCallback(
    async (email: string, password: string, mode: 'login' | 'register') => {
      if (!storage || !engine) return 'Storage is not ready.';
      let res: Response;
      try {
        res = await fetch(`/api/auth/${mode === 'register' ? 'register' : 'login'}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password }),
        });
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
      localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(next));
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
    localStorage.removeItem(AUTH_STORAGE_KEY);
    setSession(null);
    setProblem(null);
    setError(null);
  }, []);

  // Sync on sign-in/startup, on reconnect, and on a timer while signed in.
  useEffect(() => {
    if (!engine || !session) return;
    doSync();
    const interval = setInterval(doSync, SYNC_INTERVAL_MS);
    window.addEventListener('online', doSync);
    return () => {
      clearInterval(interval);
      window.removeEventListener('online', doSync);
    };
  }, [engine, session, doSync]);

  // Debounced push after local edits: any list identity change means a mutation
  // (or an applied pull, which the coalescing engine turns into a cheap no-op).
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (!session) return;
    const t = setTimeout(doSync, DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [data.collections, data.places, data.tracks, session, doSync]);

  const status: SyncStatus =
    available === false
      ? 'unavailable'
      : !session
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
