#!/usr/bin/env bash
# Offload the CPU-heavy release image build to Ally-X when healthy; build on the
# SOYO runner when the reusable ally-x-job client declines before starting work.
set -euo pipefail

sha="${1:?pass the full commit SHA}"
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo "invalid commit SHA: $sha" >&2; exit 2; }

image="${IMAGE:?IMAGE is required}"
push_image="${PUSH_IMAGE:?PUSH_IMAGE is required}"
short_sha="${sha:0:7}"
job_client="${ALLY_X_JOB_CLIENT:-/opt/ally-x-worker/bin/ally-x-job}"

local_build() {
  # SOYO has the RAM for a full image build since its 32 GB upgrade; Ally-X only
  # buys back CPU time, so a declined worker never blocks a release.
  echo "CI build backend: SOYO"
  docker build --progress=plain -f backend/Dockerfile \
    --build-arg "GIT_SHA=$sha" \
    -t "$image:latest" -t "$image:$short_sha" \
    -t "$push_image:latest" -t "$push_image:$short_sha" .
}

# The worker is optional. A missing helper or credential is a pre-start failure.
if [[ ! -r "$job_client" || ! -r "${ALLY_X_JOB_KEY:-/run/secrets/ally-x-ci-key}" ||
  ! -r "${ALLY_X_JOB_KNOWN_HOSTS:-/run/secrets/ally-x-ci-known-hosts}" ]]; then
  echo 'Ally-X CI client or credentials unavailable; building on SOYO'
  local_build
  exit
fi

archive="$(mktemp --suffix=.tar.gz)"
image_tar="$(mktemp --suffix=.tar)"
trap 'rm -f "$archive" "$image_tar"' EXIT
# git archive is exactly the checked-out commit; no stale or untracked build input.
git archive "$sha" | gzip -1 >"$archive"

echo 'CI build backend: asking Ally-X'
set +e
bash "$job_client" --input "$archive" --output "$image_tar" \
  --script scripts/ci-worker-build.sh --arg "$sha" --docker
worker_status=$?
set -e
if [[ "$worker_status" -eq 75 ]]; then
  echo 'Ally-X unavailable before build; building on SOYO'
  local_build
  exit
fi
if [[ "$worker_status" -ne 0 ]]; then
  echo "Ally-X build failed (exit $worker_status); failing CI" >&2
  exit "$worker_status"
fi

# Import the tested image into SOYO's daemon; smoke, registry push and deployment
# still use the existing local Docker socket and authentication.
docker load -i "$image_tar"
for tag in "$image:latest" "$image:$short_sha" "$push_image:latest" "$push_image:$short_sha"; do
  docker image inspect "$tag" >/dev/null
done
echo 'Ally-X image loaded on SOYO for smoke test and push'
