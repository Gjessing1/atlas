# Valhalla routing engine (https://github.com/valhalla/valhalla) — the single
# routing stack for Atlas: this service answers the backend's /api/route proxy,
# and the same engine (same version) runs embedded on Android for offline
# routing, so online and offline can never disagree on algorithms or data
# interpretation. Wraps the official release image with an entrypoint that
# builds the tileset from an OSM extract on first start.
FROM ghcr.io/valhalla/valhalla:3.8.2

# osmium-tool, to merge the coverage extracts into one file before the tile
# build. Valhalla warns that building from several .osm.pbf at once is
# discouraged (valhalla#3925), and it is not merely untidy: neighbouring
# Geofabrik extracts overlap at every border, and with ten of them the build
# aborted outright — "Failed tile 2/794190/0: vector::_M_range_check __n (20)
# >= size() (0)" on the German/French border, then a core dump. The identical
# area built cleanly from a single extract with the same admin DB, so it is the
# overlap, not the data.
RUN apt-get update && apt-get install -y --no-install-recommends osmium-tool \
  && rm -rf /var/lib/apt/lists/*

# coverage.list is the committed area list the entrypoint builds from; it
# lives beside the script so the host rebuild (build-tiles.sh) and the
# service graph the same countries.
COPY coverage.list /coverage.list
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Stamp this image with its own revision — a digest of the three files above
# (see revision.sh) — which the entrypoint publishes into the shared data volume
# on every start. Nothing else can report which build of the routing service is
# answering: this container is brought up by hand while CI redeploys the backend
# on every push, and a running container keeps serving off the image it started
# from, so an entrypoint change here can sit undeployed indefinitely. It did,
# for three weeks. The backend bakes the same digest from the repo at its own
# build time and warns on the status page when the two disagree.
COPY Dockerfile revision.sh /image-src/
RUN cp /coverage.list /entrypoint.sh /image-src/ \
  && sh /image-src/revision.sh /image-src > /image-revision \
  && rm -rf /image-src

EXPOSE 8002
ENTRYPOINT ["/entrypoint.sh"]
