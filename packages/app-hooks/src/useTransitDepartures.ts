import { TransitError } from '@atlas/transit';
import type {
  TransitDeparturesQuery,
  TransitDeparturesResult,
  TransitLocation,
} from '@atlas/transit';
import { useCallback, useEffect, useRef, useState } from 'react';

/** Platform seam for the same-origin web proxy or Android's configured Atlas server. */
export type TransitDeparturesFn = (
  query: TransitDeparturesQuery,
  signal: AbortSignal,
) => Promise<TransitDeparturesResult>;

export interface TransitDepartures {
  result: TransitDeparturesResult | null;
  loading: boolean;
  error: string | null;
  /** When the visible live board was checked. Null means there is no board to age. */
  updatedMs: number | null;
  refresh: () => void;
}

/**
 * Load a destination-free next-hour board only while its surface is open.
 *
 * Web and Android deliberately share the request lifecycle: a new target
 * clears the old stop immediately, closing aborts in flight work, and refresh
 * keeps no stale rows behind a failure. A live timetable that could not refresh
 * must not continue looking current.
 */
export function useTransitDepartures(
  fetchDepartures: TransitDeparturesFn,
  location: TransitLocation,
  active: boolean,
): TransitDepartures {
  const [result, setResult] = useState<TransitDeparturesResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [updatedMs, setUpdatedMs] = useState<number | null>(null);
  const [seed, setSeed] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const key = `${location.lat},${location.lng},${location.stopId ?? ''}`;

  useEffect(() => {
    abortRef.current?.abort();
    if (!active) {
      setResult(null);
      setLoading(false);
      setError(null);
      setUpdatedMs(null);
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setResult(null);
    setLoading(true);
    setError(null);
    setUpdatedMs(null);
    void fetchDepartures(location, controller.signal).then(
      (next) => {
        if (controller.signal.aborted) return;
        setResult(next);
        setLoading(false);
        setUpdatedMs(Date.now());
      },
      (err: unknown) => {
        if (controller.signal.aborted) return;
        setLoading(false);
        setError(
          err instanceof TransitError
            ? err.message
            : 'Departure board unavailable — check your connection.',
        );
      },
    );
    return () => controller.abort();
    // `location` is rebuilt by both cards; its value-key is the dependency.
  }, [active, key, seed, fetchDepartures]);

  const refresh = useCallback(() => setSeed((value) => value + 1), []);
  return { result, loading, error, updatedMs, refresh };
}
