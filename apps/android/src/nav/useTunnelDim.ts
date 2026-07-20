import type { NavFix } from '@atlas/navigation';
import { useEffect, useRef, useState } from 'react';
import { Animated } from 'react-native';

/** Continuous `estimated` fix (ms) required before the map dims, absent map data. */
const CONFIRM_MS = 4000;

/**
 * Darken the map inside a tunnel, Google-style. Returns the overlay's animated
 * opacity: a slow fade in (eyes adjust to the dark), a quick fade out at the
 * bright portal.
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
export function useTunnelDim(fix: NavFix | null | undefined, inTunnel = false): Animated.Value {
  const opacity = useRef(new Animated.Value(0)).current;
  const [confirmed, setConfirmed] = useState(false);
  const dimmed = inTunnel || confirmed;

  useEffect(() => {
    if (fix !== 'estimated') {
      setConfirmed(false);
      return;
    }
    const timer = setTimeout(() => setConfirmed(true), CONFIRM_MS);
    return () => clearTimeout(timer);
  }, [fix]);

  useEffect(() => {
    const anim = Animated.timing(opacity, {
      toValue: dimmed ? 1 : 0,
      duration: dimmed ? 800 : 300,
      useNativeDriver: true,
    });
    anim.start();
    return () => anim.stop();
  }, [dimmed, opacity]);

  return opacity;
}
