#!/usr/bin/env bash
# Build a signed release APK from scratch (works on a fresh clone).
#
#   apps/android/build-apk.sh
#
# Requirements:
#   - Android toolchain: sources $HOME/android-sdk/env.sh if present, otherwise
#     JAVA_HOME/ANDROID_HOME must already be exported.
#   - Release signing: $HOME/.config/atlas/keystore.env (ATLAS_KEYSTORE_FILE,
#     ATLAS_KEYSTORE_PASSWORD, ATLAS_KEY_ALIAS, ATLAS_KEY_PASSWORD). Without it
#     the APK is debug-signed and self-update against published builds breaks.
#     Override the location with ATLAS_KEYSTORE_ENV.
#
# The android/ directory is generated (expo prebuild, gitignored); this script
# regenerates/refreshes it every run so app.json + config plugins stay the
# single source of truth.
set -euo pipefail
cd "$(dirname "$0")"

if [ -z "${ANDROID_HOME:-}" ] && [ -f "$HOME/android-sdk/env.sh" ]; then
  # shellcheck disable=SC1091
  source "$HOME/android-sdk/env.sh"
fi
: "${ANDROID_HOME:?ANDROID_HOME not set and no \$HOME/android-sdk/env.sh found}"

KEYSTORE_ENV="${ATLAS_KEYSTORE_ENV:-$HOME/.config/atlas/keystore.env}"
if [ -f "$KEYSTORE_ENV" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$KEYSTORE_ENV"
  set +a
else
  echo "WARNING: $KEYSTORE_ENV not found — release APK will be DEBUG-signed" >&2
fi

[ -d ../../node_modules ] || (cd ../.. && npm install)

# prebuild refreshes android/ in place and re-runs config plugins; without
# node_modules changes this is fast and idempotent
npx expo prebuild --platform android --no-install

# keep gradle caches inside the workspace (gitignored as .gradle-home)
export GRADLE_USER_HOME="$PWD/.gradle-home"
(cd android && ./gradlew --no-daemon assembleRelease)

APK="$PWD/android/app/build/outputs/apk/release/app-release.apk"
echo
echo "APK: $APK"
"$JAVA_HOME/bin/keytool" -printcert -jarfile "$APK" | grep -E "Owner|Valid" | head -2
