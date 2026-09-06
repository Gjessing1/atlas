import { satelliteElementsUrl, type LayerMeta } from '@atlas/core';
import {
  coversGround,
  footprintRing,
  groundTrackSegments,
  subpointAt,
  type SatelliteElementSet,
  type SatelliteOmm,
} from '@atlas/satellites';
import * as FileSystem from 'expo-file-system/legacy';
import { useEffect, useRef, useState } from 'react';

import type { ActiveOverlay } from './useOverlays';

const SUNLIT_COLOR = '#fbbf24';
const ECLIPSED_COLOR = '#64748b';
const TRACK_REFRESH_MS = 30_000;

/** What the selected object's horizon circle is drawn against — web's twin. */
export interface SatelliteFootprint {
  /** The same floor the pass sheet filters by, so ring and list agree. */
  minElevationDeg: number;
  observer: { lat: number; lng: number };
}

export interface SatelliteLayerData {
  layerId: string;
  active: boolean;
  elements: readonly SatelliteOmm[];
  data: GeoJSON.FeatureCollection | null;
  opacity: number;
  status: 'idle' | 'loading' | 'ready' | 'error';
  /** Selected object above the observer's horizon now; null when none is. */
  overhead: boolean | null;
}

/** The selected object's horizon circle. See web's `footprintFeatures`. */
function footprintFeatures(
  elements: readonly SatelliteOmm[],
  at: Date,
  selectedNoradId: number | null,
  footprint: SatelliteFootprint | null,
): { features: GeoJSON.Feature[]; overhead: boolean | null } {
  if (selectedNoradId === null || !footprint) return { features: [], overhead: null };
  const element = elements.find((entry) => entry.NORAD_CAT_ID === selectedNoradId);
  if (!element) return { features: [], overhead: null };
  const fix = subpointAt(element, at);
  if (!fix) return { features: [], overhead: null };
  const ring = footprintRing(fix, { minElevationDeg: footprint.minElevationDeg });
  if (ring.length === 0) return { features: [], overhead: null };
  const overhead = coversGround(fix, footprint.observer, footprint.minElevationDeg);
  return {
    features: [
      {
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [ring] },
        properties: { footprint: true, noradId: fix.noradId, overhead },
      },
    ],
    overhead,
  };
}

function featuresAt(
  elements: readonly SatelliteOmm[],
  layerId: string,
  at: Date,
  selectedNoradId: number | null,
  previousTracks: GeoJSON.Feature[],
  refreshTracks: boolean,
  footprint: SatelliteFootprint | null,
): { collection: GeoJSON.FeatureCollection; tracks: GeoJSON.Feature[]; overhead: boolean | null } {
  const tracks = refreshTracks
    ? elements.flatMap((element): GeoJSON.Feature[] => {
        if (element.ATLAS_GROUP !== 'stations' && element.NORAD_CAT_ID !== selectedNoradId) {
          return [];
        }
        return groundTrackSegments(element, { at, revolutions: 1, stepSeconds: 30 }).map(
          (coordinates): GeoJSON.Feature => ({
            type: 'Feature',
            geometry: { type: 'LineString', coordinates },
            properties: {
              track: true,
              selected: element.NORAD_CAT_ID === selectedNoradId,
              noradId: element.NORAD_CAT_ID,
            },
          }),
        );
      })
    : previousTracks;
  const points: GeoJSON.Feature[] = [];
  for (const element of elements) {
    const fix = subpointAt(element, at);
    if (!fix) continue;
    points.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [fix.lng, fix.lat] },
      properties: {
        layerId,
        noradId: fix.noradId,
        name: fix.name,
        station: fix.group === 'stations',
        selected: fix.noradId === selectedNoradId,
        color: fix.sunlit ? SUNLIT_COLOR : ECLIPSED_COLOR,
      },
    });
  }
  const disc = footprintFeatures(elements, at, selectedNoradId, footprint);
  return {
    collection: {
      type: 'FeatureCollection',
      features: [...disc.features, ...tracks, ...points],
    },
    tracks,
    overhead: disc.overhead,
  };
}

/** Android's locally propagated twin of the web satellite layer. */
export function useSatellites(
  overlays: ActiveOverlay[],
  origin: string,
  layerId: string,
  selectedNoradId: number | null,
  footprint: SatelliteFootprint | null = null,
): SatelliteLayerData {
  const active = overlays.find((overlay) => overlay.meta.id === layerId && overlay.meta.vector);
  const present = Boolean(active);
  const rev = active?.meta.rev ?? 0;
  const opacity = active?.opacity ?? 1;
  const metaRef = useRef<LayerMeta | undefined>(active?.meta);
  metaRef.current = active?.meta;
  const elementsRef = useRef<SatelliteOmm[]>([]);
  const fetchedRevRef = useRef<number | null>(null);
  const tracksRef = useRef<GeoJSON.Feature[]>([]);
  const trackAtRef = useRef(0);
  // Read inside the tick, so moving the observer or the elevation floor does
  // not restart the propagation effect.
  const footprintRef = useRef(footprint);
  footprintRef.current = footprint;
  // See web's drawRef: repaints the disc the moment the floor changes rather
  // than on the next propagation tick.
  const drawRef = useRef<(() => void) | null>(null);
  const [state, setState] = useState<Pick<SatelliteLayerData, 'elements' | 'data' | 'status'>>({
    elements: [],
    data: null,
    status: 'idle',
  });
  const [overhead, setOverhead] = useState<boolean | null>(null);

  useEffect(() => {
    if (!present) return;
    let cancelled = false;
    trackAtRef.current = 0;

    const draw = () => {
      if (cancelled || elementsRef.current.length === 0) return;
      const now = Date.now();
      const next = featuresAt(
        elementsRef.current,
        layerId,
        new Date(now),
        selectedNoradId,
        tracksRef.current,
        now - trackAtRef.current >= TRACK_REFRESH_MS,
        footprintRef.current,
      );
      if (next.tracks !== tracksRef.current) {
        tracksRef.current = next.tracks;
        trackAtRef.current = now;
      }
      setState((current) => ({ ...current, data: next.collection }));
      // Only on a change — this ticks once a second and the sheet below it
      // renders a whole pass list.
      setOverhead((current) => (current === next.overhead ? current : next.overhead));
    };
    drawRef.current = draw;

    const meta = metaRef.current;
    if (meta && fetchedRevRef.current !== rev) {
      fetchedRevRef.current = rev;
      setState((current) => ({ ...current, status: 'loading' }));
      void (async () => {
        const cacheUri = FileSystem.cacheDirectory
          ? `${FileSystem.cacheDirectory}atlas-elements-${encodeURIComponent(origin)}-${layerId}.json`
          : null;
        // Seed the propagator before touching the network. Orbital elements
        // age gracefully, so an old set is much more useful than a blank sky
        // when a phone starts without coverage; the sheet makes its age clear.
        try {
          const raw = cacheUri ? await FileSystem.readAsStringAsync(cacheUri) : null;
          const saved = raw ? (JSON.parse(raw) as SatelliteElementSet) : null;
          if (
            !cancelled &&
            saved &&
            Array.isArray(saved.satellites) &&
            saved.satellites.length > 0
          ) {
            elementsRef.current = saved.satellites;
            setState({ elements: saved.satellites, data: null, status: 'ready' });
            draw();
          }
        } catch {
          // A malformed/failed local cache is disposable; the live fetch below
          // repairs it without taking the layer down.
        }
        try {
          const response = await fetch(satelliteElementsUrl(origin, meta));
          if (!response.ok) throw new Error(`satellite elements: HTTP ${response.status}`);
          const body = (await response.json()) as SatelliteElementSet;
          if (cancelled || !Array.isArray(body.satellites)) return;
          elementsRef.current = body.satellites;
          setState((current) => ({
            ...current,
            elements: body.satellites,
            status: 'ready',
          }));
          if (cacheUri) {
            void FileSystem.writeAsStringAsync(cacheUri, JSON.stringify(body)).catch(
              () => undefined,
            );
          }
          draw();
        } catch {
          fetchedRevRef.current = null;
          if (!cancelled && elementsRef.current.length === 0) {
            setState((current) => ({ ...current, status: 'error' }));
          }
        }
      })();
    } else {
      draw();
    }

    const timer = setInterval(draw, layerId === 'starlink' ? 2000 : 1000);
    return () => {
      cancelled = true;
      drawRef.current = null;
      clearInterval(timer);
    };
  }, [present, rev, origin, layerId, selectedNoradId]);

  // Primitives, not the object: the caller rebuilds it every render.
  useEffect(() => {
    drawRef.current?.();
  }, [footprint?.minElevationDeg, footprint?.observer.lat, footprint?.observer.lng]);

  // No circle asked for, no answer — rather than the last one, which would
  // outlive the layer being switched off.
  return { layerId, active: present, opacity, ...state, overhead: footprint ? overhead : null };
}
