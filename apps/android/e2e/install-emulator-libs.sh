#!/usr/bin/env bash
set -euo pipefail

install_root="${ATLAS_EMULATOR_LIB_DIR:-$HOME/.local/opt/atlas-emulator-libpulse}"
work_dir="$(mktemp -d)"

cleanup() {
  rm -r -- "$work_dir"
}
trap cleanup EXIT

packages=(
  libpulse0
  libasyncns0
  libsndfile1
  libflac12t64
  libmp3lame0
  libmpg123-0t64
  libogg0
  libopus0
  libvorbis0a
  libvorbisenc2
)

mkdir -p "$install_root"
cd "$work_dir"
apt-get download "${packages[@]}"

for package_file in ./*.deb; do
  dpkg-deb -x "$package_file" "$install_root"
done

lib_root="$install_root/usr/lib/x86_64-linux-gnu"
if [[ ! -e "$lib_root/libpulse.so.0" || ! -e "$lib_root/pulseaudio/libpulsecommon-16.1.so" ]]; then
  echo "The extracted packages did not supply a complete PulseAudio client runtime." >&2
  exit 1
fi

echo "Android emulator libraries installed in $install_root"
