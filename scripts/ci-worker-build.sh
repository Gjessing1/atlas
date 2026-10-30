#!/usr/bin/env bash
# Runs inside the Ally-X Ubuntu WSL2 distro. The Windows wrapper holds the
# cross-project worker lock for this whole command.
set -euo pipefail

run_id="${1:?}"
sha="${2:?}"
work="/root/atlas-ci/$run_id"
archive="/mnt/c/soyo/work/$run_id.input"
output="/mnt/c/soyo/results/$run_id.output"
image='git.gjessing.io/gjessing1/atlas-backend'
push_image='localhost:3000/gjessing1/atlas-backend'
short_sha="${sha:0:7}"

mkdir -p "$work" /mnt/c/soyo/results
cleanup() { rm -rf "$work"; }
trap cleanup EXIT
tar -xzf "$archive" -C "$work"
echo 'WORKER BUILD STARTED'
cd "$work"
DOCKER_BUILDKIT=1 docker build --progress=plain -f backend/Dockerfile \
  --build-arg "GIT_SHA=$sha" \
  -t "$image:latest" -t "$image:$short_sha" \
  -t "$push_image:latest" -t "$push_image:$short_sha" .
docker save -o "$output" "$image:latest" "$image:$short_sha" \
  "$push_image:latest" "$push_image:$short_sha"
echo 'WORKER BUILD FINISHED'
