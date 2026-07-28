import {
  packFileEntries,
  packUnzipDir,
  type RegionPackFile,
  type RegionPackManifest,
  type RegionsResponse,
} from '@atlas/core';
import * as FileSystem from 'expo-file-system/legacy';
import { unzip } from 'react-native-zip-archive';

import { nativeSha256 } from '../../modules/packdownload';
import { getServerOrigin } from '../serverOrigin';
import { base64ToBytes, createSha256 } from './sha256';

/** file:// URI of the directory holding one downloaded pack per subdirectory. */
export const PACKS_DIR = `${FileSystem.documentDirectory}packs/`;

/**
 * A pack is downloaded and validated inside `<id>.staging`, then swapped into
 * `<id>` atomically. During the swap the previous good pack is parked at
 * `<id>.old` and only deleted once the new pack is in place, so a crash mid-swap
 * (or a failed download) can never leave the user with no offline map.
 */
const STAGING_SUFFIX = '.staging';
const BACKUP_SUFFIX = '.old';
/** Written last inside a completed unzip dir; its absence means a half-unzip. */
const UNZIP_MARKER = '.unzip-complete';
/** Records which manifest version a staging dir belongs to (for resume vs. reset). */
const STAGING_MARKER = '.staging.json';

/** Chunk size for streamed hashing; a multiple of 3 so base64 reads never straddle padding. */
const HASH_CHUNK_BYTES = 3 * 262_144; // 768 KiB → ~1 MiB base64 per read

export interface LocalPack {
  manifest: RegionPackManifest;
  /** file:// URI of the pack directory (no trailing slash). */
  dir: string;
}

export function packDir(id: string): string {
  return `${PACKS_DIR}${id}`;
}

/** Where a pack is assembled before it is swapped into place. */
export function stagingDir(id: string): string {
  return `${packDir(id)}${STAGING_SUFFIX}`;
}

async function exists(uri: string): Promise<boolean> {
  return (await FileSystem.getInfoAsync(uri)).exists;
}

/**
 * Downloaded packs = subdirectories with a pack.json (written last inside
 * staging, so its presence in the live dir means the swap completed). Staging
 * and backup directories are skipped; an interrupted swap is reconciled first.
 */
export async function listLocalPacks(): Promise<LocalPack[]> {
  await reconcileInterruptedSwaps();
  const packs: LocalPack[] = [];
  let entries: string[];
  try {
    entries = await FileSystem.readDirectoryAsync(PACKS_DIR);
  } catch {
    return packs; // no packs dir yet
  }
  for (const entry of entries) {
    if (entry.endsWith(STAGING_SUFFIX) || entry.endsWith(BACKUP_SUFFIX)) continue;
    try {
      const raw = await FileSystem.readAsStringAsync(`${packDir(entry)}/pack.json`);
      packs.push({ manifest: JSON.parse(raw) as RegionPackManifest, dir: packDir(entry) });
    } catch {
      // half-downloaded or foreign dir — not a usable pack
    }
  }
  return packs;
}

/**
 * A crash between "move live → backup" and "move staging → live" leaves an
 * `<id>.old` with no live `<id>`. Restore it; a backup whose live pack already
 * exists is a stale leftover and is dropped.
 */
async function reconcileInterruptedSwaps(): Promise<void> {
  let entries: string[];
  try {
    entries = await FileSystem.readDirectoryAsync(PACKS_DIR);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.endsWith(BACKUP_SUFFIX)) continue;
    const id = entry.slice(0, -BACKUP_SUFFIX.length);
    const backup = packDir(entry);
    const live = packDir(id);
    if (await exists(`${live}/pack.json`)) {
      await FileSystem.deleteAsync(backup, { idempotent: true });
    } else {
      try {
        await FileSystem.moveAsync({ from: backup, to: live });
      } catch {
        // Leave it for the next pass rather than lose the only copy.
      }
    }
  }
}

export async function fetchAvailableRegions(): Promise<RegionPackManifest[]> {
  const res = await fetch(`${getServerOrigin()}/api/regions`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`regions: HTTP ${res.status}`);
  const body = (await res.json()) as RegionsResponse;
  return body.regions;
}

export type PackProgress = (fraction: number) => void;

/** A path segment safe to use as a directory name (no traversal, no separators). */
function isSafeSegment(segment: string): boolean {
  return (
    segment.length > 0 && segment !== '.' && segment !== '..' && /^[A-Za-z0-9._-]+$/.test(segment)
  );
}

/** A relative file path that stays inside the pack dir. */
function isSafeRelPath(relPath: string): boolean {
  if (relPath.length === 0 || relPath.startsWith('/') || relPath.includes('\\')) return false;
  return relPath.split('/').every(isSafeSegment);
}

/**
 * Reject a manifest whose id or file paths could escape the packs directory or
 * are otherwise malformed, before any of it is used to build filesystem paths.
 */
export function validatePackManifest(manifest: RegionPackManifest): void {
  if (!isSafeSegment(manifest.id)) {
    throw new Error(`unsafe pack id: ${JSON.stringify(manifest.id)}`);
  }
  for (const { kind, file } of packFileEntries(manifest)) {
    if (!isSafeRelPath(file.path)) {
      throw new Error(`unsafe path for ${kind}: ${JSON.stringify(file.path)}`);
    }
    if (!Number.isInteger(file.bytes) || file.bytes < 0) {
      throw new Error(`invalid byte count for ${kind}: ${file.bytes}`);
    }
  }
}

/**
 * Download one pack file, continuing a previous partial download instead of
 * starting over (the backend serves /packs with HTTP range support, and
 * resumeAsync requests `Range: bytes=<partial size>-`). A file a previous
 * attempt already completed is kept as-is. The result is size-checked against
 * the manifest so a mangled resume (e.g. a proxy that ignored the Range
 * header) is deleted and retried from scratch rather than kept corrupt.
 */
async function downloadFile(
  url: string,
  target: string,
  expectedBytes: number,
  onBytes: (written: number) => void,
): Promise<void> {
  const partial = await FileSystem.getInfoAsync(target);
  if (partial.exists && partial.size === expectedBytes) {
    onBytes(expectedBytes);
    return;
  }
  let resumeFromBytes = partial.exists ? partial.size : 0;
  if (resumeFromBytes > expectedBytes) {
    // Leftover from something else (e.g. an older pack version) — not resumable.
    await FileSystem.deleteAsync(target, { idempotent: true });
    resumeFromBytes = 0;
  }
  const download = FileSystem.createDownloadResumable(url, target, {}, (p) =>
    onBytes(Math.min(p.totalBytesWritten, expectedBytes)),
  );
  const result =
    resumeFromBytes > 0 ? await download.resumeAsync() : await download.downloadAsync();
  const status = result?.status ?? 0;
  if (status !== 200 && status !== 206) {
    throw new Error(`download failed: HTTP ${status || '?'}`);
  }
  const done = await FileSystem.getInfoAsync(target);
  if (!done.exists || done.size !== expectedBytes) {
    await FileSystem.deleteAsync(target, { idempotent: true });
    throw new Error('download incomplete — tap again to retry');
  }
}

/**
 * Streamed lowercase-hex SHA-256 of a file.
 *
 * The native digest is used where it exists: a pack file is hundreds of
 * megabytes and reading one back through base64 into a JS hasher takes minutes
 * on a phone — long enough that a finished background download looked stuck.
 * The base64 loop stays as the fallback (and is what the unit tests exercise),
 * chunked so memory stays flat.
 */
async function hashFile(uri: string, bytes: number): Promise<string> {
  const native = await nativeSha256(uriToPath(uri)).catch(() => null);
  if (native) return native;
  const hasher = createSha256();
  for (let position = 0; position < bytes; position += HASH_CHUNK_BYTES) {
    const length = Math.min(HASH_CHUNK_BYTES, bytes - position);
    const b64 = await FileSystem.readAsStringAsync(uri, {
      encoding: FileSystem.EncodingType.Base64,
      position,
      length,
    });
    hasher.update(base64ToBytes(b64));
  }
  return hasher.hex();
}

/**
 * Verify a just-downloaded artifact against the manifest. The size is already
 * checked in downloadFile; this adds the SHA-256 digest when the manifest
 * carries one, catching a same-size-but-corrupt file (a bad resume, a truncated
 * proxy body) before it can be unpacked or swapped into place. A corrupt file is
 * deleted so the next attempt re-downloads it from scratch.
 */
async function verifyDigest(target: string, file: RegionPackFile): Promise<void> {
  if (!file.sha256) return; // pre-digest pack: size check is all we have
  const actual = await hashFile(target, file.bytes);
  if (actual.toLowerCase() !== file.sha256.toLowerCase()) {
    await FileSystem.deleteAsync(target, { idempotent: true });
    throw new Error('checksum mismatch — the download was corrupt, tap again to retry');
  }
}

/**
 * Prepare `<id>.staging` for this manifest version. A staging dir left by an
 * interrupted attempt for the *same* version is kept so its finished files can
 * be resumed/reused; one for any other version (or with no version marker) is a
 * stale in-progress build and is wiped so old files can't be mistaken for new.
 *
 * The marker carries the whole manifest, not just the version: a download that
 * finishes in the background outlives the app that started it, so the next
 * launch has to be able to pick a staging directory up and finish installing it
 * knowing nothing else.
 */
export async function prepareStaging(staging: string, manifest: RegionPackManifest): Promise<void> {
  if (await exists(staging)) {
    let sameVersion = false;
    try {
      const raw = await FileSystem.readAsStringAsync(`${staging}/${STAGING_MARKER}`);
      sameVersion = (JSON.parse(raw) as { version?: number }).version === manifest.version;
    } catch {
      sameVersion = false;
    }
    if (!sameVersion) await FileSystem.deleteAsync(staging, { idempotent: true });
  }
  await FileSystem.makeDirectoryAsync(staging, { intermediates: true });
  await FileSystem.writeAsStringAsync(
    `${staging}/${STAGING_MARKER}`,
    JSON.stringify({ version: manifest.version, manifest }),
  );
}

/**
 * Packs with a staging directory left over from an unfinished download, newest
 * marker wins. These are what the app reconciles at launch: the bytes may have
 * landed in the background (finish the install) or the attempt may have stopped
 * half way (offer to resume).
 */
export async function pendingStagingPacks(): Promise<RegionPackManifest[]> {
  let entries: string[];
  try {
    entries = await FileSystem.readDirectoryAsync(PACKS_DIR);
  } catch {
    return [];
  }
  const pending: RegionPackManifest[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(STAGING_SUFFIX)) continue;
    try {
      const raw = await FileSystem.readAsStringAsync(`${packDir(entry)}/${STAGING_MARKER}`);
      const marker = JSON.parse(raw) as { manifest?: RegionPackManifest };
      // A marker written before the manifest was recorded (or a foreign dir):
      // nothing here can be finished without knowing what it was meant to be.
      if (marker.manifest?.id) pending.push(marker.manifest);
    } catch {
      // Unreadable marker — leave it for the next download of that pack to wipe.
    }
  }
  return pending;
}

/** Where one pack file is served from. */
function fileUrl(manifest: RegionPackManifest, file: RegionPackFile): string {
  const base = manifest.downloadBase ?? `/packs/${manifest.id}`;
  return `${getServerOrigin()}${base}/${file.path}`;
}

/** True once a zip has been unpacked and marked complete. */
async function unzipped(staging: string, file: RegionPackFile): Promise<boolean> {
  return await exists(`${unzipDirFor(staging, file)}/${UNZIP_MARKER}`);
}

/**
 * Where an archive unpacks to. The rule lives in `@atlas/core` (the archive's
 * own path, minus `.zip`) so a new kind of pack file needs no naming rule here
 * — and `assets.zip` keeps unpacking to `assets/`, where every already-installed
 * pack has it.
 */
function unzipDirFor(staging: string, file: RegionPackFile): string {
  return `${staging}/${packUnzipDir(file)}`;
}

/**
 * The files of a pack still missing from its staging directory, as the native
 * download worker wants them (plain paths, no file:// prefix). A file already
 * there at the right size — or an archive already unpacked — is left out, which
 * is what makes an interrupted download resume rather than restart.
 */
export async function pendingPackFiles(
  manifest: RegionPackManifest,
): Promise<{ url: string; path: string; bytes: number }[]> {
  const staging = stagingDir(manifest.id);
  const missing: { url: string; path: string; bytes: number }[] = [];
  for (const { file } of packFileEntries(manifest)) {
    if (file.path.endsWith('.zip') && (await unzipped(staging, file))) continue;
    const info = await FileSystem.getInfoAsync(`${staging}/${file.path}`);
    if (info.exists && info.size === file.bytes) continue;
    missing.push({ url: fileUrl(manifest, file), path: file.path, bytes: file.bytes });
  }
  return missing;
}

/**
 * Confirm every file the manifest references is present in staging at the right
 * size (zips as their unpacked dir + completion marker) — a last guard before
 * the swap so a stale skip-marker or a partial file can never ship.
 */
async function validateStaging(staging: string, manifest: RegionPackManifest): Promise<void> {
  for (const { kind, file } of packFileEntries(manifest)) {
    if (file.path.endsWith('.zip')) {
      if (!(await unzipped(staging, file))) {
        throw new Error(`missing unpacked ${kind}`);
      }
    } else {
      const info = await FileSystem.getInfoAsync(`${staging}/${file.path}`);
      if (!info.exists || info.size !== file.bytes) {
        throw new Error(`missing or wrong-size ${kind}`);
      }
    }
  }
}

/**
 * Atomically replace the live pack with the validated staging dir, keeping the
 * previous good pack at `<id>.old` until the new one is in place. If the final
 * move fails (e.g. out of space), the old pack is rolled back so the user is
 * never left without offline data.
 */
async function swapIntoPlace(staging: string, live: string): Promise<void> {
  const backup = `${live}${BACKUP_SUFFIX}`;
  await FileSystem.deleteAsync(backup, { idempotent: true });
  const hadLive = await exists(`${live}/pack.json`);
  if (hadLive) {
    await FileSystem.moveAsync({ from: live, to: backup });
  } else {
    // No valid live pack, but a half-written dir might still be sitting there.
    await FileSystem.deleteAsync(live, { idempotent: true });
  }
  try {
    await FileSystem.moveAsync({ from: staging, to: live });
  } catch (err) {
    if (hadLive) {
      await FileSystem.deleteAsync(live, { idempotent: true }).catch(() => {});
      await FileSystem.moveAsync({ from: backup, to: live }).catch(() => {});
    }
    throw err;
  }
  await FileSystem.deleteAsync(backup, { idempotent: true });
}

/**
 * Download every file of a pack into a staging directory, unzipping archives
 * (assets) as they land — the Valhalla routing tar is read in place, no
 * unpacking. Downloads are incremental: an interrupted attempt keeps its
 * partial files and the next attempt resumes them (and skips finished ones).
 * Each file is size- and (when the manifest carries a digest) SHA-256-checked
 * before it counts as done; only once the whole staging dir validates is it
 * atomically swapped into place, so a lost network, a corrupt file or a full
 * disk leaves any previously installed pack untouched.
 */
export async function downloadPack(
  manifest: RegionPackManifest,
  onProgress: PackProgress,
): Promise<LocalPack> {
  validatePackManifest(manifest);
  const live = packDir(manifest.id);
  const staging = stagingDir(manifest.id);
  await prepareStaging(staging, manifest);

  const entries = packFileEntries(manifest);
  const totalBytes = entries.reduce((sum, { file }) => sum + file.bytes, 0) || 1;
  let doneBytes = 0;

  for (const { file } of entries) {
    const url = fileUrl(manifest, file);
    const target = `${staging}/${file.path}`;
    const isZip = file.path.endsWith('.zip');
    const unzipDir = unzipDirFor(staging, file);

    // An archive a previous attempt already unpacked *and marked complete* (the
    // marker is written last, so a half-finished unzip is not mistaken for done).
    if (isZip && (await unzipped(staging, file))) {
      doneBytes += file.bytes;
      onProgress(doneBytes / totalBytes);
      continue;
    }

    try {
      await downloadFile(url, target, file.bytes, (written) =>
        onProgress((doneBytes + written) / totalBytes),
      );
      await verifyDigest(target, file);
    } catch (err) {
      throw err instanceof Error ? new Error(`${file.path}: ${err.message}`) : err;
    }
    doneBytes += file.bytes;
    onProgress(doneBytes / totalBytes);
    if (isZip) {
      // Clear any half-unzip from a crashed attempt, then mark completion last.
      await FileSystem.deleteAsync(unzipDir, { idempotent: true });
      await unzip(uriToPath(target), uriToPath(unzipDir));
      await FileSystem.writeAsStringAsync(`${unzipDir}/${UNZIP_MARKER}`, '');
      await FileSystem.deleteAsync(target, { idempotent: true });
    }
  }

  await validateStaging(staging, manifest);
  // Housekeeping marker is not part of the shipped pack.
  await FileSystem.deleteAsync(`${staging}/${STAGING_MARKER}`, { idempotent: true });
  // pack.json is written last — its presence in the live dir marks a complete pack.
  await FileSystem.writeAsStringAsync(`${staging}/pack.json`, JSON.stringify(manifest));
  await swapIntoPlace(staging, live);
  return { manifest, dir: live };
}

export async function deletePack(id: string): Promise<void> {
  await FileSystem.deleteAsync(packDir(id), { idempotent: true });
  // Drop any in-progress staging or interrupted-swap backup for this pack too.
  await FileSystem.deleteAsync(stagingDir(id), { idempotent: true });
  await FileSystem.deleteAsync(`${packDir(id)}${BACKUP_SUFFIX}`, { idempotent: true });
}

/** Native code (unzip, the download worker, hashing) wants plain paths, not file:// URIs. */
export function uriToPath(uri: string): string {
  return uri.replace(/^file:\/\//, '');
}
