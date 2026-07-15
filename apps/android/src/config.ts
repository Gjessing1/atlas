/**
 * Atlas server origin. `10.0.2.2` is the host loopback as seen from the
 * Android emulator (backend dev port 3100). Real devices set
 * EXPO_PUBLIC_ATLAS_SERVER to the deployed server origin at build time.
 */
export const SERVER_ORIGIN = (
  process.env.EXPO_PUBLIC_ATLAS_SERVER ?? 'http://10.0.2.2:3100'
).replace(/\/+$/, '');
