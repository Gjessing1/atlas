import type { NavFix } from '@atlas/navigation';
import { useEffect, useState } from 'react';

/** Continuous `estimated` fix (ms) required before the map dims. */
const CONFIRM_MS = 4000;

/**
 * Tunnel dimming heuristic: a sustained dead-reckoned fix at driving speed
 * means a tunnel (reckoning only engages above ~11 km/h, and brief urban
 * dropouts are filtered by the confirmation delay), so darken the map,
 * Google-style, until live GPS returns.
 */
export function useTunnelDim(fix: NavFix | null | undefined): boolean {
  const [dimmed, setDimmed] = useState(false);

  useEffect(() => {
    if (fix !== 'estimated') {
      setDimmed(false);
      return;
    }
    const timer = setTimeout(() => setDimmed(true), CONFIRM_MS);
    return () => clearTimeout(timer);
  }, [fix]);

  return dimmed;
}
