import { act, renderHook } from '@testing-library/react';
import { MEASURE_DISTANCE_HINT } from '@atlas/core';
import { describe, expect, it } from 'vitest';

import { useMeasure } from './useMeasure.js';

const A = { lat: 59.9, lng: 10.7 };
const B = { lat: 59.91, lng: 10.7 };

const kinds = (fc: GeoJSON.FeatureCollection) => fc.features.map((f) => f.properties?.['kind']);

describe('useMeasure', () => {
  it('collects ruler vertices and reports the total', () => {
    const { result } = renderHook(() => useMeasure());
    expect(result.current.readout.hint).toBe(MEASURE_DISTANCE_HINT);
    expect(result.current.hasWork).toBe(false);

    act(() => result.current.addPoint(A));
    act(() => result.current.addPoint(B));
    expect(result.current.points).toHaveLength(2);
    expect(result.current.hasWork).toBe(true);
    expect(result.current.readout.headline).toBe('1.1 km');
    expect(kinds(result.current.features)).toContain('path');
  });

  it('sends a tap to centres once the mode is radius, with a stable handler', () => {
    const { result } = renderHook(() => useMeasure());
    // The map handler is registered once and must survive a mode change: web
    // binds it to MapLibre, Android memoizes it into useMapPress.
    const addPoint = result.current.addPoint;
    act(() => result.current.setMode('radius'));
    expect(result.current.addPoint).toBe(addPoint);

    act(() => addPoint(A));
    expect(result.current.centers).toEqual([A]);
    expect(result.current.points).toHaveLength(0);
    expect(result.current.readout.detail).toBe('1 circle');
  });

  it('undoes within the active mode only', () => {
    const { result } = renderHook(() => useMeasure());
    act(() => result.current.addPoint(A));
    act(() => result.current.setMode('radius'));
    act(() => result.current.addPoint(B));
    act(() => result.current.undo());
    expect(result.current.centers).toHaveLength(0);
    // The ruler the user built in the other mode is untouched.
    expect(result.current.points).toEqual([A]);
  });

  it('toggles preset radii, keeping them ordered', () => {
    const { result } = renderHook(() => useMeasure());
    act(() => result.current.setMode('radius'));
    act(() => result.current.addPoint(A));
    act(() => result.current.toggleRadius(50));
    expect(result.current.radii).toEqual([50, 100, 200]);
    act(() => result.current.toggleRadius(100));
    expect(result.current.radii).toEqual([50, 200]);
    expect(kinds(result.current.features).filter((k) => k === 'ring')).toHaveLength(2);
  });

  it('discards the measurement when the tool closes', () => {
    const { result } = renderHook(() => useMeasure());
    act(() => result.current.toggleOpen());
    act(() => result.current.addPoint(A));
    act(() => result.current.addPoint(B));
    expect(result.current.open).toBe(true);

    act(() => result.current.toggleOpen());
    expect(result.current.open).toBe(false);
    expect(result.current.points).toHaveLength(0);
    expect(result.current.features.features).toHaveLength(0);
    // Radii are a preference, not part of the measurement — they survive.
    expect(result.current.radii).toEqual([100, 200]);
  });
});
