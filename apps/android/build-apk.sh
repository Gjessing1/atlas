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
#   - ATLAS_UNSIGNED_RELEASE=1 produces an unsigned APK for a remote build that
#     the trusted host must align and sign before use. ATLAS_ANDROID_ABIS and
#     ATLAS_GRADLE_MAX_WORKERS can limit a regression candidate's build load.
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
if [ "${ATLAS_UNSIGNED_RELEASE:-}" = "1" ]; then
  echo 'Building an unsigned release candidate for signing on SOYO'
elif [ -f "$KEYSTORE_ENV" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$KEYSTORE_ENV"
  set +a
elif [ "${ATLAS_ALLOW_DEBUG_SIGNING:-}" = "1" ]; then
  echo "WARNING: $KEYSTORE_ENV not found — building a DEBUG-signed APK (ATLAS_ALLOW_DEBUG_SIGNING=1)" >&2
else
  # A debug-signed "release" is a trap: once users install it, a later
  # release-keyed update is a signature mismatch, so Android forces
  # uninstall+reinstall and wipes their local data (login, favorites, packs).
  # Refuse rather than ship an update-incompatible build. For a throwaway local
  # build, re-run with ATLAS_ALLOW_DEBUG_SIGNING=1.
  echo "ERROR: $KEYSTORE_ENV not found — refusing to build a debug-signed release." >&2
  echo "       Set up the release keystore, or re-run with ATLAS_ALLOW_DEBUG_SIGNING=1" >&2
  echo "       for a throwaway build that must NOT be published for self-update." >&2
  exit 1
fi

[ -d ../../node_modules ] || (cd ../.. && npm install)

# prebuild refreshes android/ in place and re-runs config plugins; without
# node_modules changes this is fast and idempotent
npx expo prebuild --platform android --no-install

# The worker can keep a persistent Gradle cache outside its disposable source tree.
export GRADLE_USER_HOME="${ATLAS_GRADLE_USER_HOME:-$PWD/.gradle-home}"
mkdir -p "$GRADLE_USER_HOME"
gradle_args=(--no-daemon)
if [ -n "${ATLAS_GRADLE_MAX_WORKERS:-}" ]; then
  gradle_args+=(--max-workers "$ATLAS_GRADLE_MAX_WORKERS")
fi
if [ -n "${ATLAS_ANDROID_ABIS:-}" ]; then
  gradle_args+=("-PreactNativeArchitectures=$ATLAS_ANDROID_ABIS")
fi
(cd android && ./gradlew "${gradle_args[@]}" assembleRelease)

if [ "${ATLAS_UNSIGNED_RELEASE:-}" = "1" ]; then
  APK="$PWD/android/app/build/outputs/apk/release/app-release-unsigned.apk"
else
  APK="$PWD/android/app/build/outputs/apk/release/app-release.apk"
fi
test -s "$APK"
echo
echo "APK: $APK"

# Verify the signature with apksigner (keytool -printcert only reads the legacy
# v1/JAR signature and prints "Not a signed jar file" for v2/v3-only APKs).
APKSIGNER="$(ls "$ANDROID_HOME"/build-tools/*/apksigner 2>/dev/null | sort -V | tail -1)"
if [ "${ATLAS_UNSIGNED_RELEASE:-}" = "1" ]; then
  echo '(unsigned release candidate; sign it on the trusted host before testing or publishing)'
elif [ -n "$APKSIGNER" ]; then
  "$APKSIGNER" verify --print-certs "$APK" | grep -E "Signer #1 certificate (DN|SHA-256)" || true
else
  echo "(apksigner not found under \$ANDROID_HOME/build-tools; skipping signature check)"
fi
