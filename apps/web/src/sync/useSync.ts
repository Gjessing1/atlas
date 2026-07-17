import { useSync as useSharedSync, type SyncPlatform, type SyncSession } from '@atlas/app-hooks';
import type { SyncState } from '@atlas/app-hooks';
import { useMemo } from 'react';
import type { UserData } from '../storage/useUserData.js';

export type { SyncState, SyncStatus } from '@atlas/app-hooks';

const AUTH_STORAGE_KEY = 'atlas.auth';

/**
 * Web configuration of the shared useSync (@atlas/app-hooks): the JWT session
 * lives in localStorage, "reconnect" is the browser's `online` event, and the
 * server is same-origin.
 */
const platform: SyncPlatform = {
  loadSession: () => {
    try {
      const raw = localStorage.getItem(AUTH_STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Partial<SyncSession>;
      return typeof parsed.token === 'string' && typeof parsed.email === 'string'
        ? { token: parsed.token, email: parsed.email }
        : null;
    } catch {
      return null;
    }
  },
  saveSession: (_storage, session) => {
    if (session) localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(session));
    else localStorage.removeItem(AUTH_STORAGE_KEY);
  },
  onReconnect: (sync) => {
    window.addEventListener('online', sync);
    return () => window.removeEventListener('online', sync);
  },
};

export function useSync(data: UserData): SyncState {
  // Any list identity change means a mutation or an applied pull — exactly
  // the change-token contract the shared hook expects.
  const changeToken = useMemo(
    () => [data.collections, data.places, data.tracks],
    [data.collections, data.places, data.tracks],
  );
  return useSharedSync(data.storage, data.refreshAll, changeToken, platform);
}
