# Atlas

A self-hosted, offline-first mapping and navigation platform (OsmAnd-inspired) for **Android +
Web**, built on OpenStreetMap data. The web app is also a first-class citizen.

## Tech stack

- **Monorepo** (npm workspaces): `apps/web`, `apps/android`, `backend/`, `packages/*` (shared
  TypeScript).
- **Language:** TypeScript everywhere — strict mode, ESM.
- **Web:** React + Vite, [MapLibre GL JS](https://maplibre.org/) for rendering.
- **Android:** React Native (Expo dev-client) + MapLibre Native.
- **Backend:** Node 24+, [Fastify](https://fastify.dev/); serves the built web app same-origin in
  production.
- **Data:** SQLite on clients (native / SQLite-WASM+OPFS in the browser), PostgreSQL+PostGIS on the
  server for the optional sync backend.

## Map tiles

Atlas serves **vector tiles**. Basemap tiles are pre-built from OpenStreetMap data
into [PMTiles](https://protomaps.com/docs/pmtiles/) archives using
[Planetiler](https://github.com/onthegomap/planetiler), then rendered client-side by MapLibre GL
using an [OpenFreeMap](https://openfreemap.org/) Liberty style (Noto Sans glyphs, OFM sprites).

## External services

These self-hosted services run alongside the app (see `infrastructure/` for their Docker setup):

| Service                                                          | Purpose                                   | Notes                                                                                         |
| ---------------------------------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------- |
| [Valhalla](https://github.com/valhalla/valhalla)                 | Routing (driving/cycling/walking/transit) |
| [Photon](https://github.com/komoot/photon)                       | Search / geocoding                        | Self-hosted, backed by an OSM data import                                                     |
| [Planetiler](https://github.com/onthegomap/planetiler) → PMTiles | Vector basemap tiles                      | Build-time only — not a running service; output is static PMTiles files served by the backend |
| PostgreSQL + PostGIS                                             | Optional account/sync backend             | Only enabled when `DATABASE_URL` and `JWT_SECRET` are set; unset = anonymous local-only mode  |

All external services communicate with the backend over a shared Docker network (`atlas`) and are
otherwise decoupled — none of them are required for local development (`DATABASE_URL=memory` runs
a throwaway in-process store in place of Postgres).

## Repo structure

```
apps/web/          React + Vite + MapLibre web client
apps/android/      React Native (Expo) Android client
backend/           Fastify API + static file serving
packages/*/        Shared TypeScript packages (core domain logic, routing, storage, sync, gpx, ...)
infrastructure/     Docker/compose setup for Valhalla, Photon, Postgres, tile builds
.forgejo/workflows/ CI: build -> push -> deploy
```

## License

Not yet decided.
