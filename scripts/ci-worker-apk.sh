#!/usr/bin/env bash
# Build an unsigned x86_64 release candidate on Ally-X. The caller signs it on
# SOYO, so the release key never enters worker storage.
set -euo pipefail

run_id="${1:?}"
work="/root/atlas-apk/$run_id"
input="/mnt/c/soyo/work/$run_id.input"
output="/mnt/c/soyo/results/$run_id.output"
mkdir -p "$work"
trap 'rm -rf "$work"' EXIT
tar -xzf "$input" -C "$work"
cd "$work"

export JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64
export ANDROID_HOME=/root/android-sdk
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH"
export ATLAS_UNSIGNED_RELEASE=1
export ATLAS_ANDROID_ABIS=x86_64
export ATLAS_GRADLE_MAX_WORKERS=2
export ATLAS_GRADLE_USER_HOME=/root/.gradle/atlas
export NODE_OPTIONS=--max-old-space-size=3072

npm ci --workspaces --include-workspace-root --no-audit --no-fund --prefer-offline
apps/android/build-apk.sh
cp apps/android/android/app/build/outputs/apk/release/app-release-unsigned.apk "$output"
