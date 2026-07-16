/**
 * Atlas server origin, baked in at build time (not runtime-configurable).
 * Defaults to production so release builds always target the real server.
 * For emulator/dev, override at build time with
 * EXPO_PUBLIC_ATLAS_SERVER=http://10.0.2.2:3100 (host loopback from the
 * Android emulator, backend dev port 3100).
 */
export const SERVER_ORIGIN = (
  process.env.EXPO_PUBLIC_ATLAS_SERVER ?? 'https://atlas.gjessing.io'
).replace(/\/+$/, '');
