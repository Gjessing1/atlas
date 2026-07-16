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
