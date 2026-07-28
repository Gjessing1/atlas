/** The one call we need, declared locally so the require below stays lazy. */
type ClipboardModule = { Clipboard: { setString(text: string): void } };

/**
 * Put text on the system clipboard.
 *
 * React Native's own `Clipboard` rather than `expo-clipboard`, deliberately:
 * the module is already compiled into the app binary, so "copy coordinates"
 * ships as an ordinary OTA update. Adding the Expo module would make one button
 * a native change — a new APK, a runtime-version bump, and every device stuck
 * on the old bundle until it downloads one. It is deprecated upstream and warns
 * once in development; the import is inside the function so that warning only
 * appears if a user actually copies something.
 *
 * If a future release needs a native build for its own reasons, this is the one
 * place to swap in `expo-clipboard`.
 */
export function copyToClipboard(text: string): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Clipboard } = require('react-native') as ClipboardModule;
  Clipboard.setString(text);
}
