#!/usr/bin/env bash
# Publish a native Android release after CI has deployed the matching commit.
# One regression covers the same signed APK for both the APK and OTA baseline.
#
#   ./publish-native.sh <apk> <versionCode> <versionName>
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
app_dir="$root/apps/android"
data_dir="${ATLAS_DATA_DIR:-/mnt/data/atlas}"
apk="$(realpath "${1:?path to signed APK}")"
code="${2:?android versionCode}"
name="${3:?versionName}"
[[ -f "$apk" ]] || { echo "APK not found: $apk" >&2; exit 1; }

version="$(node -p 'require(process.argv[1]).expo.version' "$app_dir/app.json")"
runtime="$(node -p 'require(process.argv[1]).expo.runtimeVersion' "$app_dir/app.json")"
configured_code="$(node -p 'require(process.argv[1]).expo.android.versionCode' "$app_dir/app.json")"
if [[ "$name" != "$version" || "$code" != "$configured_code" ]]; then
  echo "APK release arguments must match app.json ($version, code $configured_code)" >&2
  exit 1
fi

sdk_root="${ANDROID_HOME:-$HOME/android-sdk}"
aapt="$(ls "$sdk_root"/build-tools/*/aapt 2>/dev/null | sort -V | tail -1)"
[[ -x "$aapt" ]] || { echo "Android aapt not found under $sdk_root/build-tools" >&2; exit 1; }
badging="$("$aapt" dump badging "$apk")"
package_line="${badging%%$'\n'*}"
if [[ "$package_line" != *"name='io.gjessing.atlas'"* || "$package_line" != *"versionCode='$code'"* || "$package_line" != *"versionName='$name'"* ]]; then
  echo "APK package/version does not match Atlas $name (code $code): $package_line" >&2
  exit 1
fi

cd "$root"
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "Commit the release source before publication" >&2
  exit 1
fi
head_sha="$(git rev-parse HEAD)"
deployed_sha="$(curl -fsS http://127.0.0.1:3100/api/health | node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).gitSha')"
if [[ "$head_sha" != "$deployed_sha" ]]; then
  echo "Server is at $deployed_sha; wait for CI to deploy $head_sha before device regression" >&2
  exit 1
fi

"$app_dir/e2e/run-regression.sh" --apk "$apk"

# Build both artifacts before announcing either one. The APK's version.json is
# written last, so devices cannot discover a release with no OTA baseline.
(cd "$app_dir" && npx expo export --platform android)
update_root="$data_dir/app/updates/$runtime"
mkdir -p "$update_root" "$data_dir/app"
staged="$(mktemp -d "$update_root/.staging.XXXXXX")"
trap 'rm -rf "$staged"' EXIT
cp -r "$app_dir/dist/." "$staged/"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
mv "$staged" "$update_root/$stamp"
trap - EXIT

apk_file="atlas-$name.apk"
cp "$apk" "$data_dir/app/$apk_file.tmp"
mv "$data_dir/app/$apk_file.tmp" "$data_dir/app/$apk_file"
printf '{"versionCode": %s, "versionName": "%s", "file": "%s"}\n' "$code" "$name" "$apk_file" > "$data_dir/app/version.json.tmp"
mv "$data_dir/app/version.json.tmp" "$data_dir/app/version.json"
echo "published APK $apk_file (code $code) and OTA $name (runtime $runtime)"
