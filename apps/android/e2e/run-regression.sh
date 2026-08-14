#!/usr/bin/env bash
# Build/install the Android release candidate and run the deterministic full-app gate.
#
#   ./e2e/run-regression.sh                 # build the candidate, then test it
#   ./e2e/run-regression.sh --apk path.apk  # test an already-built candidate
set -euo pipefail

app_dir="$(cd "$(dirname "$0")/.." && pwd)"
root="$(cd "$app_dir/../.." && pwd)"
sdk_root="${ANDROID_HOME:-$HOME/android-sdk}"
adb="${ADB:-$sdk_root/platform-tools/adb}"
apk=""

while (($#)); do
  case "$1" in
    --apk)
      apk="${2:?--apk needs a path}"
      shift 2
      ;;
    *)
      echo "unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

if [[ ! -x "$adb" ]]; then
  echo "Android adb not found at $adb" >&2
  exit 1
fi

if [[ -z "$apk" ]]; then
  "$app_dir/build-apk.sh"
  apk="$app_dir/android/app/build/outputs/apk/release/app-release.apk"
else
  apk="$(realpath "$apk")"
fi
if [[ ! -f "$apk" ]]; then
  echo "release candidate APK not found: $apk" >&2
  exit 1
fi

fixture_log="$(mktemp)"
emulator_log="$(mktemp)"
fixture_pid=""
emulator_pid=""

cleanup() {
  status=$?
  if [[ -n "$fixture_pid" ]]; then
    kill "$fixture_pid" 2>/dev/null || true
    wait "$fixture_pid" 2>/dev/null || true
  fi
  if [[ -n "$emulator_pid" ]]; then
    "$adb" emu kill >/dev/null 2>&1 || true
    wait "$emulator_pid" 2>/dev/null || true
  fi
  if ((status != 0)); then
    mkdir -p "$app_dir/e2e/artifacts"
    cp "$fixture_log" "$app_dir/e2e/artifacts/fixture-server.log"
    cp "$emulator_log" "$app_dir/e2e/artifacts/emulator.log"
    echo "Android regression artifacts: $app_dir/e2e/artifacts" >&2
  fi
  rm -f "$fixture_log" "$emulator_log"
  exit "$status"
}
trap cleanup EXIT INT TERM

if curl --silent --fail http://127.0.0.1:3199/api/health >/dev/null 2>&1; then
  echo "port 3199 is already in use; refusing to test against a server this run does not own" >&2
  exit 1
fi
node "$app_dir/e2e/fixture-server.mjs" >"$fixture_log" 2>&1 &
fixture_pid=$!
for _ in $(seq 1 40); do
  if curl --silent --fail http://127.0.0.1:3199/api/health >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$fixture_pid" 2>/dev/null; then
    echo "fixture server exited during startup" >&2
    sed -n '1,160p' "$fixture_log" >&2
    exit 1
  fi
  sleep 0.25
done
if ! curl --silent --fail http://127.0.0.1:3199/api/health >/dev/null; then
  echo "fixture server did not become ready" >&2
  exit 1
fi

if ! "$adb" devices | awk 'NR > 1 && $2 == "device" { found=1 } END { exit !found }'; then
  "$app_dir/e2e/start-emulator.sh" >"$emulator_log" 2>&1 &
  emulator_pid=$!
fi

"$adb" wait-for-device
for _ in $(seq 1 120); do
  if [[ "$("$adb" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" == "1" ]]; then
    break
  fi
  sleep 1
done
if [[ "$("$adb" shell getprop ro.boot.qemu.avd_name | tr -d '\r')" != "atlas_test" ]]; then
  echo "refusing to install on anything except the atlas_test AVD" >&2
  exit 1
fi

echo "Installing Android release candidate: $apk"
"$adb" install -r -d "$apk"
node "$app_dir/e2e/regression.mjs"
