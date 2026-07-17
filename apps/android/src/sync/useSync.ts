import {
  useSync as useSharedSync,
  type SyncPlatform,
  type SyncSession,
  type SyncState,
} from '@atlas/app-hooks';
import type { AtlasStorage } from '@atlas/storage';
import { useMemo } from 'react';
import { AppState } from 'react-native';

import { useServerOrigin } from '../serverOrigin';

export type { SyncState, SyncStatus } from '@atlas/app-hooks';

/** JWT session, persisted in a local-only setting (never synced). */
const SESSION_SETTING = 'local.sync.session';

/**
 * Android configuration of the shared useSync (@atlas/app-hooks): the JWT
 * session lives in a local-only storage setting, "reconnect" is the app
 * returning to the foreground (AppState), and the server origin is the
 * user-configurable one.
 */
export function useSync(
  storage: AtlasStorage | null,
  onPulled: () => Promise<void>,
  /** Bump on any local mutation or applied pull to schedule a debounced push. */
  changeToken: unknown,
): SyncState {
  const serverOrigin = useServerOrigin();
  const platform = useMemo<SyncPlatform>(
    () => ({
      baseUrl: serverOrigin,
      loadSession: async (s) => {
        const raw = await s.getSetting(SESSION_SETTING);
        if (!raw) return null;
        try {
          const parsed = JSON.parse(raw) as Partial<SyncSession>;
          return typeof parsed.token === 'string' && typeof parsed.email === 'string'
            ? { token: parsed.token, email: parsed.email }
            : null;
        } catch {
          return null; // corrupt session — treat as signed out
        }
      },
      saveSession: async (s, session) => {
        await s.setSetting(SESSION_SETTING, session ? JSON.stringify(session) : '');
      },
      onReconnect: (sync) => {
        const sub = AppState.addEventListener('change', (state) => {
          if (state === 'active') sync();
        });
        return () => sub.remove();
      },
    }),
    [serverOrigin],
  );
  return useSharedSync(storage, onPulled, changeToken, platform);
}
