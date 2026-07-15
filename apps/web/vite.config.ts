import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  build: {
    // Vite's default assetsDir is "assets", which would collide with the
    // backend's /assets/ mount for map data (styles, glyphs, sprites).
    assetsDir: 'static',
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
