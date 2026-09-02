#!/bin/sh
# The revision of the Valhalla *service image* — a short digest over exactly the
# three files that decide what that image does: the Dockerfile it is built from,
# the coverage list it graphs, and the entrypoint that graphs it.
#
# Why a digest exists at all: nothing else on this host can tell you which build
# of the routing service is actually answering. CI rebuilds and redeploys the
# backend on every push to main, but the Valhalla container is brought up by
# hand, and a running container keeps serving off whatever image it started
# from — so an entrypoint or coverage change lands in the repo, passes the gate,
# deploys, and routing quietly carries on as before. That drift once went three
# weeks unnoticed. compose.test.ts pins these files against each other; it
# cannot see what is deployed.
#
# So two images compute this same number. The routing image stamps its own into
# /image-revision at build time and the entrypoint publishes it into the shared
# data volume on every start; the backend image bakes the repo's into
# backend/valhalla-revision at *its* build time. When the two disagree, the
# routing service running here is not the one this repo describes, and the
# backend says so on the status page (backend/src/routing-revision.ts).
#
# Both sides call this one script rather than each hashing "the same" files
# their own way, because a formula copied into two Dockerfiles is a formula that
# will eventually be edited in one of them and report agreement forever after.
# revision.sh itself is deliberately outside the digest: it is how the revision
# is computed, not what the service is.
set -eu
dir="${1:-$(dirname "$0")}"
cat "$dir/Dockerfile" "$dir/coverage.list" "$dir/entrypoint.sh" | sha256sum | cut -c1-12
