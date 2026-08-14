#!/usr/bin/env bash
# Publish an over-the-air JS update (expo-updates) — no APK rebuild needed.
#
#   ./publish-update.sh
#
# Runs `expo export` in apps/android and copies the output to
# <DATA_DIR>/app/updates/<runtimeVersion>/<UTC timestamp>/. The backend serves
# the newest export per runtime version at /api/app/manifest; devices on the
# same runtimeVersion download it on next launch and prompt to restart.
#
# Only for JS/TS-only changes. Native changes (new module, permission,
# Valhalla lib) need a runtimeVersion + versionCode bump and the full
# build-apk.sh + publish-apk.sh flow instead — see CLAUDE.md.
set -euo pipefail

DATA_DIR="${ATLAS_DATA_DIR:-/mnt/data/atlas}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
APP_DIR="$ROOT/apps/android"

# An OTA is still an Android release: build/install the production-configured
# bundle on the dedicated AVD and exercise the full app before copying a byte
# into the update feed. A caller that already built this exact source may hand
# its candidate APK in to avoid rebuilding it.
if [ -n "${ATLAS_ANDROID_REGRESSION_APK:-}" ]; then
  "$APP_DIR/e2e/run-regression.sh" --apk "$ATLAS_ANDROID_REGRESSION_APK"
else
  "$APP_DIR/e2e/run-regression.sh"
fi

RUNTIME="$(node -p 'require(process.argv[1]).expo.runtimeVersion' "$APP_DIR/app.json")"
VERSION="$(node -p 'require(process.argv[1]).expo.version' "$APP_DIR/app.json")"
if [ "$RUNTIME" = "undefined" ]; then
  echo "ERROR: expo.runtimeVersion missing from app.json" >&2
  exit 1
fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="$DATA_DIR/app/updates/$RUNTIME/$STAMP"

(cd "$APP_DIR" && npx expo export --platform android)

mkdir -p "$DEST"
cp -r "$APP_DIR/dist/." "$DEST/"
echo "published OTA update $VERSION (runtime $RUNTIME) to $DEST"
