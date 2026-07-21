export type {
  RoutingProfile,
  RoutingProfileInfo,
  RouteQuery,
  RoutePath,
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
} from './model.js';
export { buildValhallaRequest, parseValhallaResponse, roundTripLocations } from './valhalla.js';
export { fetchRoute, httpTraceTransport, RoutingError, type FetchRouteOptions } from './client.js';
export {
  buildTraceAttributesRequest,
  enrichRoute,
  enrichmentAt,
  parseTraceAttributes,
  speedLimitKphAt,
  tunnelAt,
  tunnelNear,
  type EnrichRouteOptions,
  type RouteEnrichment,
  type RouteEnrichmentSegment,
  type RouteTunnel,
} from './enrich.js';
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
export {
  distanceToRouteM,
  photonBbox,
  routeSearchBounds,
  ROUTE_SEARCH_CORRIDOR_M,
} from './corridor.js';
