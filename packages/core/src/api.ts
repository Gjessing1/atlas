/** Backend response shapes that belong to no larger domain. */

/**
 * GET /api/app/version — newest Android APK available for self-update.
 * Backed by `<dataDir>/app/version.json` + the .apk it names.
 */
export interface AppVersionResponse {
  /** Android versionCode — monotonic integer clients compare against their own. */
  versionCode: number;
  /** Human-readable version, e.g. "0.2.0". */
  versionName: string;
  /** Server-relative URL of the APK, e.g. "/app/atlas-0.2.0.apk". */
  apkUrl: string;
  bytes: number;
}

// ---- System status (GET /api/status) ----

/**
 * Health of one upstream Atlas depends on. `ok` = last probe succeeded;
 * `degraded` = currently failing but has worked before (usually serving a
 * stale/cached copy); `down` = failing and never succeeded this run;
 * `unknown` = not probed yet (no real traffic has exercised it).
 */
export type UpstreamHealth = 'ok' | 'degraded' | 'down' | 'unknown';

/**
 * One upstream service or data source. Probes piggyback on real proxy traffic
 * (recorded in the proxy layer) rather than active polling, so `unknown` simply
 * means nothing has touched it since boot — not that it is broken.
 */
export interface UpstreamStatus {
  id: string;
  label: string;
  /** Display grouping, e.g. "Routing", "Overlays". */
  group: string;
  health: UpstreamHealth;
  /** Epoch ms of the last successful probe, or null. */
  lastSuccess: number | null;
  /** Epoch ms of the last failed probe, or null. */
  lastFailure: number | null;
  /** Last failure message (upstream error / HTTP status), or null. */
  message: string | null;
  /** Extra context, e.g. "map data from 2026-07-12", "3 archives". */
  detail: string | null;
}

/**
 * GET /api/status — per-upstream health for the settings/status page. Answers
 * "why is this blank?" without SSHing into the box.
 */
export interface SystemStatus {
  app: string;
  gitSha: string;
  /** Epoch ms this snapshot was taken. */
  generatedAt: number;
  /** Worst health across all sources (unknown sources don't drag it down). */
  overall: UpstreamHealth;
  sources: UpstreamStatus[];
}

// ---- Point elevation (GET /api/elevation) ----

/**
 * GET /api/elevation?lat=..&lon=.. — terrain height at a single point, proxied
 * from Kartverket's Høydedata point service. Enriches a dropped pin / saved
 * place without any raster pipeline. `elevationM` is null outside coverage
 * (Norway only — the point is on the sea or off the national model).
 */
export interface ElevationResponse {
  /** Metres above sea level, or null when the point has no coverage. */
  elevationM: number | null;
  /** Upstream data source label (e.g. "Nasjonal høydemodell"), when given. */
  source?: string;
}
