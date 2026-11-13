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
- **A style-name assertion cannot see a switch between two styles that differ only in `name`.**
  MapLibre's style diff has no operation for `name`, so `setStyle` of an otherwise identical style
  is a no-op and `getStyle().name` keeps the old value. On the one-layer fixture styles Explore and
  Drive are exactly that (v0.227.0's 3D test); assert what the switch changes instead
  (`style.terrain`, the control's label).

- **Activity profiles are a dropdown since 2026-10-06 (`df662f4`), not a radio row.** Their
  `radio` rows exist only while the switcher is open, so `getByRole('radio', { name: 'Hike' })`
  on a closed map waits out the 60 s timeout. Use `pickProfile(page, 'Hike')` from `helpers.ts`.
  Eight `core.spec.ts` tests sat broken this way until v0.261.0 because nobody ran that spec.
- **Settings covers the bottom-right control column** (it always has: both are anchored right).
  A test that needs the profile or layer switcher with a drawer open must use Collections, on the
  left — a click through Settings fails with "settings-panel subtree intercepts pointer events".
- **A collapsed track row's actions live in its ⋯ menu** (`More actions for <name>` → the
  `<name> actions` group), not as buttons on the row.

Known flake: `core.spec.ts` "a freshly launched batch is drawn as a purple train" clicks a
satellite dot that keeps orbiting between the projection and the click; it failed once mid-suite
and passed alone on 2026-10-31.

Known flake: `core.spec.ts` "direction-arrow source is selectable and persists" gives the OPFS
write 250 ms before reloading and can read the old value when it runs mid-suite. It passes on its
own; re-run it alone before suspecting settings persistence.

Observed 2026-10-04: `nav.spec.ts` "navigate to a dropped pin" reached its route line,
alternative ETA chip and speed limit, then timed out waiting for `.nav-camera-chip` twice,
including a single-test rerun. The mocked camera response or its delivery to the session needs
investigation; do not infer that a route-choice UI failure caused this later assertion.

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

Planner geometry trap (2026-10-30): after Undo reframes a route, its first marker can sit beneath
the elevation panel. A timed-out marker click whose call log says the profile SVG intercepts
pointer events is an occluded map target. Close the profile before choosing that point, as a
user must; do not force-click through the panel or change route logic for the test.

## Screenshot review tour (responsive web)

`apps/web/scripts/play-review*.mjs` mirrors the Android review runner, tour, interaction helpers
and report adapter. Both use `scripts/screenshot-review-report.mjs` for the artifact format.
It captures a **running Atlas web app**; it does not start or stop a server. The default origin
is the local deployed backend, `http://127.0.0.1:3100`; `--url` chooses another Atlas origin and
checks `/api/health` before running. To review local source, start the production-shaped server
above on a free port, e.g. `E2E_PORT=3198 sh apps/web/e2e/serve.sh`, and use `--url` for that port.
Never kill an unrelated process using the default test port.

Run in the same matching Playwright container as the suite, with a writable artifact mount:

```sh
node apps/web/scripts/play-review.mjs --list   # no browser needed

docker run --rm --network host \
  -v "$PWD":/work -v /tmp:/reviews -w /work \
  -u "$(id -u):$(id -g)" -e HOME=/tmp \
  mcr.microsoft.com/playwright:v1.61.1-noble \
  node apps/web/scripts/play-review.mjs --tour --size phone,tablet,desktop \
  --out /reviews/atlas-web-review
```

Use a new/empty output folder each time. `--only Collections,Settings` selects tour areas;
`--screen Map/place` selects one recipe. `--size all` includes `phone-small` 360×640,
`phone` 390×844, `tablet` 800×1280 and `desktop` 1440×1000, all CSS pixels at DPR 1.
The default size is desktop. `--landscape` swaps portrait viewport dimensions. This is responsive
Chromium, not a real mobile browser/keyboard. The tour opens panels and tabs without saving
settings; every recipe gets a fresh browser context with one page, an empty OPFS library, no
account, light theme, en-GB locale and Europe/Oslo timezone. It never reads a personal browser
profile. Live backend data is used without mocks; review captures can therefore vary over time.

Outputs: PNGs by area, offline `index.html` with search/size filters, `manifest.json` with recipes,
viewports, dimensions, SHA-256, capture times, deployed commit, browser version, browser errors
and map readiness, plus `REVIEW.md` with context, limits and review prompts. Fonts and initial
map readiness are awaited with bounded timeouts, then screenshots wait for three identical
frames (caret hidden and finite CSS animations finished). A changing/unfinished screen is
flagged as unsettled, not quietly treated as a complete render. No screenshot proves all APIs
finished or an operation works. `--compare` remains planned.

Failures return nonzero and preserve a partial report, `<screen>.failed.png` where possible and
`failure.txt`; inspect those before retrying. SIGINT/SIGTERM stop at the next boundary, close
the browser and retain the report. The first tour covers map/pin, search, Collections' three
views, Explore, destination-only planner, layer catalog and Settings. Populated library,
signed-in, dark theme and running navigation variants remain outside this first tour.

Review locator trap (2026-11-13): the search input is `type="search"`, whose implicit role is
`searchbox`, not `textbox`. Use its accessible label (`Search places`) in review steps.
