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

## Running it, and what it does not catch

The suite is **not part of `npm run gate`**, so a UI change can pass the gate and still break it.
Run the specs a change touches before releasing, e.g.
`npx playwright test e2e/core.spec.ts e2e/nav.spec.ts` (55 tests across seven specs took 4.3 min).
Stop the server afterwards — by its PID from `ss -ltnp 'sport = :3199'` — because
`infrastructure/packs/publish-update.sh` refuses to start while port 3199 is taken.

Locator traps (v0.222.0):

- **Layer rows are `role="switch"`**, not buttons: `getByRole('switch', { name: 'Lake depth' })`.
  A layer that is already on is listed **twice** — under Active and in its own category — so
  a bare name locator hits a strict-mode violation; scope it to the group or turn the layer on
  from a fresh page.
- **The place card's icon buttons are named by `aria-label`, not by their visible text.** Two
  buttons both _read_ "Nearby"; their names are "Photos nearby" and "Nearby places". Edit, Share
  and Weather are icon-only with those names.
- **There is no Route button.** Open the planner the way a user does, with a right-click on the
  map and Directions on the card: `openRoutePlannerAt(page, lat, lng)` in `helpers.ts`. The
  container has no geolocation, so Directions leaves a one-stop plan and the next map click is
  appended _after_ it — the right-clicked point ends up as the start. (That ordering is a planner
  bug on the roadmap; a test that fixes it will need to flip these helpers' points.)
- **Current speed lives in `.nav-speed-cluster`** (with the limit sign), not in `.nav-widget`.

Known flake: `core.spec.ts` "direction-arrow source is selectable and persists" gives the OPFS
write 250 ms before reloading and can read the old value when it runs mid-suite. It passes on its
own; re-run it alone before suspecting settings persistence.

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
