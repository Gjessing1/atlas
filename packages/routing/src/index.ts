export type {
  RoutingProfile,
  RoutingProfileInfo,
  RoundTripDirection,
  RoutePreferences,
  RouteQuery,
  RoutePath,
  RouteEnrichment,
  RouteEnrichmentSegment,
  RouteResult,
  RouteInstruction,
  RouteLane,
  LaneDirection,
  VerbalInstruction,
  ExitSign,
} from './model.js';
export {
  isRoutingProfile,
  ROUTING_PROFILES,
  routePathToTrackData,
  formatExitSign,
  defaultRoutePreferences,
} from './model.js';
export {
  buildValhallaRequest,
  parseValhallaResponse,
  roundTripLocations,
  type RoundTripStop,
} from './valhalla.js';
export {
  fetchRoute,
  httpTraceTransport,
  httpElevationProfile,
  httpNvdbLimits,
  httpNvdbCameras,
  RoutingError,
  type FetchRouteOptions,
  type NvdbLimitTransport,
  type NvdbCameraTransport,
} from './client.js';
export {
  enrichPlannedPath,
  enrichPlannedResult,
  routeProfileIndexes,
  type RouteElevationTransport,
} from './planning.js';
export {
  conflateCameras,
  type CameraConflationOptions,
  type NvdbCameraData,
  type NvdbCameraPoint,
  type NvdbCameraSection,
  type RouteCameraPoint,
  type RouteCameraSection,
  type RouteCameras,
} from './cameras.js';
export { osmCameraFromTags, parseOsmCameraDirection, type OsmTags } from './osmCameras.js';
export {
  buildTraceAttributesRequest,
  enrichRoute,
  enrichmentAt,
  parseTraceAttributes,
  speedLimitKphAt,
  tunnelAt,
  tunnelNear,
  type EnrichRouteOptions,
  type RouteTunnel,
} from './enrich.js';
export {
  applyNvdbSpeedLimits,
  nvdbSpeedOverrides,
  type NvdbSpeedSegment,
  type NvdbSpeedOptions,
  type SpeedLimitOverride,
} from './nvdb.js';
export {
  httpRouteProvider,
  valhallaRouteProvider,
  type RouteProvider,
  type ValhallaTransport,
} from './provider.js';
export { optimizeWaypointOrder } from './optimize.js';
export { pathViaLabels } from './via.js';
export { sortRouteChoices } from './choices.js';
export { viaInsertIndex } from './insert.js';
export { trackToRoutePoints } from './track.js';
export {
  routeSurfaceAt,
  routeSurfaceBreakdown,
  routeSurfaceLabel,
  type RouteSurfaceShare,
} from './surface.js';
export {
  distanceToRouteM,
  photonBbox,
  routeSearchBounds,
  ROUTE_SEARCH_CORRIDOR_M,
} from './corridor.js';
