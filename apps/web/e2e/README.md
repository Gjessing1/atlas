# Web e2e suite

The dev host has no browser libraries, so the tests run through the official
Playwright container (version must match `@playwright/test` in
`apps/web/package.json`). The server is production-shaped: `e2e/serve.sh`
builds everything, serves the web bundle from the backend same-origin, and
uses in-memory auth/sync stores (`DATABASE_URL=memory`) — no Postgres needed.

```sh
# 1. Start the server on the host (or let the container's webServer config do it):
sh apps/web/e2e/serve.sh &          # port 3199, wait for /api/health

# 2. Run the suite in the container (host networking reaches the server):
docker run --rm --network host \
  -v "$PWD":/work -w /work/apps/web \
  -u "$(id -u):$(id -g)" -e HOME=/tmp \
  mcr.microsoft.com/playwright:v1.61.1-noble \
  npx playwright test
```

Constraints (see `playwright.config.ts`): OPFS user storage is single-tab, so
the suite runs with one worker, never in parallel, and persistence tests must
close the first page before opening a second one in the **same** context
(OPFS is per-context in Playwright).

## Performance measurement (`perf.spec.ts`)

`perf.spec.ts` logs the ARCHITECTURE.md performance numbers (map startup,
FPS during an animated pan+zoom). It has no assertions — under the default
SwiftShader software rendering the numbers are meaningless. For real numbers
pass the host iGPU through:

```sh
docker run --rm --network host \
  --device /dev/dri \
  --group-add "$(getent group render | cut -d: -f3)" \
  --group-add "$(getent group video | cut -d: -f3)" \
  -v "$PWD":/work -w /work/apps/web \
  -u "$(id -u):$(id -g)" -e HOME=/tmp \
  mcr.microsoft.com/playwright:v1.61.1-noble \
  npx playwright test e2e/perf.spec.ts
```

Verified 2026-07-17 (Alder Lake-N iGPU, production build, live Photon +
Valhalla): map startup (nav → first map idle) 1.81–1.87 s, animated
rendering 59–60 FPS, search via `/api/search` 58–80 ms, `/api/route`
27 ms (urban) – 262 ms (Oslo→Bergen), page load event ~120 ms.
