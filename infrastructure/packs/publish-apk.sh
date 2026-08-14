#!/usr/bin/env bash
# Publish an Android APK for in-app self-update (Phase 6).
#
#   ./publish-apk.sh <apk> <versionCode> <versionName>
#   ./publish-apk.sh app-release.apk 3 0.2.0
#
# Copies the APK into <DATA_DIR>/app/ and writes version.json; the backend
# announces it at /api/app/version and serves it at /app/<file>. The app shows
# its update button when the published versionCode is higher than its own.
set -euo pipefail

DATA_DIR="${ATLAS_DATA_DIR:-/mnt/data/atlas}"
APK="${1:?path to .apk}"
CODE="${2:?android versionCode (integer)}"
NAME="${3:?versionName, e.g. 0.2.0}"

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
"$ROOT/apps/android/e2e/run-regression.sh" --apk "$APK"

APP_DIR="$DATA_DIR/app"
FILE="atlas-$NAME.apk"
mkdir -p "$APP_DIR"
cp "$APK" "$APP_DIR/$FILE"
printf '{"versionCode": %s, "versionName": "%s", "file": "%s"}\n' "$CODE" "$NAME" "$FILE" \
  > "$APP_DIR/version.json"
echo "published $FILE (code $CODE) to $APP_DIR"
