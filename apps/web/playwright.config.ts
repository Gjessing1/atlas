import { defineConfig } from '@playwright/test';

const PORT = Number(process.env['E2E_PORT'] ?? 3199);

/**
 * Web e2e suite. The dev host has no browser libraries, so run the tests
 * through the official Playwright container (see e2e/README.md); the server
 * can be pre-started on the host (reuseExistingServer) or auto-started here.
 */
export default defineConfig({
  testDir: './e2e',
  // OPFS user storage is single-tab (the SAH pool takes exclusive file
  // handles): never run tests in parallel against one origin, and keep at
  // most one page open per context.
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
  },
  webServer: {
    command: 'sh e2e/serve.sh',
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: true,
    timeout: 240_000,
  },
});
