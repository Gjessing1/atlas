import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';

import appJson from '../../app.json';
import { getServerOrigin } from '../serverOrigin';

/** Synced preference; the location-bearing log itself never leaves this phone automatically. */
export const NAV_DIAGNOSTICS_SETTING = 'navigation.diagnostics.enabled';

const LOG_URI = `${FileSystem.documentDirectory ?? FileSystem.cacheDirectory ?? ''}navigation-diagnostics.jsonl`;
/** Start a new file at the next trip boundary, never halfway through a drive. */
const ROTATE_BEFORE_TRIP_BYTES = 20 * 1024 * 1024;
const APP_VERSION = appJson.expo.version;
const RUNTIME_VERSION = appJson.expo.runtimeVersion;

let enabled = false;
let writeQueue: Promise<void> = Promise.resolve();

export interface NavigationDiagnosticRecord {
  event: string;
  [key: string]: unknown;
}

function queue(operation: () => Promise<void>): Promise<void> {
  const next = writeQueue.catch(() => undefined).then(operation);
  writeQueue = next.catch(() => undefined);
  return next;
}

/** Turn capture on/off immediately; persistence of the choice is owned by the hook below. */
export function configureNavigationDiagnostics(on: boolean, account: string | null): void {
  if (enabled === on) return;
  if (!on) {
    // Record the boundary before closing the tap.
    void logNavigationDiagnostic({ event: 'diagnostics-disabled', account });
    enabled = false;
    return;
  }
  enabled = true;
  void logNavigationDiagnostic({ event: 'diagnostics-enabled', account });
}

/** Append one JSON record. Failures are deliberately isolated from navigation itself. */
export function logNavigationDiagnostic(record: NavigationDiagnosticRecord): Promise<void> {
  if (!enabled) return Promise.resolve();
  const line = `${JSON.stringify({
    at: new Date().toISOString(),
    appVersion: APP_VERSION,
    runtimeVersion: RUNTIME_VERSION,
    ...record,
  })}\n`;
  return queue(async () => {
    await FileSystem.writeAsStringAsync(LOG_URI, line, { append: true }).catch(() => undefined);
  });
}

/**
 * Rotate only before a fresh trip. A size limit applied per write could delete
 * the calculated route halfway through the drive whose failure we need to
 * understand.
 */
export function beginNavigationDiagnosticTrip(context: Record<string, unknown>): Promise<void> {
  if (!enabled) return Promise.resolve();
  return queue(async () => {
    const info = await FileSystem.getInfoAsync(LOG_URI).catch(() => null);
    if (info?.exists && typeof info.size === 'number' && info.size >= ROTATE_BEFORE_TRIP_BYTES) {
      await FileSystem.deleteAsync(LOG_URI, { idempotent: true }).catch(() => undefined);
    }
    const line = `${JSON.stringify({
      at: new Date().toISOString(),
      appVersion: APP_VERSION,
      runtimeVersion: RUNTIME_VERSION,
      event: 'trip-start',
      ...context,
    })}\n`;
    await FileSystem.writeAsStringAsync(LOG_URI, line, { append: true }).catch(() => undefined);
  });
}

export async function navigationDiagnosticSize(): Promise<number> {
  await writeQueue.catch(() => undefined);
  const info = await FileSystem.getInfoAsync(LOG_URI).catch(() => null);
  return info?.exists && typeof info.size === 'number' ? info.size : 0;
}

export async function shareNavigationDiagnostics(): Promise<boolean> {
  await writeQueue.catch(() => undefined);
  const info = await FileSystem.getInfoAsync(LOG_URI).catch(() => null);
  if (!info?.exists || !(await Sharing.isAvailableAsync())) return false;
  await Sharing.shareAsync(LOG_URI, {
    mimeType: 'application/x-ndjson',
    dialogTitle: 'Share Atlas navigation diagnostics',
  });
  return true;
}

/** Upload only after an explicit button press; this file contains exact locations. */
export async function uploadNavigationDiagnostics(): Promise<string> {
  await writeQueue.catch(() => undefined);
  const info = await FileSystem.getInfoAsync(LOG_URI).catch(() => null);
  if (!info?.exists) throw new Error('No diagnostic log is available to upload.');
  const body = await FileSystem.readAsStringAsync(LOG_URI);
  if (!body.trim()) throw new Error('No diagnostic log is available to upload.');
  const response = await fetch(`${getServerOrigin()}/api/diagnostics/navigation`, {
    method: 'POST',
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'x-atlas-version': APP_VERSION,
      'x-atlas-runtime': RUNTIME_VERSION,
    },
    body,
  });
  const result = (await response.json().catch(() => null)) as {
    reference?: string;
    error?: string;
  } | null;
  if (!response.ok || !result?.reference) {
    throw new Error(result?.error ?? `Upload failed (${response.status}).`);
  }
  return result.reference;
}

export async function clearNavigationDiagnostics(): Promise<void> {
  await queue(() => FileSystem.deleteAsync(LOG_URI, { idempotent: true }));
}

/** Test/support seam: production callers should use the persisted preference hook. */
export function navigationDiagnosticsEnabled(): boolean {
  return enabled;
}
