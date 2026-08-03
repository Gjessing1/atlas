import { savedStandFeatures } from '@atlas/core';
import type { PlaceRecord } from '@atlas/storage';
import type maplibregl from 'maplibre-gl';
import { useEffect, useMemo, useRef } from 'react';

const SOURCE_ID = 'atlas-saved-stands';
const LANES = 'atlas-saved-stands-lanes';
const AIM = 'atlas-saved-stands-aim';
const ALL_LAYERS = [LANES, AIM];

const EMPTY_FC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

/**
 * A saved stand's own rose on the map (ROADMAP § E12).
 *
 * The live shortlist has drawn lanes and an aim since v0.139.0, but saving one
 * threw the geometry away: a stand the user had chosen drew as a bare teardrop,
 * identical to a pin dropped on a car park. Which way the stand faces is the
 * whole point of the pin, and it should be visible on the map that made it.
 *
 * Drawn **dimmer and thinner** than the live shortlist deliberately. Both can be
 * on screen at once — planning a new area with last season's stands visible is
 * the normal case — and the two must not read as one set. Live is a proposal
 * being considered; saved is a decision already made, and quieter.
 *
 * The geometry comes from `savedStandFeatures`, the same shared builder Android
 * uses, so the two clients and the card cannot end up drawing three roses.
 */
export function useSavedStandLayer(
  map: maplibregl.Map | null,
  places: readonly PlaceRecord[],
): void {
  // Only the stands, and only their geometry: the effect below depends on this
  // collection, and rebuilding it on every render of the place list would tear
  // the layers down and re-add them on every render too.
  const data = useMemo(() => {
    const stands = places.filter((place) => place.stand);
    return stands.length
      ? (savedStandFeatures(stands) as unknown as GeoJSON.FeatureCollection)
      : EMPTY_FC;
  }, [places]);
  const dataRef = useRef<GeoJSON.FeatureCollection>(data);
  dataRef.current = data;

  useEffect(() => {
    if (!map) return;
    let cancelled = false;

    const removeAll = () => {
      if (!map.getStyle()) return;
      for (const id of ALL_LAYERS) if (map.getLayer(id)) map.removeLayer(id);
      if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
    };

    if (data.features.length === 0) {
      removeAll();
      return;
    }

    const ensure = () => {
      // Guarded on the style existing rather than being *loaded*, for the same
      // reason the shortlist's layer is: a Fish & Hunt profile keeps
      // `isStyleLoaded()` false while any of its overlays is still fetching.
      if (cancelled || !map.getStyle()) return;
      const source = map.getSource(SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
      if (!source) {
        map.addSource(SOURCE_ID, { type: 'geojson', data: dataRef.current });
      } else {
        source.setData(dataRef.current);
      }
      if (!map.getLayer(LANES)) {
        map.addLayer({
          id: LANES,
          type: 'line',
          source: SOURCE_ID,
          filter: ['==', ['get', 'kind'], 'lane'],
          paint: { 'line-color': '#ffffff', 'line-width': 1.5, 'line-opacity': 0.4 },
        });
        map.addLayer({
          id: AIM,
          type: 'line',
          source: SOURCE_ID,
          filter: ['==', ['get', 'kind'], 'aim'],
          paint: {
            'line-color': '#f59e0b',
            'line-width': 2,
            'line-opacity': 0.55,
            'line-dasharray': [2, 1.5],
          },
        });
      }
    };

    ensure();
    map.on('style.load', ensure);
    map.on('styledata', ensure);
    return () => {
      cancelled = true;
      map.off('style.load', ensure);
      map.off('styledata', ensure);
    };
  }, [map, data]);
}
