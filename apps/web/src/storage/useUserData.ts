import {
  useUserData as useSharedUserData,
  sanitizeFileName,
  type UserData as SharedUserData,
} from '@atlas/app-hooks';
import type { UserDataPlatform } from '@atlas/app-hooks';
import { awaitAvailability, openStorage } from './db.js';

export type { ImportOptions, ImportResult } from '@atlas/app-hooks';
export type UserData = SharedUserData<File>;
export { sanitizeFileName };

function download(fileName: string, bytes: Uint8Array, type: string): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Web configuration of the shared useUserData (@atlas/app-hooks): SQLite-WASM
 * over OPFS (see ./db.ts), DOM `File` inputs, browser downloads for exports
 * (full export as a zip).
 */
const platform: UserDataPlatform<File> = {
  openStorage,
  awaitAvailability,
  readFile: async (file) => ({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) }),
  saveTextFile: (name, body, mime) => {
    download(name, new TextEncoder().encode(body), mime);
    return Promise.resolve();
  },
  saveZipFile: (name, bytes) => {
    download(name, bytes, 'application/zip');
    return Promise.resolve();
  },
};

export function useUserData(): UserData {
  return useSharedUserData(platform);
}
