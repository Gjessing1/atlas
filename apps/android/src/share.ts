import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';

/** Filesystem-safe base name for a shared file (mirrors the web export sanitizer). */
export const sanitizeFileName = (name: string): string =>
  name.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'unnamed';

/**
 * Write a text document to the cache and hand it to the OS share sheet — the
 * mobile equivalent of the web app's `download()` (save/send a GPX/KML/JSON).
 */
export async function shareText(fileName: string, body: string): Promise<void> {
  const uri = `${FileSystem.cacheDirectory}${fileName}`;
  await FileSystem.writeAsStringAsync(uri, body);
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(uri);
  }
}
