import {
  useSync as useSharedSync,
  type SyncPlatform,
  type SyncSession,
  type SyncState,
} from '@atlas/app-hooks';
import type { AtlasStorage } from '@atlas/storage';
import * as SecureStore from 'expo-secure-store';
import { useMemo } from 'react';
import { AppState } from 'react-native';

import { useServerOrigin } from '../serverOrigin';

export type { SyncState, SyncStatus } from '@atlas/app-hooks';

/**
 * Where the 90-day JWT lives: the Android keystore-backed secure store, not
 * the Atlas database. A bearer token that grants full access to an account's
 * data is a secret, and secrets do not belong in an ordinary SQLite file that
 * a backup, a debug pull or a rooted device can read wholesale.
 */
const SESSION_KEY = 'atlas.sync.session';

/**
 * The pre-secure-store home of the same token (a local-only setting, so it
 * never synced). Read once to carry an existing sign-in across the upgrade,
 * then deleted — leaving the plaintext copy behind would make the move
 * pointless.
 */
const LEGACY_SESSION_SETTING = 'local.sync.session';

/** Parse a stored session, treating anything malformed as signed out. */
function parseSession(raw: string | null): SyncSession | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<SyncSession>;
    return typeof parsed.token === 'string' && typeof parsed.email === 'string'
      ? { token: parsed.token, email: parsed.email }
      : null;
  } catch {
    return null; // corrupt session — treat as signed out
  }
}

/**
 * Android configuration of the shared useSync (@atlas/app-hooks): the JWT
 * session lives in expo-secure-store, "reconnect" is the app returning to the
 * foreground (AppState), and the server origin is the user-configurable one.
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
        const stored = parseSession(await SecureStore.getItemAsync(SESSION_KEY));
        if (stored) return stored;
        // One-time migration. The legacy setting is cleared whether or not it
        // held something usable, so a corrupt leftover is not re-read forever.
        const raw = (await s.getSetting(LEGACY_SESSION_SETTING)) || null;
        if (!raw) return null;
        const legacy = parseSession(raw);
        if (legacy) await SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(legacy));
        await s.setSetting(LEGACY_SESSION_SETTING, '');
        return legacy;
      },
      saveSession: async (s, session) => {
        if (session) await SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(session));
        else await SecureStore.deleteItemAsync(SESSION_KEY);
        // Sign-out and account deletion also clear any legacy copy that a
        // never-signed-in-since upgrade could still be carrying.
        if (!session) await s.setSetting(LEGACY_SESSION_SETTING, '');
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
