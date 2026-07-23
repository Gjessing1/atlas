import type { RegionPackFile, RegionPackManifest, RegionsResponse } from '@atlas/core';
import * as FileSystem from 'expo-file-system/legacy';
import { unzip } from 'react-native-zip-archive';

import { getServerOrigin } from '../serverOrigin';

/** file:// URI of the directory holding one downloaded pack per subdirectory. */
export const PACKS_DIR = `${FileSystem.documentDirectory}packs/`;

export interface LocalPack {
  manifest: RegionPackManifest;
  /** file:// URI of the pack directory (no trailing slash). */
  dir: string;
}

export function packDir(id: string): string {
  return `${PACKS_DIR}${id}`;
}

/** Downloaded packs = subdirectories with a pack.json (written last, so its
 * presence means the download completed). */
export async function listLocalPacks(): Promise<LocalPack[]> {
  const packs: LocalPack[] = [];
  let entries: string[];
  try {
    entries = await FileSystem.readDirectoryAsync(PACKS_DIR);
  } catch {
    return packs; // no packs dir yet
  }
  for (const entry of entries) {
    try {
      const raw = await FileSystem.readAsStringAsync(`${packDir(entry)}/pack.json`);
      packs.push({ manifest: JSON.parse(raw) as RegionPackManifest, dir: packDir(entry) });
    } catch {
      // half-downloaded or foreign dir — not a usable pack
    }
  }
  return packs;
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
 * Download every file of a pack into its directory, unzipping archives
 * (assets) as they land — the Valhalla routing tar is read in place, no
 * unpacking. Downloads are incremental: an interrupted attempt keeps its
 * partial files and the next attempt resumes them (and skips finished ones).
 * pack.json is written only after everything succeeded — a crash mid-download
 * leaves no phantom pack.
 */
export async function downloadPack(
  manifest: RegionPackManifest,
  onProgress: PackProgress,
): Promise<LocalPack> {
  const dir = packDir(manifest.id);
  // Updating an installed pack: wipe it first so same-sized (or unzipped) files
  // from the old version can't be mistaken for already-downloaded pieces.
  // Interrupted first-time downloads have no pack.json and resume untouched.
  if ((await FileSystem.getInfoAsync(`${dir}/pack.json`)).exists) {
    await FileSystem.deleteAsync(dir, { idempotent: true });
  }
  await FileSystem.makeDirectoryAsync(dir, { intermediates: true });

  const entries = Object.entries(manifest.files).filter(
    (e): e is [string, RegionPackFile] => e[1] !== undefined,
  );
  const totalBytes = entries.reduce((sum, [, f]) => sum + f.bytes, 0) || 1;
  let doneBytes = 0;

  for (const [kind, file] of entries) {
    const base = manifest.downloadBase ?? `/packs/${manifest.id}`;
    const url = `${getServerOrigin()}${base}/${file.path}`;
    const target = `${dir}/${file.path}`;
    const isZip = file.path.endsWith('.zip');
    // assets.zip → <dir>/assets/…
    const unzipDir = kind === 'assets' ? `${dir}/assets` : `${dir}/${kind}`;

    // An archive a previous attempt already unpacked (the .zip is deleted
    // right after unzipping, so the unpacked dir is the completion marker).
    if (isZip && (await FileSystem.getInfoAsync(unzipDir)).exists) {
      doneBytes += file.bytes;
      onProgress(doneBytes / totalBytes);
      continue;
    }

    try {
      await downloadFile(url, target, file.bytes, (written) =>
        onProgress((doneBytes + written) / totalBytes),
      );
    } catch (err) {
      throw err instanceof Error ? new Error(`${file.path}: ${err.message}`) : err;
    }
    doneBytes += file.bytes;
    onProgress(doneBytes / totalBytes);
    if (isZip) {
      await unzip(uriToPath(target), uriToPath(unzipDir));
      await FileSystem.deleteAsync(target, { idempotent: true });
    }
  }

  await FileSystem.writeAsStringAsync(`${dir}/pack.json`, JSON.stringify(manifest));
  return { manifest, dir };
}

export async function deletePack(id: string): Promise<void> {
  await FileSystem.deleteAsync(packDir(id), { idempotent: true });
}

/** react-native-zip-archive wants plain filesystem paths, not file:// URIs. */
function uriToPath(uri: string): string {
  return uri.replace(/^file:\/\//, '');
}
