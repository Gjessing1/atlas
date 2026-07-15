# GraphHopper routing engine (https://github.com/graphhopper/graphhopper).
# The official images lag releases; this wraps the release jar with an
# entrypoint that builds the routing graph from an OSM extract on first start.
FROM eclipse-temurin:21-jre

ARG GRAPHHOPPER_VERSION=11.0

RUN apt-get update \
  && apt-get install -y --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /graphhopper
ADD --chmod=644 https://github.com/graphhopper/graphhopper/releases/download/${GRAPHHOPPER_VERSION}/graphhopper-web-${GRAPHHOPPER_VERSION}.jar graphhopper.jar
COPY config.yml config.yml
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 8989
ENTRYPOINT ["/entrypoint.sh"]
