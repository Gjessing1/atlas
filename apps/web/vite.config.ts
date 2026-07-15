import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Dev only: the backend runs on :3100. In production both are same-origin.
      '/api': 'http://localhost:3100',
    },
  },
});
