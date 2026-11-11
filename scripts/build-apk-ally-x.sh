#!/usr/bin/env bash
# Offload the expensive Android build; align and release-sign only on SOYO.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -f "$HOME/android-sdk/env.sh" ]; then
  # shellcheck disable=SC1091
  source "$HOME/android-sdk/env.sh"
fi
client="${ALLY_X_JOB_CLIENT:-/home/gjessing/projects/tooling/sysadmin/ally-x-worker/bin/ally-x-job}"
sdk="${ANDROID_HOME:-/home/gjessing/android-sdk}"
keystore_env="${ATLAS_KEYSTORE_ENV:-$HOME/.config/atlas/keystore.env}"
[[ -r "$keystore_env" ]] || { echo "missing release signing config: $keystore_env" >&2; exit 1; }
[[ -r "$client" ]] || { echo "missing Ally-X job client: $client" >&2; exit 1; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
archive="$work/source.tar.gz"
unsigned="$work/app-release-unsigned.apk"
aligned="$work/app-release-aligned.apk"
signed="$PWD/apps/android/android/app/build/outputs/apk/release/app-release.apk"
signed_tmp="$work/app-release.apk"

# Include tracked worktree edits while developing the worker flow; no ignored
# node_modules, Gradle state or signing material crosses to the worker.
git ls-files -z | tar --null -T - -cf - | gzip -1 >"$archive"
bash "$client" --input "$archive" --output "$unsigned" \
  --script scripts/ci-worker-apk.sh

"$sdk/build-tools/36.0.0/zipalign" -f -p 4 "$unsigned" "$aligned"
set -a
# shellcheck disable=SC1090
source "$keystore_env"
set +a
: "${ATLAS_KEYSTORE_FILE:?missing ATLAS_KEYSTORE_FILE}"
: "${ATLAS_KEYSTORE_PASSWORD:?missing ATLAS_KEYSTORE_PASSWORD}"
: "${ATLAS_KEY_ALIAS:?missing ATLAS_KEY_ALIAS}"
: "${ATLAS_KEY_PASSWORD:?missing ATLAS_KEY_PASSWORD}"
mkdir -p "$(dirname "$signed")"
"$sdk/build-tools/36.0.0/apksigner" sign \
  --ks "$ATLAS_KEYSTORE_FILE" --ks-key-alias "$ATLAS_KEY_ALIAS" \
  --ks-pass env:ATLAS_KEYSTORE_PASSWORD --key-pass env:ATLAS_KEY_PASSWORD \
  --out "$signed_tmp" "$aligned"
"$sdk/build-tools/36.0.0/apksigner" verify --print-certs "$signed_tmp" |
  grep -E 'Signer #1 certificate (DN|SHA-256)'
cp "$signed_tmp" "$signed"
echo "signed APK: $signed"
