#!/usr/bin/env bash
# Build/install the Android release candidate and run the deterministic full-app gate.
#
#   ./e2e/run-regression.sh                 # build the candidate, then test it
#   ./e2e/run-regression.sh --apk path.apk  # test an already-built candidate
#
# Where the emulator runs (ATLAS_ANDROID_BACKEND):
#   auto (default)  the Ally-X worker when it is healthy, else this host's AVD
#   ally-x          the worker only; fail if it is not usable
#   local           this host's AVD only
# The driver (regression.mjs) and the fixture server always run here; on the worker only
# the emulator does, reached through SSH forwards (README: "The Ally-X worker").
set -euo pipefail

app_dir="$(cd "$(dirname "$0")/.." && pwd)"
root="$(cd "$app_dir/../.." && pwd)"
sdk_root="${ANDROID_HOME:-$HOME/android-sdk}"
adb="${ADB:-$sdk_root/platform-tools/adb}"
apk=""
backend="${ATLAS_ANDROID_BACKEND:-auto}"
worker="${ATLAS_ANDROID_WORKER:-$HOME/projects/sysadmin/ally-x-worker/bin/ally-x-android}"
# A worker session exits 75 when the worker was unusable before anything ran on it.
worker_unavailable=75

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

case "$backend" in
  auto | ally-x | local) ;;
  *)
    echo "ATLAS_ANDROID_BACKEND must be auto, ally-x or local (got: $backend)" >&2
    exit 2
    ;;
esac
if [[ ! -x "$adb" ]]; then
  echo "Android adb not found at $adb" >&2
  exit 1
fi
if [[ "$backend" == ally-x && ! -x "$worker" ]]; then
  echo "ATLAS_ANDROID_BACKEND=ally-x but the worker client is missing: $worker" >&2
  exit 1
fi

# This host's AVD loses focus and key events when CI is building on the same four cores,
# or when anything else keeps them busy (a video encode), even when the app is correct.
# Only the local emulator cares: on the worker, this host just runs the light driver.
# Prints the reason and succeeds when the host is too busy; waits out a passing load spike
# (the candidate's own Gradle build leaves a 1-minute load of 10+ for a few minutes).
local_host_busy() {
  if command -v docker >/dev/null && docker ps --format '{{.Names}}' 2>/dev/null | awk '/FORGEJO-ACTIONS-TASK/ { found=1 } END { exit !found }'; then
    echo "Forgejo CI is still using the host; wait for its deploy before a local device regression"
    return 0
  fi
  local load max top waited=0 patience
  max="${ATLAS_ANDROID_MAX_LOCAL_LOAD:-3}"
  patience="${ATLAS_ANDROID_LOAD_WAIT_SECONDS:-600}"
  while :; do
    load="$(cut -d' ' -f1 /proc/loadavg)"
    awk -v current="$load" -v limit="$max" 'BEGIN { exit !(current > limit) }' || return 1
    top="$(ps -eo pcpu=,comm= --sort=-pcpu | awk '$2 != "ps"' | head -3 | awk '{ printf "%s%s (%s%%)", sep, $2, $1; sep=", " }')"
    if ((waited >= patience)); then
      echo "this host's 1-minute load is still $load after ${waited} s (limit $max; busiest: $top); a local emulator drops input under that load. Wait, use the Ally-X worker, or raise ATLAS_ANDROID_MAX_LOCAL_LOAD"
      return 0
    fi
    echo "waiting for this host's 1-minute load ($load) to fall below $max; busiest: $top" >&2
    sleep 30
    waited=$((waited + 30))
  done
}
# Fail before building a candidate that could only be tested on a busy local host.
if [[ "$backend" == local ]] && reason="$(local_host_busy)"; then
  echo "$reason" >&2
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
used_backend=""
run_started=$SECONDS

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
    if [[ "$used_backend" == local ]]; then
      cp "$emulator_log" "$app_dir/e2e/artifacts/emulator.log"
    fi
    echo "Android regression artifacts: $app_dir/e2e/artifacts" >&2
  fi
  if [[ -n "$used_backend" ]]; then
    result=passed
    ((status == 0)) || result="failed (exit $status)"
    echo "Android regression backend: $used_backend — $result after $((SECONDS - run_started)) s"
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

# The worker first. It reports "unavailable" (75) only when nothing ran on it — unreachable,
# unhealthy, busy with another project's session, or failed to boot — and only then may a
# run move here. Once regression.mjs has started on the worker, its result is the result.
if [[ "$backend" != local && -x "$worker" ]]; then
  echo "Android regression backend: trying ally-x"
  set +e
  "$worker" session --avd atlas_test --apk "$apk" --reverse 3199 \
    --results "$app_dir/e2e/artifacts/ally-x" -- node "$app_dir/e2e/regression.mjs"
  worker_status=$?
  set -e
  if ((worker_status != worker_unavailable)); then
    used_backend=ally-x
    exit "$worker_status"
  fi
  if [[ "$backend" == ally-x ]]; then
    echo "the Ally-X worker is unavailable and ATLAS_ANDROID_BACKEND=ally-x; not falling back" >&2
    exit 1
  fi
  echo "Android regression backend: ally-x unavailable before the run started; falling back to this host's emulator" >&2
elif [[ "$backend" == auto ]]; then
  echo "Android regression backend: no worker client at $worker; using this host's emulator" >&2
fi

if reason="$(local_host_busy)"; then
  echo "$reason" >&2
  exit 1
fi
used_backend=local
echo "Android regression backend: local ($(hostname))"

# The host keeps cold service pages in its 4 GB swap over days. With that swap
# full, the AVD's IME and system_server stall even when CPU load is low. Clear
# it before boot, while the emulator is absent and RAM has enough headroom.
swap_used_mb="$(free -m | awk '$1 == "Swap:" { print $3 }')"
available_mb="$(free -m | awk '$1 == "Mem:" { print $7 }')"
if [[ "${swap_used_mb:-0}" -ge 1024 ]]; then
  if "$adb" devices | awk 'NR > 1 && $2 == "device" { found=1 } END { exit !found }'; then
    echo "swap is ${swap_used_mb} MB used while an Android device is running; stop it before regression" >&2
    exit 1
  fi
  if [[ "${available_mb:-0}" -lt "$((swap_used_mb + 2048))" ]]; then
    echo "swap is ${swap_used_mb} MB used with only ${available_mb} MB available RAM; free host memory before regression" >&2
    exit 1
  fi
  echo "Clearing ${swap_used_mb} MB of host swap before emulator boot"
  if sudo -n true >/dev/null 2>&1; then
    sudo -n swapoff -a
    sudo -n swapon -a
  elif [[ -f /swap.img ]] && command -v docker >/dev/null && docker image inspect alpine:3 >/dev/null 2>&1; then
    docker run --pull=never --rm --privileged --network none -v /swap.img:/swap.img alpine:3 sh -c 'swapoff /swap.img && swapon /swap.img'
  else
    echo "Cannot clear host swap automatically; run swapoff/swapon as root before regression" >&2
    exit 1
  fi
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

# sys.boot_completed can flip before the package service answers — on a cold boot under load
# (2026-09-19, right after the candidate's Gradle build) the install died with "Failure calling
# service package: Broken pipe" before the app was ever on the device.
for _ in $(seq 1 60); do
  if "$adb" shell pm path android >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

echo "Installing Android release candidate: $apk"
installed=0
for attempt in 1 2 3; do
  if "$adb" install -r -d "$apk"; then
    installed=1
    break
  fi
  echo "install attempt $attempt failed; retrying in 10 s" >&2
  sleep 10
done
if ((!installed)); then
  echo "could not install $apk" >&2
  exit 1
fi
node "$app_dir/e2e/regression.mjs"
