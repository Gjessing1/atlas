# Photon geocoder (https://github.com/komoot/photon), embedded-OpenSearch mode.
# No official image exists; this wraps the release jar with an entrypoint that
# bootstraps the search index from a country dump on first start.
FROM eclipse-temurin:21-jre

ARG PHOTON_VERSION=1.2.1

RUN apt-get update \
  && apt-get install -y --no-install-recommends curl zstd \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /photon
ADD --chmod=644 https://github.com/komoot/photon/releases/download/${PHOTON_VERSION}/photon-${PHOTON_VERSION}.jar photon.jar
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 2322
ENTRYPOINT ["/entrypoint.sh"]
