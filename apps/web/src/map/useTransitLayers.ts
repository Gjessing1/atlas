import { isRideMode, type TransitTrip } from '@atlas/transit';
import type { Feature, FeatureCollection } from 'geojson';
import type maplibregl from 'maplibre-gl';
import { useEffect } from 'react';

const SOURCE_ID = 'atlas-transit';
const WALK_LINE = 'atlas-transit-walk';
const RIDE_CASING = 'atlas-transit-ride-casing';
const RIDE_LINE = 'atlas-transit-ride';
const STOP_DOTS = 'atlas-transit-stops';
const TRANSIT_LAYERS = [WALK_LINE, RIDE_CASING, RIDE_LINE, STOP_DOTS];
/** Ride legs with no operator colour — matches the road route's own line. */
const FALLBACK_COLOR = '#7048c9';

/**
 * The journey as geometry: one feature per leg, carrying the line's own colour
 * so the map reads like the departure board next to it. Boarding points are
 * separate point features — where you change vehicles is the part of a journey
 * a map is uniquely good at showing.
 */
function tripCollection(trip: TransitTrip): FeatureCollection {
  const features: Feature[] = [];
  for (const leg of trip.legs) {
    if (leg.points.length >= 2) {
      features.push({
        type: 'Feature',
        properties: {
          ride: isRideMode(leg.mode),
          color: leg.line?.colour ?? FALLBACK_COLOR,
        },
        geometry: { type: 'LineString', coordinates: leg.points.map((p) => [p.lng, p.lat]) },
      });
    }
    if (isRideMode(leg.mode)) {
      for (const place of [leg.from, leg.to]) {
        features.push({
          type: 'Feature',
          properties: { color: leg.line?.colour ?? FALLBACK_COLOR },
          geometry: { type: 'Point', coordinates: [place.position.lng, place.position.lat] },
        });
      }
    }
  }
  return { type: 'FeatureCollection', features };
}

/**
 * Draws the selected public transport journey: rides in their operator colour,
 * walks as a dashed grey thread, boarding points as ringed dots. Rendered only
 * while transit mode is showing a journey — the road route owns the map
 * otherwise, and two overlapping answers to "how do I get there" is one too
 * many.
 */
export function useTransitLayers(map: maplibregl.Map | null, trip: TransitTrip | null): void {
  useEffect(() => {
    if (!map) return;
    const data = trip ? tripCollection(trip) : null;
    let cancelled = false;

    const sync = () => {
      if (cancelled) return;
      // Deliberately *not* gated on `isStyleLoaded()`: that reports false while
      // any source is still fetching, which on a slow connection can persist
      // for as long as the user is looking at the map — and a journey that
      // only draws once every tile has arrived is a journey that never draws.
      // What actually matters is that the style exists to mutate; the retry
      // events below cover the window before that.
      if (!map.getStyle()) return;
      if (!data) {
        for (const id of TRANSIT_LAYERS) if (map.getLayer(id)) map.removeLayer(id);
        if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
        return;
      }
      const source = map.getSource(SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
      if (source) {
        source.setData(data);
      } else {
        map.addSource(SOURCE_ID, { type: 'geojson', data });
      }
      if (map.getLayer(WALK_LINE)) return;
      const layout = { 'line-cap': 'round', 'line-join': 'round' } as const;
      const ride: maplibregl.ExpressionSpecification = ['to-boolean', ['get', 'ride']];
      map.addLayer({
        id: WALK_LINE,
        type: 'line',
        source: SOURCE_ID,
        filter: ['all', ['==', ['geometry-type'], 'LineString'], ['!', ride]],
        layout: { ...layout, 'line-cap': 'butt' }, // round caps blur a dash pattern
        paint: { 'line-color': '#5c5a56', 'line-width': 3.5, 'line-dasharray': [1, 1.6] },
      });
      map.addLayer({
        id: RIDE_CASING,
        type: 'line',
        source: SOURCE_ID,
        filter: ride,
        layout,
        paint: { 'line-color': '#ffffff', 'line-width': 8, 'line-opacity': 0.85 },
      });
      map.addLayer({
        id: RIDE_LINE,
        type: 'line',
        source: SOURCE_ID,
        filter: ride,
        layout,
        // The operator's own colour, straight off the leg — the same badge
        // colour the board shows for that line.
        paint: { 'line-color': ['string', ['get', 'color'], FALLBACK_COLOR], 'line-width': 5 },
      });
      map.addLayer({
        id: STOP_DOTS,
        type: 'circle',
        source: SOURCE_ID,
        filter: ['==', ['geometry-type'], 'Point'],
        paint: {
          'circle-radius': 5,
          'circle-color': '#ffffff',
          'circle-stroke-width': 2.5,
          'circle-stroke-color': ['string', ['get', 'color'], FALLBACK_COLOR],
        },
      });
    };

    sync();
    // `styledata` also fires after a style swap (the layer switcher), which
    // drops every layer we added and needs them put back.
    map.on('style.load', sync);
    map.on('styledata', sync);
    map.on('idle', sync);
    return () => {
      cancelled = true;
      map.off('style.load', sync);
      map.off('styledata', sync);
      map.off('idle', sync);
    };
  }, [map, trip]);
}
