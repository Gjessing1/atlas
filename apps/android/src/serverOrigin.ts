import type { AtlasStorage } from '@atlas/storage';
import { useSyncExternalStore } from 'react';

import { DEFAULT_SERVER_ORIGIN } from './config';

/**
 * The effective Atlas server origin — runtime-configurable so one APK can point
 * at any Atlas server without a rebuild (docs/ROADMAP.md Phase 6). Held in a
 * tiny module store so both React code (via useServerOrigin) and the plain
 * async helpers (mapStyle, packs — via getServerOrigin) read one live value.
 *
 * Persisted in a local-only storage setting (`local.` never syncs — the origin
 * is device-specific). Falls back to DEFAULT_SERVER_ORIGIN until hydrated.
 */
const SETTING_KEY = 'local.server.origin';

let current = DEFAULT_SERVER_ORIGIN;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** The current origin (no trailing slash). Read at call time — never cache it. */
export function getServerOrigin(): string {
  return current;
}

export function defaultServerOrigin(): string {
  return DEFAULT_SERVER_ORIGIN;
}

/**
 * Load the persisted override (if any) into the store. Call once at startup,
 * before rendering server-dependent UI, so the first request hits the right
 * server.
 */
export async function hydrateServerOrigin(storage: AtlasStorage): Promise<void> {
  const saved = (await storage.getSetting(SETTING_KEY))?.trim();
  const next = saved && saved.length > 0 ? saved : DEFAULT_SERVER_ORIGIN;
  if (next !== current) {
    current = next;
    emit();
  }
}

/** Validate + normalise a user-entered origin, or null if it isn't a URL. */
export function normalizeServerOrigin(raw: string): string | null {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s/]+/i.test(trimmed)) return null;
  return trimmed;
}

/**
 * Persist + apply a new origin (empty resets to the default). Returns an error
 * message, or null on success. Consumers re-render / re-run their effects via
 * useServerOrigin, so the change takes effect without a restart.
 */
export async function setServerOrigin(storage: AtlasStorage, raw: string): Promise<string | null> {
  const trimmed = raw.trim();
  const next = trimmed.length === 0 ? DEFAULT_SERVER_ORIGIN : normalizeServerOrigin(trimmed);
  if (!next) return 'Enter a full http(s):// server URL.';
  await storage.setSetting(SETTING_KEY, next === DEFAULT_SERVER_ORIGIN ? '' : next);
  if (next !== current) {
    current = next;
    emit();
  }
  return null;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** React hook: the current server origin, re-rendering the caller on change. */
export function useServerOrigin(): string {
  return useSyncExternalStore(subscribe, getServerOrigin, getServerOrigin);
}
