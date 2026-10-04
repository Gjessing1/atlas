# Roadmap
What is still to do, by area. **Remove an item when it ships:** shipped work lives in git,
anything data-source-shaped is recorded in [DATA-SOURCES.md](./DATA-SOURCES.md), and a rule the
code must keep obeying moves to a design doc first — [ARCHITECTURE.md](./ARCHITECTURE.md),
[TRANSIT.md](./TRANSIT.md), [NAVIGATION.md](./NAVIGATION.md),
[FISH-HUNT-ENGINE.md](./FISH-HUNT-ENGINE.md). [VISION.md](./VISION.md) has the product features.

**How to read this file**
- `[ ]` open · `[~]` partly shipped, with only the remainder described.
- Sections run in priority order, and so do the items inside each: the first item in a section is the next one to do there.
- **Nothing cites this file's numbers.** They change whenever an item ships or moves. Code never
  cites the roadmap at all; a design doc may name an item, or a stable label — `N5`, `E7`, `DR6` —
  which is never reused (N1 shipped, N4 retired; DATA-SOURCES.md and FISH-HUNT-ENGINE.md cite
  these by name).
- Each item states the outcome, constraints that affect scope, and what remains. Investigation
  logs, shipped chronology and endpoint details belong in the linked design/source documents.
- **This file is committed to git** (the rest of `docs/` is local), so its history is the record
  of what was planned, shipped or dropped.
- New ideas land in **Inbox** as one-liners; triage them into a numbered section (with outcome and
  scope) before starting work on them. Other docs: [README.md](./README.md).

## Inbox — untriaged

- [ ] weakened ice, surface date of last observation and date.
- [ ] weakened ice, markers of different reports? Looks to be same source as iskart.no?
- [ ] Panning the map sometimes make icons move in relation the map until we stop, can we make it seem more "attached" ?
- [ ] Clicking my position button once should reveal the location dot, pressing my position button once more should take the user zoomed in closer with your position centered.
- [ ] new layer, current sun illumination, ideally with a similar timeline like the animated weather showing its movement around the world for the next 24h
- [ ] If any api has a tile request limitation for a month or a week, maybe we could implement a counter to track how close we are to the quota?

---

## 1. Map profiles — per-activity cartography and layers

The map profiles (Explore, Drive, Cycle, Hike, Run, Ski, Fish & Hunt) are the one-tap "what am I
doing now" switch: each sets the default travel mode, appearance, offered overlays and defaults.
Implementation patterns and upstream constraints live in [ARCHITECTURE.md](./ARCHITECTURE.md) and
[DATA-SOURCES.md](./DATA-SOURCES.md); Norway-only layers follow ARCHITECTURE.md's *Norway-only
data* rule. The Fish & Hunt surfaces are tracked under N5 below.

### 1.1 Explore — urban signature

- [ ] **Expand and make Explore categories configurable.** Groceries currently exists only for
      Drive while Explore receives a broad Shops row and only six fixed categories. Add the
      missing practical categories—pharmacy, bank/ATM, toilets, campsite, hardware, post/parcel
      and playground—and provide a “more” or customisation path.

- [ ] **Proper 3D buildings, not the generic extrusion already in Liberty.** The fetched Liberty
      extrusion path exists, but a central-Oslo sample mostly used the stock 4 m fallback. Measure
      real height/storey coverage, preserve tagged OSM values, and keep unknown buildings visually
      restrained. Add an explicit 2D/3D control and camera behaviour, then verify dense-city
      performance and navigation-label occlusion on both clients. Consider a Norwegian height
      source only if OSM coverage proves insufficient.

### 1.2 Curiosities — the register profile

The register profile answers "what is out here that I would never have known to look for?"

- [ ] **Audit what every Curiosities register publishes versus what Atlas surfaces.** For each
      row, compare live GetFeatureInfo/GetCapabilities fields and sub-layers with the catalog's
      allow-list. Drilled well depth is the named missing example; also guard against union layers
      silently omitting a subtype.

- [ ] **Scale bands are a per-layer measurement, and nothing verifies them but a human.** Every
      `minzoom` comes from the service's `MaxScaleDenominator`, but probes test only one zoom. Add
      “draws at minzoom and minzoom+2” checks so a wrongly derived band is caught as well as one
      that later moves.

- [ ] **Tapping a satellite should say what it is, not just where it is.** A drawn pass currently
      answers "where and when"; a space station, telescope or weather satellite is exactly the
      object a reader wants a paragraph about, and Atlas already renders Wikipedia summaries for
      places (`place-content-api`, `PlaceCard`). Reuse the presentation, not the lookup: the
      existing path is a *geosearch* around a lat/lon, which is meaningless for something in
      orbit. Resolve the article from the catalogue identity instead — `NORAD_CAT_ID` via Wikidata
      P377, or `OBJECT_ID` (COSPAR) via P247 — never by fuzzy-matching `OBJECT_NAME`, because the
      catalogue writes "ISS (ZARYA)" and "CSS (TIANHE)" and no such article exists. Reuse
      `wikiLanguageChain` for language. Most tracked objects have no article at all, so *no card*
      is the correct and common outcome: show the orbital facts alone rather than a near-miss
      article, and keep the pass/altitude/illumination detail readable with no network.

### 1.3 Ski — winter cartography

- [ ] Add the NVE **Varsom** avalanche danger-level forecast, distinct from steepness.

- [ ] **Live grooming status.** Colour `piste:type=nordic` tracks by time since grooming (for
      example under 2 h, under 24 h), if Skisporet.no offers an accessible API — not yet checked.

### 1.4 Hike — trail cartography

- [ ] **A tuft pattern for marshes (myr), in Hike and Fish & Hunt**, so wet ground reads at a
      glance: a small repeating SVG `fill-pattern`. Wetland is only a colour today — the appearance
      code strips the base style's fill patterns.

### 1.5 Fish & Hunt — field cartography

- [ ] **Clear-cuts and forest edges.** Distinguish clear-cuts (`natural=clearcut` /
      `landuse=logging` in the original sketch — OSM coverage unmeasured) from dense conifer and open
      deciduous forest: edges dictate animal movement and shooting sightlines.

- [ ] **Shooting ranges** (`leisure=pitch` + `sport=shooting`), for sighting in a rifle before the
      hunt.

- [ ] **River flow direction.** Arrows along streams and rivers. The NVE Elvenett WMS cannot draw
      them (a `GraphicStroke` silently renders a plain line — DATA-SOURCES.md), so this needs OSM
      waterway geometry, drawn in way direction.

### 1.6 Drive — road data and costs

Statens vegvesen sources, Norway-only under ARCHITECTURE.md's *Norway-only data* rule. Record what
each API actually returns in [DATA-SOURCES.md](./DATA-SOURCES.md) once probed.

- [ ] **Verify that Norwegian drives show the official posted limit, where and when it applies.**
      NVDB `Fartsgrense` (105) shipped in v0.164.0 as authoritative over OSM, but nothing has
      checked the displayed roundel against the road register since. A quick look on 2026-09-16
      found these problems:

      - **The Android packs are still stale.** Until 2026-09-16 the backend served a July file
        with no lane tables, so lane guidance was inert in production. The server file now has a
        daily change-feed check and bounded automatic rebuild (DATA-SOURCES.md), but the six pack
        clips (2026-08-06) still have old limits and no lanes, so offline Android has neither.
      - **Time-dependent limits are not imported.** Type 721 `Fartsgrense, variabel` holds 57
        stretches over 92 km: winter limits such as 100 km/h from November to April, Oslo's
        `Miljøfartsgrense`, 30 km/h near schools during school hours, and summer limits. Atlas
        shows the base limit on those stretches all year.
      - **A limit change shows up late.** The matcher checks only the route's own vertices
        (15 m tolerance, 4 m hysteresis) and never densifies the line, so the change appears at
        the first route vertex after the sign. How far that is on a sparsely noded straight road
        hasn't been measured. The import also drops NVDB's positioning direction and property
        13170 `Merknad` (privately signed roads), and whether either affects the result is
        unchecked.

      Remaining: re-clip the packs. Then compare the shown limit with NVDB along a fixed set of routes (motorway, urban grid,
      ramps, divided carriageways, a change on a long straight, a 721 stretch) and against
      uploaded drive logs. Decide how a variable limit presents: apply it inside its date and
      time window, or show both values. Record NVDB vs OSM-fallback coverage per test route in
      DATA-SOURCES.md.

- [ ] **Show what the toll roads on a driving route will cost.** Use the toll API to price a
      planned route and show the total with the route summary. `avoidTolls` is only a preference
      (Norway's urban toll rings are unavoidable), so the price is what makes that choice
      legible. Norwegian rates vary by vehicle class, fuel type and time of day — say which
      assumptions the figure uses.

- [ ] **Bridge-height layer for the Drive profile, off by default.** Draw signed height
      restrictions with their clearance. NVDB counts 4841 of them for Norway against ~2772 usable
      OSM `maxheight` tags (measured for the vehicle profile in `packages/routing`), so NVDB is
      the source.

- [ ] **Vehicle lookup from Vegvesen's *kjøretøyopplysninger* API** — key
      `8fc8a67a-61c9-4a7f-9315-ee5f2797f502`. Probe which dimensions, weights and fuel type it
      returns for a registration number, and whether that can fill the vehicle profile (and the
      toll price's vehicle class) instead of typing it. The key goes in a backend env var, never
      to clients; this file is gitignored, so it is recorded here only until it moves to the
      host `.env`.

- [ ] **DATEX road-camera photos as a layer.** The existing DATEX credentials already reach the
      CCTV publications that nothing uses yet (DATA-SOURCES.md → *Corridor travel times*): show
      camera sites on the map, with the latest image on tap.

- [ ] **Parking from Vegvesen's *parkeringsregisteret*** (open API, documented with Swagger).
      Probe what it publishes and show parking facilities as a Drive layer.

- [ ] **Return to the previous profile after navigating a drive.** When the drive ends — arrived
      or ended early — switch back to the profile that was active before it started (Explore
      etc.) instead of staying in Drive. A navigation resumed after a crash should still know
      which profile to return to.

---

## 2. Data layers, weather and activities (nodemap-inspired)

Atlas borrows nodemap's useful sources and domain calibration, not its infrastructure or UI
architecture. Endpoint details, exact layer names and gotchas live in
[DATA-SOURCES.md](./DATA-SOURCES.md); engine design lives in [FISH-HUNT-ENGINE.md](./FISH-HUNT-ENGINE.md).
System health (N7) is engineering work and sits under *Engineering health*.

### N2. Norwegian data layers

- [ ] **Lake depth v2: vector soundings, not a low-res raster.** Replace the blurry NVE WMS
      with `DybdePunkt` and `DybdeKurve` from its ArcGIS REST service through the existing
      `arcgis-vector` path. Cache GeoJSON and render crisp data-driven labels and contours.
      Whole-coverage loading is practical because only 607 lakes are surveyed; the depth-free
      shore model remains the priority for the other ~266,000. Use lake-register
      `dybdekart='J'` to detect surveys instead of counting soundings.

### N5. Derived potential surfaces — the Fish & Hunt engine

The Norway-only ranked surfaces and their visible reasoning are specified in
[FISH-HUNT-ENGINE.md](./FISH-HUNT-ENGINE.md); measured source facts are in
[DATA-SOURCES.md](./DATA-SOURCES.md).

- [ ] **Answer fishing potential per lake, not per framed area.** Keep all lakes visible, but let
      a tapped waterbody define the polygon whose shore spots are ranked and highlighted. Name
      the selected lake and retain the framed-view list as an “anything nearby” fallback.

- [ ] **Recalibrate the roe-rut calendar for Norway.** The current Central-European baseline puts
      peak rut on 24 July and late rut on 6 August, while the latitude adjustment can move it by
      at most a week. Re-anchor it in Norwegian observations and derive credible latitude and
      altitude shifts; keep this biological model separate from legal rules.

- [ ] **Replace generic legal disclaimers with useful, dated rules.** Surface tactical facts such
      as the 10 August rut-hunt opening and rifle-only constraint, then the later general season
      and shotgun allowance. Retire the no-dates test/guard as needed. Every quoted rule keeps an
      `asOf` date and source link so changes are visible.

**Stages:**

- [~] **E7 — Make Fish & Hunt discovery work offline and across zooms, or say plainly why not.**
      On Android, kept areas and derived cells render from disk; web remains online-only by
      design. Remaining:

      - Reproduce why “read the ground” and “plan stands” refuse, and explain the connection or
        zoom requirement at the point of refusal.
      - Give explain cards and ranked spots an offline representation; until then they say
        clearly that they need a connection.
      - Keep the map visible beside the shortlist, and keep (and page through) the other
        candidates when one stand is selected.

- [~] **E8 — Finish stand planning as a hunter-side surface.** Habitat answers where an animal may
      be; stand planning pairs that habitat with a reachable vantage, visibility bearings, canopy,
      wind and an approach route. The first field-ready and quiet-approach slices are shipped.
      Remaining:

      - Rank directly inside complex saved-area polygons instead of ranking a bounding box and
        filtering afterwards.
      - Run the protected-area polygon check for each proposed stand.
      - Validate the eight-bearing canopy approximation against field or orthophoto observations.
      - Put the full stand reasoning and current wind verdict on the selected place card.

- [ ] **E9 — Add five fish and five quarries as calibrated data rows.** The engine must continue to
      express targets as weights and bands rather than species-specific code. Add grouping to the
      target picker before expanding its current flat list.

      - Fish: harr, sjørøye, lake, sik and gjørs. Gjørs requires the Artskart presence gate; sik
        needs an honest coarse-model caption.
      - Quarry: jerpe, rugde, rødrev, ringdue and villrein. Villrein must be gated to the 24
        management areas; ringdue must not imply crop knowledge AR5 does not provide.
      - Calibrate each row with golden tests and follow the dated-rule/source-link policy above
        rather than duplicating legal prose in model data.
      - Marine targets remain in N6 because they require a fourth surface, bathymetry and tides.

- [ ] **E10 — Model beaver along rivers, not as an area-hunt surface.** Rank bank kilometres using
      the river corridor, gradient and riparian vegetation; add SR16 tree species to `RiverInputs`.
      Start with dam suitability and published BRAT-style thresholds: 30/100 m vegetation buffers,
      a hard stop above 23% channel slope, and explicit acknowledgement that the 10 m feeding band
      is below the raster's resolution.

      - Decide whether bank-den habitat justifies NGU loose-mass data and its 4×4/16-request cell
        cost; otherwise ship dam habitat as the first honest mode.
      - Gate presence per cell with Artskart, parsing `CollectedDate` as `dd.MM.yyyy` and rejecting
        imprecise kommune-centre records (roughly >100 m precision).
      - Treat recent SSB harvest only as a coarse presence/opening proxy, never proof of current
        permission; kommune rules are not available as a national machine-readable list.
      - Keep the output in occupied bank length/colony terms rather than area pixels. Detailed
        engine and source rationale belongs in [FISH-HUNT-ENGINE.md](./FISH-HUNT-ENGINE.md) and
        [DATA-SOURCES.md](./DATA-SOURCES.md).

### N6. Marine — shoreline fishing

- [ ] **Add shoreline fishing as a fourth potential surface.** Fish & Hunt must distinguish
      “not modelled here” from “nothing promising” at the coast. Cover at least torsk, sei, lyr,
      kveite and saltwater sjøørret; keep skarv as a later target on the same marine inputs.

      - First prove Dybdedata2 redistribution and identify a nationwide tide/current source.
      - Model bathymetry, drop-offs, points, skerries, sund and current seams; tide makes this the
        first potential surface where timing can dominate structure.
      - Scope tiles, ranking, explanations and Android offline packs together. Nautical charts,
        harbours and tide/current may also ship as independent catalog layers.
      - Calibration notes remain in [shore-fishing-saltwater.md](./notes/shore-fishing-saltwater.md).

---

## 3. Engineering health

Runs alongside the product tracks, not after them. `DR` labels come from the
[2026-08-31 architectural review](./reviews/2026-08-31-dan-abramov.md); what it found must be
preserved is in ARCHITECTURE.md → *What stays as it is*.

### 3.1 Data safety & offline reliability

- [ ] **Stream tiles through uncovered parts of an installed offline area's rectangle.** Region
      packs use square bounds while country data follows the real border; currently the pack's
      bounding box claims those outside-border cells and they render blank. Treat a missing
      offline tile as a cache miss and fall back to the online basemap when connected, rather
      than letting rectangular pack coverage suppress streaming.

### 3.2 Performance

- [~] **Audit every upstream proxy for request storms, and give them one well-behaved client.**
      The POI layer's Overpass proxy (2026-09-19) sent a fresh upstream query for every settled
      pan, keyed its cache on the exact bbox so nothing ever hit, never aborted the upstream call
      when the client gave up, and kept firing through 429s. Overpass allows 2 slots per IP; we
      ran 5–8 at once, got 429/504, and then overpass-api.de refused this host's IPv4 outright.
      Done: POI (Overpass), and weather (met.no point forecast, audited 2026-09-28; findings
      in DATA-SOURCES.md). The shared parts (`LruMap`, `SingleFlight`, `UpstreamGate` with
      pacing, rest and fail-fast 503, `restAfterFailure`) now live in `backend/src/upstream.ts`.
      Use them rather than copying. Remaining, in this order: weather-maps/archive, traffic,
      transit (Entur), tiles/overlay tiles, satellites, terrain/elevation, place-content,
      explore, iNatur, ice observations, overlay identify/features/labels, potential
      inputs/spots, and the Photon calls in `app.ts`. For each, answer:
      - Is the cache key a stable unit (tile, grid cell, snapped bbox, rounded coordinate), or the
        raw request? Is the TTL right for how fast the source changes, and is memory bounded?
      - Do identical in-flight requests share one upstream call? Is an upstream call aborted, or
        dropped from a queue, when every client waiting on it has disconnected?
      - Is upstream concurrency capped at what the provider allows, with pacing between calls?
      - On 429/503/refused, do we back off (honouring `Retry-After`), fail fast to our own
        clients with a 503 + `Retry-After` instead of queueing more, and use a fallback where one
        exists? Is a partial or error answer ever cached as "no data"?
      - Does the client debounce settled-view changes, keep what it shows while refetching, and
        ask only for what it does not already hold?
      Record each provider's published rate limit in DATA-SOURCES.md, and have the proxy's
      status row say when it is backing off (weather writes `…; backing off N s`).

- [ ] **DR5 — Move large library transfers behind a bounded asynchronous background seam.** Move
      GPX/KML/KMZ parsing, statistics, backup recognition, archive expansion/construction, and
      compression out of React orchestration and off the UI/JS thread where the platform permits.
      Keep file picking/saving platform-specific and return domain import operations to storage.
      Make Android's track cache persist across track-array changes and invalidate by content
      version.

      - [ ] Add realistic large and high-expansion-ratio fixtures before choosing limits.
      - [ ] Bound input bytes, expanded archive bytes, entry count, and per-entry size.
      - [ ] Report progress and support cancellation without leaving partial records or empty
            destination folders.
      - [ ] Keep web interaction responsive during the large-file fixture; give Android an
            equivalent background/native path or a measured cooperative fallback.
      - [ ] Simplify display geometry where profiling shows it is needed.
      - [ ] Remove synchronous zip primitives and file-format parsing from `useUserData`.
      - [ ] Change coarse full-list refreshes only where profiling proves they are material.

### 3.3 Accessibility & web UX

- [ ] **Set an interaction-accessibility baseline for both web and Android.** At 390×844, most web
      controls are below comfortable touch sizes. Standardise 44 CSS px / 48 dp hit areas,
      visible keyboard focus and accessible names/state. Complete combobox and dialog semantics,
      add keyboard/touch alternatives to drag-only reordering, and cover the baseline with axe,
      keyboard tests and a TalkBack spot-check list. Route stops became drag-only on Android in
      v0.222.0 (the ▲/▼ buttons gave way to a handle, matching web), so the planner's stop list
      is now the most-used place without a non-drag alternative — give `ReorderableList` rows
      TalkBack move-up/move-down `accessibilityActions` and the web rows a keyboard equivalent.

### 3.4 Test & release infrastructure

- [ ] **Make a failed CI build impossible to miss.** Add a loud post-deploy smoke step that checks
      the container's `/api/health` `gitSha` against the pushed commit and calls every route added by
      the release on the deployed origin. Keep route dependencies in the parity checklist so a
      renamed or deleted backend capability fails before deployment too.

- [ ] **Run the real Postgres sync store in CI.** The normal quality gate skips all seven
      `backend/src/pg.test.ts` cases, so production SQL, advisory locking, sequence cursors and
      transaction semantics are not exercised by the memory-store suite. Add a disposable
      PostGIS service to CI and make those integration tests required; keep memory tests for the
      fast path.

### 3.5 Code structure

- [ ] **DR6 — Give Android one primary-surface state instead of independent sheet booleans.**
      Define a platform-specific `PrimarySurface` union with payload-bearing variants for menu,
      search, Explore, Commute, Collections, Layers, Settings, and other mutually exclusive
      idle-map destinations. Keep navigation, transient prompts, and cards separate where they may
      genuinely coexist; do not combine this with DR2.

      - [ ] No mutually exclusive primary sheet has its own `*Open` boolean.
      - [ ] Deep links and async completions open surfaces through the same coordinator as taps.
      - [ ] Settings section and focused-record identities live on the relevant union variants.
      - [ ] Android regression coverage proves switching between every primary surface leaves
            exactly one visible.

### 3.6 System health / status (N7)

- [ ] **Alert rather than wait to be asked.** The sweep now finds a dead upstream within 6 h, but
      only Settings exposes it. After two consecutive failures, send an Android notification or
      show a persistent Settings badge. Include the `potential-cells` census warning from
      `backend/src/potential/health.ts` in the same path.

### 3.7 Host and release chores

Work done on the host or in the release pipeline rather than in the code.

- [ ] **Give Atlas the same stable APK download URL as the other apps.** Add
      `/api/app/download`, serving the APK named by `/data/app/version.json` with the Android APK
      content type and download filename, and make `/api/app/version` advertise that stable URL
      instead of `/app/atlas-<version>.apk`. Cover both routes and missing/invalid releases with
      backend tests. After the updated backend is deployed, change the Homepage **Atlas APK** tile
      from its version-pinned URL to `https://atlas.gjessing.io/api/app/download` and verify the
      link downloads the currently published APK.

- [~] **DR7 — Rebuild the offline packs so every one is reproducible and self-describing.** The
      code is shipped (committed specs, pinned tool digests, pre-flight validation, smoke checks
      before publication, `compat`/`provenance` manifests, Android declining an incompatible
      pack). Remaining, all artifacts:

      - The Scotland pack needs `tiles/great-britain.pmtiles` (`build-basemap.sh great-britain`,
        hours of Planetiler). Routing is ready: the graph rebuilt 2026-09-08, with
        `admins.sqlite` back in place, covers the British Isles (Edinburgh→Glasgow routes).
      - All six published Norway packs, Oslo included, still carry pre-DR7 manifests (no
        `compat`, no `provenance`) until they are next rebuilt.

---

## 4. Later

- [ ] i18n (English + Norwegian). DATEX message texts may not be translated under NLOD, so some
      strings remain Norwegian; see [DATA-SOURCES.md](./DATA-SOURCES.md).
