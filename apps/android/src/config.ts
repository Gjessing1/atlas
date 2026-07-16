/**
 * Compile-time default Atlas server origin. Release builds default to
 * production; override at build time with EXPO_PUBLIC_ATLAS_SERVER (e.g.
 * http://10.0.2.2:3100, the host loopback from the Android emulator, backend
 * dev port 3100).
 *
 * This is only the *default*: the effective origin is runtime-configurable in
 * Settings and persisted per device — see src/serverOrigin.ts. Read the live
 * value with getServerOrigin() / useServerOrigin(), never this constant.
 */
export const DEFAULT_SERVER_ORIGIN = (
  process.env.EXPO_PUBLIC_ATLAS_SERVER ?? 'https://atlas.gjessing.io'
).replace(/\/+$/, '');
