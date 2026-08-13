# @atlas/android

Atlas Android app — React Native (Expo dev-client) + MapLibre Native. Thin adapter
over the shared `@atlas/*` packages (see the repo `docs/ARCHITECTURE.md`).

## Server origin (build-time)

`SERVER_ORIGIN` is baked in at build time (`src/config.ts`), **not** runtime-configurable
yet. It defaults to production (`https://atlas.gjessing.io`) so release builds always target
the real server.

For **emulator / local dev** you must override it at build time — otherwise the emulator build
talks to production:

```bash
EXPO_PUBLIC_ATLAS_SERVER=http://10.0.2.2:3100 npx expo run:android
```

`10.0.2.2` is the host loopback as seen from the Android emulator; `3100` is the backend dev
port. (A real device on the LAN would use the machine's LAN IP instead.)

## Emulator host prerequisite

The Linux emulator runtime links against `libpulse.so.0` even when started with `-no-audio`.
Install Ubuntu's PulseAudio client library before starting an AVD:

```bash
sudo apt-get install libpulse0
```

On a host where sudo is unavailable, `./e2e/install-emulator-libs.sh` extracts `libpulse0` and its
runtime dependencies into `$HOME/.local/opt/atlas-emulator-libpulse` without changing system
directories. `./e2e/start-emulator.sh` uses the system library when installed and otherwise adds
that user-local tree to the emulator's library path. The Atlas host has `libpulse0` installed
system-wide, so it does not need this fallback.

```bash
./e2e/install-emulator-libs.sh
./e2e/start-emulator.sh
```

The launcher defaults to the `atlas_test` AVD and a headless, audio-free SwiftShader renderer.
Pass extra emulator arguments after the script name when an interactive or clean boot is needed.

## Full-app smoke test

With `atlas_test` booted and an Atlas APK installed, run the deterministic first regression slice:

```bash
node e2e/smoke.mjs
```

It verifies app boot, the primary map controls, menu-sheet Back behavior, portrait and landscape
search, and the route sheet. The runner refuses to clear or exercise a device that is not the
`atlas_test` AVD. `--reset-app` clears Atlas data before launch; omit it to exercise a pre-seeded
fixture or an installed OTA. On failure, the current screenshot and accessibility tree are written
to `e2e/artifacts/`.

## Release APK

```bash
./build-apk.sh
```

Builds a signed release APK from a clean `expo prebuild`. Requirements:

- Android toolchain — sources `$HOME/android-sdk/env.sh` if present, else `JAVA_HOME` /
  `ANDROID_HOME` must be exported.
- Release signing — `$HOME/.config/atlas/keystore.env` (`ATLAS_KEYSTORE_FILE`,
  `ATLAS_KEYSTORE_PASSWORD`, `ATLAS_KEY_ALIAS`, `ATLAS_KEY_PASSWORD`). Without it the APK is
  debug-signed and in-app self-update against published builds breaks.

The script verifies the result with `apksigner verify --print-certs` (the old `keytool
-printcert` reads only the legacy v1/JAR signature and prints "Not a signed jar file" for
APKs signed with the v2/v3 scheme only).

## Self-update / publishing a build

Bump `android.versionCode` in `app.json`, build, then publish so the in-app updater offers it:

```bash
infrastructure/packs/publish-apk.sh <apk> <versionCode> <versionName>
```

This copies the APK into `<dataDir>/app/` and writes `version.json`; the backend announces it at
`/api/app/version`. The app shows its update button when the published `versionCode` is higher
than the installed one.

## Picture-in-picture verification

PiP must be checked with changing locations: a parked emulator cannot distinguish a live MapLibre
render loop from the stale frame this test exists to catch.

1. Start `atlas_test`, install a native build, and seed the emulator near the route origin (`adb
emu geo fix <lng> <lat>`; longitude comes first).
2. In Atlas, calculate a driving route, choose one of the route alternatives, and start guidance.
   Press Home once with `adb shell input keyevent KEYCODE_HOME`.
3. Record the transition with `adb shell screenrecord /sdcard/atlas-pip.mp4`. While recording,
   send several fixes a few seconds and at least 30 metres apart along the selected route. The puck
   and road beneath it must advance inside the mini window; a changing distance label alone is not
   sufficient.
4. Tap the window to check **Mute guidance** / **End trip**, expand it again, then repeat entry. The
   second Home press must work without restarting the trip, and the expand transition must not
   freeze the full-screen map.
5. End the trip from the PiP action and confirm a later Home press does not recreate an idle
   window. Disable PiP under the system's Atlas app settings, return to Atlas Settings →
   Navigation, and verify the permission state and direct settings button refresh without
   restarting Atlas.

Useful evidence while the window is up:

```bash
adb shell dumpsys activity activities | rg 'pictureInPicture|mPictureInPicture'
adb shell dumpsys window | rg 'PinnedTask|io.gjessing.atlas'
adb pull /sdcard/atlas-pip.mp4
```
