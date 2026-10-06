# Android e2e: the device regression and the test emulator

`run-regression.sh` installs a release-candidate APK on the `atlas_test` AVD, starts the fixture
backend on port 3199 (`fixture-server.mjs`) and drives the app (`regression.mjs`): saved
places and folders, road and transit planning, navigation hand-off, persistence, the commute board
and the home-screen commute widget. The ordinary OTA and APK publish scripts run it first. Native
releases use `publish-native.sh`, which tests one signed APK once, then publishes the APK and its
OTA baseline together. A failed regression publishes neither artifact:

```sh
infrastructure/packs/publish-update.sh           # OTA: builds the candidate APK, then tests it
infrastructure/packs/publish-native.sh apps/android/android/app/build/outputs/apk/release/app-release.apk 34 0.239.0
# Reuse an APK already built from this exact source (saves ~10 min per retry):
ATLAS_ANDROID_REGRESSION_APK=$PWD/apps/android/android/app/build/outputs/apk/release/app-release.apk \
  infrastructure/packs/publish-update.sh
```

Budget ~20 min for a regression, plus ~10 min when it has to build the APK itself. The native
script requires a clean committed worktree and the same commit deployed at `/api/health`; it
checks the APK's package and version before starting the device. **When a run
fails and you change only `regression.mjs` (or the fixture server), reuse the APK**: the app has
not changed, so rebuilding it buys nothing. On 2026-09-17 three retries that each fixed only the
script rebuilt an identical APK, 10 min apiece.

## Where the emulator runs: the Ally-X worker, then this host

`run-regression.sh` (and so every publish script) first offers the run to the **Ally-X worker**.
That is a Windows 11 handheld on the LAN with 8 cores, WHPX and a real GPU, shared by every
project on this host through `~/projects/sysadmin/ally-x-worker` (its README covers setup,
design and troubleshooting). Only the emulator runs there. `regression.mjs` and the fixture
server stay here and drive it through SSH forwards. Adb, `adb emu` and `10.0.2.2:3199` behave
as with a local AVD, so the scenario code does not know which backend it got.

| `ATLAS_ANDROID_BACKEND` | behaviour                                                                    |
| ----------------------- | ---------------------------------------------------------------------------- |
| `auto` (default)        | the worker if it is healthy; otherwise this host's `atlas_test`, said loudly |
| `ally-x`                | the worker or fail — for comparing backends, or when this host is busy       |
| `local`                 | this host only, never touching the worker                                    |

- **A fallback happens only before anything ran on the worker.** The worker is unreachable, is
  unhealthy (on battery, < 6 GB RAM, CPU > 40 % because someone is gaming on it, toolchain
  missing), is busy with another project's session, or fails to boot. Its client exits 75 then,
  and only then does the run move here. Once `regression.mjs` has started on the worker, a red
  run is a red run. Every run ends with `Android regression backend: <ally-x|local> — passed/failed after N s`.
- **On the worker this host's state doesn't matter.** CI, swap and load checks guard the
  _local_ AVD only, so a regression can run on the worker while CI builds here.
- **The local AVD waits for a quiet host.** Before a local run, the script refuses if Forgejo
  CI is running. It waits up to 10 min (`ATLAS_ANDROID_LOAD_WAIT_SECONDS`) for the 1-minute load
  to fall to 3 or below (`ATLAS_ANDROID_MAX_LOCAL_LOAD`), printing the busiest processes, e.g. a
  video encode or the candidate's own Gradle build. Then the swap check below runs.
- **Results:** a worker run also writes `artifacts/ally-x/`: `logcat.txt` for the whole session,
  `emulator.log`, and `session.txt` with boot, install, command and total seconds. These are
  written on success too. The usual failure artifacts (`failure.png`, `window.xml`, …) are
  written by `regression.mjs` as before.
- **The worker's AVD renders with the Radeon iGPU**, not SwiftShader. A symbol-layer screenshot
  from it can therefore differ from one taken here; see the next sections for this host's AVD.

## The emulator fails for reasons that are not the app

The AVD is software-rendered (`swiftshader_indirect`) on a host that also runs CI, Forgejo and
other services. Most red runs are the host, not Atlas. **Read the failure before re-running, and
never re-run blind more than once.**

### A busy host fails the first text field

The AVD's `system_server` stops answering while the host is loaded, and the regression then taps
**Wait** on "Process system isn't responding" over and over (`waiting out a system ANR dialog` in
the log). Taps and key events are lost meanwhile. The first victim is usually
`configureFixtureServer`: `Timed out waiting for server-origin to take focus`.

- **Don't start a regression while CI is running on this host.** A push to `main` starts a
  Forgejo job container (`docker ps | grep FORGEJO-ACTIONS-TASK`). Wait until it is gone. On
  2026-09-16 a regression started during CI's image build ANR'd nine times and failed, with a
  1-minute load average of 9–12.
- Check `uptime` first. Below ~3 has been reliable; a 15-minute average still near 8 has not.
- **The publish scripts heat the host themselves.** Building the candidate APK runs two Gradle
  JVMs and a parallel `clang++` over the native modules — load ~16 on this 4-core host
  (2026-09-17) — and the regression starts the moment it finishes. For a retry, build once, wait
  for `uptime` to fall, then run with `ATLAS_ANDROID_REGRESSION_APK`.

- **A cold boot straight after the APK build can fail the install itself.** With no
  `default_boot` snapshot the AVD cold-boots, and on 2026-09-19 (1-minute load 10.5 from the
  Gradle build) `adb install` died with `Failure calling service package: Broken pipe (32)` —
  `sys.boot_completed` had already read 1. `run-regression.sh` now waits for `pm path android`
  and retries the install; if it still fails, the APK is fine — rerun with
  `ATLAS_ANDROID_REGRESSION_APK` once the load falls.

### A full host swap wedges the AVD even with an idle CPU

On 2026-09-25 three runs of one APK failed identically at the very first text field
(`layer-quick-search to take focus`, in the POI step before the fixture), the third on a host at
load 0.5. Driven by hand, the AVD answered "Process system isn't responding" in a loop — `am_anr`
for SystemUI's KeyguardService at boot, then `Input dispatching timed out … Waited 5011ms for
FocusEvent` — so no field could take focus in any app. The host's swap was 100 % full (4095/4095 MB)
with ~2 GB available beside the 3 GB guest (qemu RSS 4.2 GB). The same step had passed the night
before on the same code.

- **Check `free -m` as well as `uptime` before a run.** A quiet CPU is not a quiet host: with swap
  full, the guest stalls in ways the load average does not show.
- **The harness checks host state before boot.** It refuses to overlap Forgejo CI and, when at
  least 1 GB of swap is used, clears it only if no Android device is running and available RAM
  exceeds the used swap by 2 GB. This host's `sudo` needs a password, so it uses the locally
  cached `alpine:3` image in a short-lived privileged Docker container as a fallback. It does
  not pull an image during a release. If the image is absent or RAM is insufficient, it stops
  before the emulator starts and says what to fix.
- **It is a host flake, not the app — but not one load predicts.** That day six runs of the same
  code: four failed this way (one at a 1-minute load of 0.5), two passed (at 2.5 and 1.8), both with
  a reused APK on a host that had cooled after its own Gradle build. Don't change the app over it;
  rerun with `ATLAS_ANDROID_REGRESSION_APK` once the build's heat has gone, and read `failure.png`
  each time — the Layers menu with an unfocused `Search layers` box is this shape.
- **Its second shape: the keyboard never closes after a search pick.** On 2026-09-28 (swap
  4095/4095 MB), three runs of one v0.238.0 APK, the last two reused at 1-minute loads of
  1.7, failed identically at `search result selection to hide the keyboard`. The destination sheet
  was open, the IME still showed over a blank map, and logcat had no ANR, no JS error and no IME
  timeout. The same step had passed about two hours earlier for v0.237.0, and the only app change
  between them was one line in `useStandBoard`. Three reruns do not clear this; free the swap
  first (a root `swapoff -a && swapon -a` once enough RAM is free), or wait for a quieter host.
- **The guest has 4 GB since 2026-09-29** (`start-emulator.sh`, `ATLAS_EMULATOR_MEMORY_MB`), up from
  3 GB after that failure. qemu's RSS runs about 1.2 GB above the guest size, so a run wants ~5 GB
  of host RAM available _after_ the swap has been freed — `swapoff` pulls every swapped page back
  into RAM first, and needs `available` in `free -m` to exceed swap `used` before it can finish.
  A 3 GB retry on 2026-09-29 produced repeated system ANRs before the first search control, so
  reducing guest RAM is not a useful response to host swap pressure. The harness now cold-boots
  without loading or saving snapshots and renders at 720×1600/280 dpi: the same 411×914 dp phone
  viewport with fewer SwiftShader pixels.

### Text input can drop even after the retries

`replaceText` types one key at a time and retries four times, re-focusing the field on each pass
(see `2c65eb8`). Under residual load (1-minute load 3–7 just after CI finished) all four passes
still arrived empty: `Timed out waiting for search-input to contain saved`. Logcat had **no ANR
and no JavaScript error**, and the field in `failure.png` still showed its placeholder, so the
keys never reached the IME. The same APK passed that step ten minutes later on a quieter host.
Since 2026-09-29 it deletes only the characters actually in a field before typing; injecting 100
Delete events into every empty field was needless load on `system_server`. The release baseline
reaches the POI categories by scrolling. Set `ATLAS_ANDROID_CHECK_LAYER_SEARCH=1` when changing
the Layers search interaction to also exercise its keyboard open/close. A destination card that
opened correctly but whose IME stayed visible is logged and recovered with Back, then the card
must still be present. Set `ATLAS_ANDROID_STRICT_SEARCH_IME=1` when changing search or keyboard
behavior to require automatic dismissal.

If a text step fails, look at `artifacts/logcat.txt` (`ReactNativeJS`, `FATAL`, `ANR in`) and
`artifacts/failure.png` before touching the app. A placeholder in the field plus a clean logcat
means the host dropped the input.

It has a second shape: **the field shows the text and the app never saw it.** On 2026-09-17
`route-stop-search` read `destination` in the dump, yet no result row and no status line rendered
(the next control sat directly under the box), with a clean logcat — the IME held the text without
delivering `onChangeText`. The same day dropped keys on three different fields
(`search-input`, `commute-search-to`, `route-stop-search`) across four runs, on hosts with a
1-minute load of 2–3.

So **don't add typing to a scenario that can avoid it.** Reach state by a tap where one exists (a
map tap adds a planner stop; a saved place's "Go" opens its card) and keep typing for the steps
that are _about_ search. Every typed step is another chance to lose a 25-minute run.

### Location: the AVD rarely delivers a fix

`emu geo fix` sets a position and the permissions are granted, but `getCurrentPositionAsync`
usually times out here (8 s) and last-known is empty after `pm clear`. Anything that plans _from
my location_ then lacks its start: Directions on a place card opens the planner holding only the
destination and explicitly asks for a start. The next searched or map-tapped stop is inserted
before that destination. Also:

- **Favorites "Go" opens the place's card, not the planner** — tap `destination-navigate` next.
- **Wait out the lookup before acting on the plan**, or a late fix and your own edit race: the fix
  only ever fills a one-stop plan, so adding the second stop yourself retires it.
  `openRouteFromSavedPlace` does both, adding the stop with a map tap above the sheet. The fixture
  routes and plans transit between any two points, so where the tap lands does not matter.
- **Count `route-wp-edit-*` rows to read the plan's state — never the stop box.** The AVD does
  sometimes deliver a fix, and then the plan already has both ends; adding a stop anyway makes it a
  3-point query, and Valhalla offers alternates for 2-point queries only
  (`packages/routing/src/valhalla.ts`), so the navigation preview comes up with `route-choice-0`
  alone and `expectIds` fails on `route-choice-1` — 20 minutes in, nowhere near the tap that caused
  it. The box used to vanish for a complete plan and stood in for this check; since v0.223.0 it
  stays visible so a third stop is one tap away, which made that guard silently dead.

### The rest of the traps

- **`setsid` does not wait.** `setsid ./build-apk.sh; echo done` prints `done` at once while
  Gradle keeps running. Prebuild has already deleted the previous APK by then, so it looks as if
  the build produced nothing. Wrap the whole thing and wait for a marker line:
  `setsid bash -c './build-apk.sh; echo "exit=$?"' > log 2>&1 &`.
- **Long jobs need `setsid` anyway.** Under memory pressure (a Gradle build holds ~2 GB) the
  agent harness kills its background tasks, but a `setsid` process survives. Watch it with a
  cheap polling loop, not a blocking one.
- **`TypeError: fetch failed` from a fixture read is a stale keep-alive socket, not a dead
  server.** `regression.mjs` drives adb through synchronous child processes, so its event loop
  can stay blocked past the fixture server's 5 s keep-alive timeout; the next `fetch` then reuses
  a socket the server already closed (`UND_ERR_SOCKET other side closed`). v0.243.0's stop-widget
  step failed this way twice, identically. `fixture-server.log` held only its startup line and the
  port stayed up throughout, so it looked like an OOM kill and was first rerun as a host flake.
  The `/api/e2e/*` reads answer `connection: close`; give any new test-only endpoint the same.
- **A stop widget can paint a previously served board after a fixture refresh.** The stop fixture
  advances departures on a 12-minute timetable grid. In v0.246.0, the launcher visibly showed
  a correct first departure while the regression compared it with the fixture's newer board and
  timed out. The fixture now keeps recent served boards and the check matches the visible row to
  one of them before asserting its time and line. The set of served boards must also be fetched
  on each launcher poll: in v0.246.2 the widget again visibly showed a correct row, but refreshed
  after the test's one-time fixture read, so the test timed out against a stale snapshot. Read
  `failure.png` and `window.xml` before treating this timeout as a widget bug.
- **Never `pkill -f 'node backend/dist/index.js'`.** The production container's backend matches
  too, and the kill is refused ("Operation not permitted"). Worse, the calling shell's own
  command line contains the pattern, so pkill kills the script itself (exit 144) along with
  your server. Kill your own server by its saved PID.
- **An ad-hoc script must pin portrait itself.** `accelerometer_rotation 0` alone left the AVD in
  landscape (2026-09-18), where the settings sheet shows two rows and `tapAfterScroll` gives up.
  Set `user_rotation 0` too, as `regression.mjs` does.
- **Offline behaviour is tested by stopping the server, not by a network switch.** Point the app
  at a throwaway backend (`PORT=… ATLAS_DATA_DIR=<scratch> node backend/dist/index.js`, with a pack
  under `<scratch>/packs/<id>/` — the `/packs/` route is only registered if that directory exists
  at startup), download what you need, then kill that backend by PID. Overlay and basemap tiles
  then fail exactly as they do with no signal; `pm clear` first so no streamed tile is cached.
- **An ad-hoc script must `am force-stop` the app first.** A run that dies with a menu or sheet
  open leaves its backdrop up, and the next run's first tap lands on it instead of the button.
- **`adb install -r` keeps app data.** The saved server origin, layer state and profile from the
  last run are still there. The regression starts with `pm clear`; an ad-hoc check can use that
  to skip reconfiguring.
- **Scrolling lists only dump what is on screen.** The layer quick menu's rows below the fold
  (the Weather group, Points of interest, Base map) are absent from `uiautomator dump`. Use
  `tapQuickLayer(id)` in `regression.mjs`, which scrolls within the visible `layer-quick-*`
  rows' bounds; a plain `tap()` of a foot row times out (v0.229.0's first POI run).
- **System Settings starts with updates and source health.** The server-origin field can be below
  the sheet's visible area even with healthy sources collapsed. Scroll to `server-origin` before
  entering a fixture URL; `waitForId` alone will time out on an off-screen field. After typing,
  dismiss the keyboard before tapping Save: the sticky Back button can cover Save while the
  keyboard is open, even though UiAutomator still reports Save in the view tree.
- **Tapping a backdrop "by id" taps its centre**, which is under the menu it backs, so it hits a
  menu row or header. Dismiss by tapping near the top of the screen — `closeQuickLayerMenu()`.
- **The Layers button does not exist after `configureFixtureServer()`.** The fixture answers
  `/api/layers` with `[]`, and Android renders `layer-quick-toggle` only while the overlay catalog
  is non-empty — so the built-in Points-of-interest and Base map switches live _behind_ it and are
  out of reach for the rest of the run. Anything that needs the quick layer menu has to run before
  the fixture, which also means it reads the **live** backend: the POI list filled with 94 real
  Oslo groceries and their real opening hours (2026-09-20), so assert the shapes the app owns — a
  row's category line, a formatted distance, a card that can show hours it parsed — never a name.
- **A `mode="map"` sheet swallows hardware Back** (`onClose`, return true). A sheet that is
  visible for as long as its layer is on therefore has to decline the press: `onBack` returning
  false hands Back back to the app, which is how the POI list avoids trapping the map (v0.233.0).
- **A search reveal can contaminate a later Collections check.** The v0.245.0 candidate found a
  folder and track correctly, but left the track name in the Collections filter after closing it.
  The later saved-place commute marker was therefore hidden, and the scroll helper could never
  reach it. A search reveal now expands and scrolls to the row without retaining a filter; the
  regression asserts the filter is empty immediately after each pick. On this AVD, UiAutomator
  reports an empty `TextInput`'s placeholder as its `text` attribute, so the assertion accepts
  either empty text or the filter placeholder (the first candidate retry's strict `text=""`
  assertion failed on a correct app).
- **A floating bottom menu must follow the IME's screen boundary.** Edge-to-edge Android did not
  resize the React window consistently when the quick-layer search took focus, so a menu positioned
  only from the bottom control rows disappeared behind the keyboard—including the button needed to
  close that search. Use `window.height - keyboard.endCoordinates.screenY` as an overlap (zero on
  devices that already resized) and lift the menu above the larger boundary (v0.234.0).
- **A sheet handle only ever expands.** `cycleSnap` runs peek → half → full → half, so tapping
  `…-sheet-handle` can never put a sheet back at peek; only a downward drag does. The POI list is
  reached by one tap on `poi-list-sheet-handle`, and the regression gets the map controls back by
  opening a place card (which unmounts the sheet) and closing it, so it remounts at peek.
- **The AVD draws no MapLibre symbol text.** Place names, wind arrows and temperature numbers are
  invisible here. Rasters, fills, circles and ordinary React Native views render and screenshot
  normally, so verify a symbol layer on a real device or through a temporary `circle` layer on
  the same source.
- **Check the clock.** A restored snapshot has come back 17 hours behind, which breaks every
  countdown and "N min ago". Compare `adb shell date` with the host's before judging anything with
  a time in it.
- **The route sheet's Start sits below `route-scroll`, not inside it** (it is a sticky footer since
  v0.222.0). `tapAfterScroll('route-navigate', 'route-scroll', …)` still works because it taps a
  node that is already visible before scrolling; a helper that only scrolls would not find it.
- **An auto-focused text field may be clipped after the keyboard opens.** The route sheet's inline
  Save track form can leave `route-save-name` focused while its bounds shrink to 3 pixels behind
  the sticky Start footer. `replaceText` must type into that focused field without waiting for a
  tappable box or tapping it again. The 2026-09-28 regression failed at "route-save-name to be
  visible" with the field focused and present in `window.xml`; its screenshot showed Track name
  above the footer and the input below it. This was a harness visibility assumption, not a route
  or keyboard data error.
- **Pointing the app at a local backend:** Settings → Server → `http://10.0.2.2:<port>` (the host
  from inside the emulator). Plain HTTP is allowed (`usesCleartextTraffic`).

## Looking at the Garmin screens without a Garmin account

`ATLAS_E2E_GARMIN=1 node apps/android/e2e/fixture-server.mjs` adds a signed-in account to the
fixture: any email and password signs in, sync accepts pushes and returns nothing, and
`/api/garmin/*` serves 12 courses, two watches and 205 GPS activities in the sport and year mix of
a real account (mostly running, a tail of ten other sports, 2022–2026). Point the app at it
(Settings → System → `http://10.0.2.2:3199`), sign in under Account & data, and Collections gains
its Garmin tab; the ↻ on its Activities card imports everything. The release regression does
not set the variable — it runs signed out, and the health check reports sync as unavailable.

## Artifacts

A failed run writes `apps/android/e2e/artifacts/`: `failure.png`, `failure.txt` (the error and the
last window dump), `window.xml`, `logcat.txt`, `activity.txt`, `emulator.log` and
`fixture-server.log`. The directory is wiped at the start of the next run, so copy anything you
need first.
