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
 * Download every file of a pack into its directory, unzipping archives
 * (assets) as they land — the Valhalla routing tar is read in place, no
 * unpacking. pack.json is written only after everything succeeded — a crash
 * mid-download leaves no phantom pack.
 */
export async function downloadPack(
  manifest: RegionPackManifest,
  onProgress: PackProgress,
): Promise<LocalPack> {
  const dir = packDir(manifest.id);
  await FileSystem.makeDirectoryAsync(dir, { intermediates: true });

  const entries = Object.entries(manifest.files).filter(
    (e): e is [string, RegionPackFile] => e[1] !== undefined,
  );
  const totalBytes = entries.reduce((sum, [, f]) => sum + f.bytes, 0) || 1;
  let doneBytes = 0;

  for (const [kind, file] of entries) {
    const url = `${getServerOrigin()}/packs/${manifest.id}/${file.path}`;
    const target = `${dir}/${file.path}`;
    const download = FileSystem.createDownloadResumable(url, target, {}, (p) => {
      onProgress((doneBytes + p.totalBytesWritten) / totalBytes);
    });
    const result = await download.downloadAsync();
    if (!result || result.status !== 200) {
      throw new Error(`download failed: ${file.path} (HTTP ${result?.status ?? '?'})`);
    }
    doneBytes += file.bytes;
    onProgress(doneBytes / totalBytes);
    if (file.path.endsWith('.zip')) {
      // assets.zip → <dir>/assets/…
      const targetDir = kind === 'assets' ? `${dir}/assets` : `${dir}/${kind}`;
      await unzip(uriToPath(target), uriToPath(targetDir));
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
