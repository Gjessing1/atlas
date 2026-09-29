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

# Never load or save a snapshot: a prior run can leave a poisoned default_boot
# image whose system_server already ANRed. A cold boot costs less than rerunning
# a full regression against that image.
# -no-snapshot-save is what keeps a bad run from becoming a permanent one. The
# emulator saves `default_boot` on exit by default, so a run whose system_server
# ANRed saved *that* — and the next run loaded the wedged system back, hit the
# same "Process system isn't responding" dialog, and saved it again. Two OTA
# publishes died that way before the snapshot was deleted by hand. A cold boot
# costs ~40 s; a release gate that can poison itself costs far more.
#
# -memory 4096 rather than the AVD's own 2 GB: at 2 GB the guest sat 565 MB into
# its compressed swap with 150 MB free, so qemu burned 200–260 % CPU while idle and
# system_server ANRed through the first steps of two publishes (2026-09-24). 3 GB
# cleared that, but the v0.238.0 publish still stalled three times at one step
# (IME stuck up, no focus events) on 2026-09-28, so the guest got another GB. Set
# here, not in the AVD's config.ini, so it survives recreating the AVD. The host
# has ~15 GB and its swap fills up over days: check `free -m` before a run, and
# free the swap (root `swapoff -a && swapon -a`) when it is full.
exec "$emulator" \
  -avd "$avd_name" \
  -memory "${ATLAS_EMULATOR_MEMORY_MB:-4096}" \
  -no-window \
  -no-audio \
  -no-boot-anim \
  -no-snapshot-load \
  -no-snapshot-save \
  -gpu swiftshader_indirect \
  "$@"
