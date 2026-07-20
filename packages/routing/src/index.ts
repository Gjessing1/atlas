export type {
  RoutingProfile,
  RoutingProfileInfo,
  RouteQuery,
  RoutePath,
  RouteResult,
  RouteInstruction,
  ExitSign,
} from './model.js';
export {
  isRoutingProfile,
  ROUTING_PROFILES,
  routePathToTrackData,
  formatExitSign,
} from './model.js';
export { buildValhallaRequest, parseValhallaResponse, roundTripLocations } from './valhalla.js';
export { fetchRoute, RoutingError, type FetchRouteOptions } from './client.js';
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
