import {
  useUserData as useSharedUserData,
  type UserData as SharedUserData,
  type UserDataPlatform,
} from '@atlas/app-hooks';
import * as FileSystem from 'expo-file-system/legacy';

import { openStorage } from './db';
import { shareText } from './share';

/** A file handed to the importer (from expo-document-picker); name drives the parser. */
export interface PickedFile {
  name: string;
  uri: string;
}

export type { ImportOptions, ImportResult } from '@atlas/app-hooks';
export type UserData = SharedUserData<PickedFile>;

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Decode a base64 string to bytes without relying on a global `atob` (Hermes
 * doesn't ship one everywhere) — needed to hand KMZ (zip) bytes to the parser.
 */
function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/[^A-Za-z0-9+/]/g, '');
  const len = Math.floor((clean.length * 3) / 4);
  const out = new Uint8Array(len);
  let p = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const a = B64.indexOf(clean[i]!);
    const b = B64.indexOf(clean[i + 1]!);
    const c = B64.indexOf(clean[i + 2]!);
    const d = B64.indexOf(clean[i + 3]!);
    const chunk = (a << 18) | (b << 12) | ((c < 0 ? 0 : c) << 6) | (d < 0 ? 0 : d);
    if (p < len) out[p++] = (chunk >> 16) & 0xff;
    if (c >= 0 && p < len) out[p++] = (chunk >> 8) & 0xff;
    if (d >= 0 && p < len) out[p++] = chunk & 0xff;
  }
  return out;
}

/**
 * Android configuration of the shared useUserData (@atlas/app-hooks): the
 * device's native SQLite (see ./db.ts), expo-document-picker files read via
 * expo-file-system, exports through the OS share sheet (full export as the
 * JSON dump — no binary zip over the share-text bridge).
 */
const platform: UserDataPlatform<PickedFile> = {
  openStorage,
  readFile: async (file) => {
    const isText = /\.(gpx|kml)$/i.test(file.name);
    const bytes = isText
      ? new TextEncoder().encode(await FileSystem.readAsStringAsync(file.uri))
      : base64ToBytes(await FileSystem.readAsStringAsync(file.uri, { encoding: 'base64' }));
    return { name: file.name, bytes };
  },
  saveTextFile: (name, body) => shareText(name, body),
};

export function useUserData(): UserData {
  return useSharedUserData(platform);
}
