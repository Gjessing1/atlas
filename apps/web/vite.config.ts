import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  // sqlite-wasm locates its .wasm relative to its own module URL; esbuild
  // pre-bundling would break that (and it only runs inside the worker anyway).
  optimizeDeps: {
    exclude: ['@sqlite.org/sqlite-wasm'],
  },
  worker: {
    // The storage worker is an ES module (it imports @atlas/storage/worker).
    format: 'es',
  },
  build: {
    // Vite's default assetsDir is "assets", which would collide with the
    // backend's /assets/ mount for map data (styles, glyphs, sprites).
    assetsDir: 'static',
    rollupOptions: {
      output: {
        // maplibre-gl is by far the largest dependency and changes only on
        // upgrades — its own chunk keeps app-code deploys cache-friendly.
        manualChunks: { maplibre: ['maplibre-gl'] },
      },
    },
  },
  server: {
    proxy: {
      // Dev only: the backend runs on :3100. In production both are same-origin.
      '/api': 'http://localhost:3100',
      '/tiles': 'http://localhost:3100',
      '/assets': 'http://localhost:3100',
    },
  },
});
