import type { NavFix } from '@atlas/navigation';
import { useEffect, useState } from 'react';

/** Continuous `estimated` fix (ms) required before the map dims, absent map data. */
const CONFIRM_MS = 4000;

/**
 * Darken the map inside a tunnel, Google-style.
 *
 * Two sources, in order of trust. When the route's road attributes say the car
 * is in a mapped tunnel, dim at once — that is the portal, known from data, and
 * waiting would put the dimming several seconds inside the bore. Otherwise fall
 * back to the original inference: a *sustained* dead-reckoned fix at driving
 * speed means a tunnel (reckoning only engages above ~11 km/h, and brief urban
 * dropouts are filtered by the confirmation delay). The fallback still matters —
 * tunnels missing from the tiles, and enrichment that hasn't landed yet, both
 * end up here.
 */
export function useTunnelDim(fix: NavFix | null | undefined, inTunnel = false): boolean {
  const [confirmed, setConfirmed] = useState(false);

  useEffect(() => {
    if (fix !== 'estimated') {
      setConfirmed(false);
      return;
    }
    const timer = setTimeout(() => setConfirmed(true), CONFIRM_MS);
    return () => clearTimeout(timer);
  }, [fix]);

  return inTunnel || confirmed;
}
