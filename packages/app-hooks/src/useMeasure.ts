/**
 * The measure / radius tool's state, shared by web and Android.
 *
 * Everything about *what* a measurement is lives in `@atlas/core`'s measure
 * model; this is only the React state around it — which mode is active, the
 * points and centres collected so far, and the derived feature collection each
 * client hands to its own map. Both scenes therefore draw one geometry and both
 * panels show one set of words, and the only platform-specific part left is how
 * a tap reaches `addPoint`.
 *
 * Closing the tool clears it. A ruler left half-drawn from an hour ago is not a
 * measurement anyone wants back; it is a stale line over a map that has moved.
 */

import {
  MEASURE_DEFAULT_RADII_M,
  measureFeatures,
  measureHasWork,
  measureReadout,
  type LatLng,
  type MeasureMode,
  type MeasureReadout,
  type MeasureState,
} from '@atlas/core';
import { useCallback, useMemo, useRef, useState } from 'react';

export interface MeasureController extends MeasureState {
  /** Whether the tool is open — while it is, it owns map taps. */
  readonly open: boolean;
  /** Open/close; closing discards the measurement. */
  setOpen: (open: boolean) => void;
  toggleOpen: () => void;
  setMode: (mode: MeasureMode) => void;
  /** A tap on the map: a ruler vertex, or a ring centre, per the active mode. */
  addPoint: (at: LatLng) => void;
  /** Add or remove a preset radius from every drawn centre at once. */
  toggleRadius: (radiusM: number) => void;
  /** Drop the last point/centre of the active mode. */
  undo: () => void;
  /** Drop everything, both modes, without closing the tool. */
  clear: () => void;
  /** Whether there is anything to undo or clear in the active mode. */
  readonly hasWork: boolean;
  /** What the map draws. */
  readonly features: GeoJSON.FeatureCollection;
  /** What the panel says. */
  readonly readout: MeasureReadout;
}

export function useMeasure(): MeasureController {
  const [open, setOpenState] = useState(false);
  const [mode, setMode] = useState<MeasureMode>('distance');
  const [points, setPoints] = useState<readonly LatLng[]>([]);
  const [centers, setCenters] = useState<readonly LatLng[]>([]);
  const [radii, setRadii] = useState<readonly number[]>(MEASURE_DEFAULT_RADII_M);

  // A tap handler is registered once (a MapLibre listener on web, a memoized
  // press handler on Android), so it must not change identity when the mode
  // does — it reads the live mode through a ref instead.
  const modeRef = useRef(mode);
  modeRef.current = mode;

  const clear = useCallback(() => {
    setPoints([]);
    setCenters([]);
  }, []);

  const setOpen = useCallback(
    (next: boolean) => {
      setOpenState(next);
      if (!next) clear();
    },
    [clear],
  );
  const toggleOpen = useCallback(() => {
    setOpenState((was) => {
      if (was) clear();
      return !was;
    });
  }, [clear]);

  const addPoint = useCallback((at: LatLng) => {
    if (modeRef.current === 'distance') setPoints((prev) => [...prev, at]);
    else setCenters((prev) => [...prev, at]);
  }, []);

  const undo = useCallback(() => {
    if (modeRef.current === 'distance') setPoints((prev) => prev.slice(0, -1));
    else setCenters((prev) => prev.slice(0, -1));
  }, []);

  const toggleRadius = useCallback((radiusM: number) => {
    setRadii((prev) =>
      prev.includes(radiusM)
        ? prev.filter((r) => r !== radiusM)
        : [...prev, radiusM].sort((a, b) => a - b),
    );
  }, []);

  const state = useMemo<MeasureState>(
    () => ({ mode, points, centers, radii }),
    [mode, points, centers, radii],
  );

  return {
    ...state,
    open,
    setOpen,
    toggleOpen,
    setMode,
    addPoint,
    toggleRadius,
    undo,
    clear,
    hasWork: measureHasWork(state),
    features: useMemo(() => measureFeatures(state), [state]),
    readout: useMemo(() => measureReadout(state), [state]),
  };
}
