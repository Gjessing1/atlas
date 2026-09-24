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
  A layer that is already on moves to Active and is hidden from its category until switched off.
- **The place card's icon buttons are named by `aria-label`, not by their visible text.** Two
  buttons both _read_ "Nearby"; their names are "Photos nearby" and "Nearby places". Edit, Share
  and Weather are icon-only with those names.
- **There is no Route button.** Open the planner the way a user does, with a right-click on the
  map and Directions on the card: `openRoutePlannerAt(page, lat, lng)` in `helpers.ts`. The
  container has no geolocation, so Directions leaves a one-stop destination and asks for the
  start; the next map click is inserted before that destination.
- **The place card's title is no longer its only `strong`.** `Opening hours`, `More information`
  and `Explore nearby` are headings in the same card (v0.233.0), so `card.locator('strong')` is a
  strict-mode violation. Use `.place-card-titles > strong`.
- **`More information` starts open for anything that is not a queried POI.** A dropped pin, a
  search hit or a saved place leads with its map facts (`placeLeadsWithMapFacts`), so clicking that
  row _hides_ Elevation and Daylight instead of revealing them. Only a business POI starts folded.
- **Today's opening hours depend on the day the suite runs.** The POI fixture opens `Mo-Sa
08:00-22:00`, so a Sunday run reads `Today Closed` and `● Closed · Opens tomorrow 08:00`. Assert
  the week inside the expanded section, or the status line as a pattern — never a literal time as
  today's.
- **Current speed lives in `.nav-speed-cluster`** (with the limit sign), not in `.nav-widget`.
- **Commute configuration is behind the header's ⋮** (v0.235.0): click `Commute settings` before
  `Rename commute`, `Add commute`, `Edit commute` or the Android-widget choice, and again for each
  one (every row closes the menu). The `Saved commute` select only exists with two or more
  commutes. A journey card's clock times and platforms are in its itinerary, behind `Details` on
  the lead card (a row opens on its head); the planner hand-off is `Open in planner`, inside it.

- **A style-name assertion cannot see a switch between two styles that differ only in `name`.**
  MapLibre's style diff has no operation for `name`, so `setStyle` of an otherwise identical style
  is a no-op and `getStyle().name` keeps the old value. On the one-layer fixture styles Explore and
  Drive are exactly that (v0.227.0's 3D test); assert what the switch changes instead
  (`style.terrain`, the control's label).

Known stale test (2026-09-18, not yet fixed): `core.spec.ts` "transit stop search plans exact stops
and starts guided transit" waits for a "Search for a destination" box, but with no geolocation the
planner now asks "Search for a start" after the only stop is changed. It fails the same way on a
tree whose planner the change did not touch.

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
