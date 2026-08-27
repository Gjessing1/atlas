#!/usr/bin/env bash
set -euo pipefail

sdk_root="${ANDROID_HOME:-$HOME/android-sdk}"
emulator="$sdk_root/emulator/emulator"
avd_name="${ATLAS_ANDROID_AVD:-atlas_test}"

if [[ ! -x "$emulator" ]]; then
  echo "Android emulator not found at $emulator" >&2
  exit 1
fi

if ! ldconfig -p 2>/dev/null | grep -q 'libpulse\.so\.0'; then
  install_root="${ATLAS_EMULATOR_LIB_DIR:-$HOME/.local/opt/atlas-emulator-libpulse}"
  lib_root="$install_root/usr/lib/x86_64-linux-gnu"
  if [[ ! -e "$lib_root/libpulse.so.0" ]]; then
    echo "libpulse.so.0 is missing." >&2
    echo "Install libpulse0, or run apps/android/e2e/install-emulator-libs.sh." >&2
    exit 1
  fi
  export LD_LIBRARY_PATH="$lib_root:$lib_root/pulseaudio${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
fi

# -no-snapshot-save is what keeps a bad run from becoming a permanent one. The
# emulator saves `default_boot` on exit by default, so a run whose system_server
# ANRed saved *that* — and the next run loaded the wedged system back, hit the
# same "Process system isn't responding" dialog, and saved it again. Two OTA
# publishes died that way before the snapshot was deleted by hand. A cold boot
# costs ~40 s; a release gate that can poison itself costs far more.
exec "$emulator" \
  -avd "$avd_name" \
  -no-window \
  -no-audio \
  -no-boot-anim \
  -no-snapshot-save \
  -gpu swiftshader_indirect \
  "$@"
