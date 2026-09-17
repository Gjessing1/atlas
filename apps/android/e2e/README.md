# Android e2e: the device regression and the test emulator

`run-regression.sh` installs a release-candidate APK on the `atlas_test` AVD, starts the fixture
backend on port 3199 (`fixture-server.mjs`) and drives the whole app (`regression.mjs`): saved
places and folders, road and transit planning, navigation hand-off, persistence, the commute board
and both home-screen widgets. Both publish scripts run it first, and a failed regression means
nothing was published:

```sh
infrastructure/packs/publish-update.sh           # OTA: builds the candidate APK, then tests it
# Reuse an APK already built from this exact source (saves ~10 min per retry):
ATLAS_ANDROID_REGRESSION_APK=$PWD/apps/android/android/app/build/outputs/apk/release/app-release.apk \
  infrastructure/packs/publish-update.sh
```

Budget ~20 min for a regression, plus ~10 min when it has to build the APK itself. **When a run
fails and you change only `regression.mjs` (or the fixture server), reuse the APK**: the app has
not changed, so rebuilding it buys nothing. On 2026-09-17 three retries that each fixed only the
script rebuilt an identical APK, 10 min apiece.

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

### Text input can drop even after the retries

`replaceText` types one key at a time and retries four times, re-focusing the field on each pass
(see `2c65eb8`). Under residual load (1-minute load 3–7 just after CI finished) all four passes
still arrived empty: `Timed out waiting for search-input to contain saved`. Logcat had **no ANR
and no JavaScript error**, and the field in `failure.png` still showed its placeholder, so the
keys never reached the IME. The same APK passed that step ten minutes later on a quieter host.

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

### The rest of the traps

- **`setsid` does not wait.** `setsid ./build-apk.sh; echo done` prints `done` at once while
  Gradle keeps running. Prebuild has already deleted the previous APK by then, so it looks as if
  the build produced nothing. Wrap the whole thing and wait for a marker line:
  `setsid bash -c './build-apk.sh; echo "exit=$?"' > log 2>&1 &`.
- **Long jobs need `setsid` anyway.** Under memory pressure (a Gradle build holds ~2 GB) the
  agent harness kills its background tasks, but a `setsid` process survives. Watch it with a
  cheap polling loop, not a blocking one.
- **Never `pkill -f 'node backend/dist/index.js'`.** The production container's backend matches
  too, and the kill is refused ("Operation not permitted"). Worse, the calling shell's own
  command line contains the pattern, so pkill kills the script itself (exit 144) along with
  your server. Kill your own server by its saved PID.
- **An ad-hoc script must `am force-stop` the app first.** A run that dies with a menu or sheet
  open leaves its backdrop up, and the next run's first tap lands on it instead of the button.
- **`adb install -r` keeps app data.** The saved server origin, layer state and profile from the
  last run are still there. The regression starts with `pm clear`; an ad-hoc check can use that
  to skip reconfiguring.
- **Scrolling lists only dump what is on screen.** The layer quick menu's rows below the fold
  (the Weather group, Base map) are absent from `uiautomator dump`. Scroll using the visible
  `layer-quick-*` rows' bounds until the target appears.
- **Tapping a backdrop "by id" taps its centre**, which is under the menu it backs, so it hits a
  menu row. Dismiss by tapping near the top of the screen.
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
- **Pointing the app at a local backend:** Settings → Server → `http://10.0.2.2:<port>` (the host
  from inside the emulator). Plain HTTP is allowed (`usesCleartextTraffic`).

## Artifacts

A failed run writes `apps/android/e2e/artifacts/`: `failure.png`, `failure.txt` (the error and the
last window dump), `window.xml`, `logcat.txt`, `activity.txt`, `emulator.log` and
`fixture-server.log`. The directory is wiped at the start of the next run, so copy anything you
need first.
