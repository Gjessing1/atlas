import * as ExpoCrypto from 'expo-crypto';

/**
 * React Native's Hermes runtime ships no global Web Crypto, but the shared
 * packages call `crypto.randomUUID()` (available on the web and in Node) —
 * `@atlas/storage` for record ids and `@atlas/sync` for the device id. Without
 * this, every write / sync throws `ReferenceError: crypto is not defined`.
 *
 * Define a minimal global `crypto` backed by expo-crypto so the platform-neutral
 * packages run unchanged on-device. Must load before any storage/sync code — it
 * is imported first from index.ts.
 */
const existing = (globalThis as Record<string, unknown>)['crypto'] as
  { randomUUID?: unknown } | undefined;

if (!existing || typeof existing.randomUUID !== 'function') {
  (globalThis as Record<string, unknown>)['crypto'] = {
    ...existing,
    randomUUID: (): string => ExpoCrypto.randomUUID(),
    getRandomValues: <T extends ArrayBufferView>(array: T): T => {
      ExpoCrypto.getRandomValues(array as unknown as Uint8Array);
      return array;
    },
  };
}
