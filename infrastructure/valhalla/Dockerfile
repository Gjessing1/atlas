# Valhalla routing engine (https://github.com/valhalla/valhalla) — the single
# routing stack for Atlas: this service answers the backend's /api/route proxy,
# and the same engine (same version) runs embedded on Android for offline
# routing, so online and offline can never disagree on algorithms or data
# interpretation. Wraps the official release image with an entrypoint that
# builds the tileset from an OSM extract on first start.
FROM ghcr.io/valhalla/valhalla:3.8.2

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 8002
ENTRYPOINT ["/entrypoint.sh"]
