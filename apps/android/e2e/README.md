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

Budget ~20 min for a regression, plus ~10 min when it has to build the APK itself.

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

### Text input can drop even after the retries

`replaceText` types one key at a time and retries four times, re-focusing the field on each pass
(see `2c65eb8`). Under residual load (1-minute load 3–7 just after CI finished) all four passes
still arrived empty: `Timed out waiting for search-input to contain saved`. Logcat had **no ANR
and no JavaScript error**, and the field in `failure.png` still showed its placeholder, so the
keys never reached the IME. The same APK passed that step ten minutes later on a quieter host.

If a text step fails, look at `artifacts/logcat.txt` (`ReactNativeJS`, `FATAL`, `ANR in`) and
`artifacts/failure.png` before touching the app. A placeholder in the field plus a clean logcat
means the host dropped the input.

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
- **Pointing the app at a local backend:** Settings → Server → `http://10.0.2.2:<port>` (the host
  from inside the emulator). Plain HTTP is allowed (`usesCleartextTraffic`).

## Artifacts

A failed run writes `apps/android/e2e/artifacts/`: `failure.png`, `failure.txt` (the error and the
last window dump), `window.xml`, `logcat.txt`, `activity.txt`, `emulator.log` and
`fixture-server.log`. The directory is wiped at the start of the next run, so copy anything you
need first.
