import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // The Expo workspace pins the React patch bundled with the native runtime,
    // while the DOM test renderer is hoisted at the monorepo root. Hooks and
    // renderer must share one React singleton during unit tests.
    alias: {
      react: fileURLToPath(new URL('../../node_modules/react', import.meta.url)),
    },
  },
});
