import { requireOptionalNativeModule } from 'expo-modules-core';

/** One file of a pack, as the native worker needs it. */
export interface PackDownloadFile {
  url: string;
  /** Path relative to the staging directory. */
  path: string;
  bytes: number;
}

export interface PackDownloadSpec {
  /** Human-readable region name — the notification says "Downloading <name>". */
  name: string;
  /** Absolute (not file://) path of the staging directory. */
  dir: string;
  files: PackDownloadFile[];
}

/**
 * WorkManager states, lowercased. `enqueued`/`blocked` mean the system is
 * holding the work until its constraints are met (typically: waiting for Wi-Fi);
 * `cancelled` means the user (or a pack delete) stopped it.
 */
export type PackDownloadState =
  'enqueued' | 'running' | 'succeeded' | 'failed' | 'blocked' | 'cancelled';

export interface PackDownloadJob {
  packId: string;
  state: PackDownloadState;
  bytesDone: number;
  bytesTotal: number;
  error: string | null;
}

/**
 * Background downloads for offline map packs.
 *
 * Downloads used to run in the app's JS, which Android freezes seconds after
 * you switch away — so a half-hour pack download only progressed while the user
 * watched it. This hands the bytes to WorkManager under a foreground service:
 * it keeps going with Atlas in the background, resumes with an HTTP range
 * request after a process death or a lost connection, and can be told to wait
 * for Wi-Fi. Everything else about installing a pack stays in TypeScript
 * (`src/regions/packs.ts`).
 */
interface PackDownloadNativeModule {
  enqueue(packId: string, specJson: string, wifiOnly: boolean): void;
  jobs(): Promise<string>;
  cancel(packId: string): void;
  forget(packId: string): void;
  sha256(path: string): Promise<string>;
}

/** Null in builds that predate the native module (and in unit tests). */
const Native = requireOptionalNativeModule<PackDownloadNativeModule>('PackDownload');

/** Whether pack downloads can run in the background on this build. */
export const packDownloadSupported = Native !== null;

export function enqueuePackDownload(
  packId: string,
  spec: PackDownloadSpec,
  wifiOnly: boolean,
): void {
  Native?.enqueue(packId, JSON.stringify(spec), wifiOnly);
}

export async function packDownloadJobs(): Promise<PackDownloadJob[]> {
  if (!Native) return [];
  try {
    const parsed = JSON.parse(await Native.jobs()) as unknown;
    return Array.isArray(parsed) ? (parsed as PackDownloadJob[]) : [];
  } catch {
    return [];
  }
}

export function cancelPackDownload(packId: string): void {
  Native?.cancel(packId);
}

export function forgetPackDownload(packId: string): void {
  Native?.forget(packId);
}

/** Native SHA-256 (lowercase hex) of a plain file path, or null without the module. */
export async function nativeSha256(path: string): Promise<string | null> {
  if (!Native) return null;
  return await Native.sha256(path);
}
