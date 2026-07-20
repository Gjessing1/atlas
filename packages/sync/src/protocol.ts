import type { SyncChange } from '@atlas/storage';

/**
 * Wire types for the REST sync protocol (see ARCHITECTURE.md, "Synchronization
 * Strategy"): plain REST + last-write-wins `updatedAt` timestamps. Shared by
 * the client engine and the backend routes.
 */

export interface AuthCredentials {
  email: string;
  password: string;
  /** Required by servers running in `invite` registration mode. */
  invite?: string;
}

export interface AuthResponse {
  token: string;
  email: string;
}

/**
 * Who may create an account on this server, reported by GET /api/health so the
 * client shows the right sign-up affordance instead of a button that will be
 * refused. Servers with no sync configured report `closed`.
 */
export type RegistrationMode = 'open' | 'invite' | 'closed';

/** POST /api/auth/password — returns a fresh AuthResponse for this device. */
export interface ChangePasswordRequest {
  currentPassword: string;
  newPassword: string;
}

/** POST /api/auth/delete — password-confirmed account removal. */
export interface DeleteAccountRequest {
  password: string;
}

/** POST /api/sync/push */
export interface SyncPushRequest {
  /** Random id for this installation; lets pull skip changes this device wrote. */
  deviceId: string;
  changes: SyncChange[];
}

export interface SyncPushResponse {
  /** Changes newer than the server copy — stored. */
  applied: number;
  /** Stale changes the server already had newer state for. */
  skipped: number;
}

/** GET /api/sync/pull?since=<cursor>&device=<deviceId>&limit=<n> */
export interface SyncPullResponse {
  changes: SyncChange[];
  /** Pass as `since` next time; monotonic per-user server sequence. */
  cursor: number;
  /** More changes are waiting beyond `cursor` — pull again. */
  hasMore: boolean;
}

/**
 * Last-write-wins: does an incoming change beat the stored state? Ties keep
 * the existing copy, which makes replays of an already-accepted change no-ops.
 */
export function lwwWins(incomingUpdatedAt: number, existingUpdatedAt: number | null): boolean {
  return existingUpdatedAt === null || incomingUpdatedAt > existingUpdatedAt;
}
