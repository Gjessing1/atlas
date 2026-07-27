import { spotsFeatureCollection, type PotentialSpot } from '@atlas/potential';
import type maplibregl from 'maplibre-gl';
import { useEffect, useMemo, useRef } from 'react';

const SOURCE_ID = 'atlas-spots';
const HALO = 'atlas-spots-halo';
const DISC = 'atlas-spots-disc';
const NUMBER = 'atlas-spots-number';
const ALL_LAYERS = [HALO, DISC, NUMBER];

const EMPTY_FC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

/**
 * The numbered "best spots in view" markers (ROADMAP § N5 → E6).
 *
 * Numbers rather than pins, and the numbers come from the shared
 * `spotsFeatureCollection` rather than from this file: the marker and the list
 * row are the same recommendation, and a client that numbered them in its own
 * order would quietly break the only link between the two halves of the
 * feature.
 *
 * They sit **above** the derived surface they came from and carry a white halo,
 * because the ramp's hot band is exactly the colour they are drawn on.
 */
export function useSpotLayer(
  map: maplibregl.Map | null,
  spots: readonly PotentialSpot[],
  onPick: (spot: PotentialSpot) => void,
  suppressClicks?: { readonly current: boolean },
): void {
  const spotsRef = useRef<readonly PotentialSpot[]>(spots);
  spotsRef.current = spots;
  const pickRef = useRef(onPick);
  pickRef.current = onPick;

  // Memoised, because it is an effect dependency: rebuilding the collection on
  // every render would tear the layers down and rebuild them on every render too.
  const data = useMemo(
    () =>
      spots.length
        ? (spotsFeatureCollection(spots) as unknown as GeoJSON.FeatureCollection)
        : EMPTY_FC,
    [spots],
  );
  // Survives style swaps, like every other GeoJSON layer here: re-adding the
  // source after a basemap change must not flash the markers away.
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

    if (spots.length === 0) {
      removeAll();
      return;
    }

    const ensure = () => {
      // Guarded on the style existing, not on it being *loaded*: a Fish & Hunt
      // profile has eight overlays in flight and `isStyleLoaded()` stays false
      // while any of them fetches, which once cost a derived layer ten seconds
      // before it attached.
      if (cancelled || !map.getStyle()) return;
      const source = map.getSource(SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
      if (!source) {
        map.addSource(SOURCE_ID, { type: 'geojson', data: dataRef.current });
      } else {
        source.setData(dataRef.current);
      }
      if (!map.getLayer(HALO)) {
        map.addLayer({
          id: HALO,
          type: 'circle',
          source: SOURCE_ID,
          paint: {
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 12, 14, 17],
            'circle-color': '#ffffff',
            'circle-opacity': 0.9,
          },
        });
        map.addLayer({
          id: DISC,
          type: 'circle',
          source: SOURCE_ID,
          paint: {
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 9.5, 14, 14],
            // The band's own colour, so a spot is visibly the hot end of the
            // ramp it was found on.
            'circle-color': ['get', 'color'],
            'circle-stroke-width': 1.5,
            'circle-stroke-color': '#ffffff',
          },
        });
        map.addLayer({
          id: NUMBER,
          type: 'symbol',
          source: SOURCE_ID,
          layout: {
            'text-field': ['get', 'label'],
            'text-font': ['Noto Sans Bold'],
            'text-size': ['interpolate', ['linear'], ['zoom'], 10, 12, 14, 15],
            'text-allow-overlap': true,
            'text-ignore-placement': true,
          },
          paint: { 'text-color': '#ffffff' },
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

  useEffect(() => {
    if (!map) return;
    const onClick = (e: maplibregl.MapMouseEvent) => {
      if (suppressClicks?.current) return;
      if (!map.getLayer(DISC)) return;
      const hit = map.queryRenderedFeatures(e.point, { layers: [DISC, HALO] })[0];
      if (!hit) return;
      const id = hit.properties?.['id'];
      const spot = spotsRef.current.find((candidate) => candidate.id === id);
      if (!spot) return;
      // The marker is a shortcut into the same card a tap on the water opens —
      // reasoning, elevation, weather, save — so the click is a selection, not
      // a popup of its own. A POI handler under the same click ran first (they
      // are registered when the map is created), so this one wins the card.
      pickRef.current(spot);
    };
    map.on('click', onClick);
    return () => {
      map.off('click', onClick);
    };
  }, [map, suppressClicks]);
}
