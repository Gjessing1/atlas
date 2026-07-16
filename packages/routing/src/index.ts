export type {
  RoutingProfile,
  RoutingProfileInfo,
  RouteQuery,
  RoutePath,
  RouteResult,
  RouteInstruction,
} from './model.js';
export { ROUTING_PROFILES, routePathToTrackData } from './model.js';
export { buildValhallaRequest, parseValhallaResponse, roundTripLocations } from './valhalla.js';
export { fetchRoute, RoutingError, type FetchRouteOptions } from './client.js';
export {
  httpRouteProvider,
  valhallaRouteProvider,
  type RouteProvider,
  type ValhallaTransport,
} from './provider.js';
export { optimizeWaypointOrder } from './optimize.js';
export { viaInsertIndex } from './insert.js';
