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
 * The furthest ahead of the server's clock a pushed `updatedAt` may claim to
 * be. Client stamps come from device wall clocks; a device set far into the
 * future would otherwise write records that permanently out-rank every later
 * edit from correctly configured devices. Stamps beyond the window are clamped
 * to it at push time (see clampFutureStamps). Five minutes tolerates ordinary
 * drift on devices without network time.
 */
export const MAX_CLOCK_SKEW_MS = 5 * 60_000;

/** One side of an LWW comparison: the stamp and the device that wrote it. */
export interface LwwStamp {
  updatedAt: number;
  deviceId: string;
}

/**
 * Last-write-wins: does an incoming change beat the stored state? Equal
 * stamps are broken deterministically by device id (larger wins), so the
 * outcome of a genuine two-device tie does not depend on push order. A replay
 * from the same device (equal stamp, equal device) keeps the existing copy,
 * so re-pushing an already-accepted change stays a no-op.
 */
export function lwwWins(incoming: LwwStamp, existing: LwwStamp | null): boolean {
  if (existing === null) return true;
  if (incoming.updatedAt !== existing.updatedAt) return incoming.updatedAt > existing.updatedAt;
  return incoming.deviceId > existing.deviceId;
}

/**
 * Clamp implausibly future change stamps to `now + MAX_CLOCK_SKEW_MS`. Run by
 * the server on every push, so one mis-set device clock cannot poison the
 * account: an accepted future stamp would both beat all later honest edits and
 * — because clients raise their own clocks to every stamp they observe —
 * drag every other device's stamps into the future with it.
 */
export function clampFutureStamps(changes: SyncChange[], now: number): SyncChange[] {
  const max = now + MAX_CLOCK_SKEW_MS;
  return changes.map((c) => (c.updatedAt > max ? { ...c, updatedAt: max } : c));
}
