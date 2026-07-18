import type { NavFix } from '@atlas/navigation';
import { useEffect, useRef, useState } from 'react';
import { Animated } from 'react-native';

/** Continuous `estimated` fix (ms) required before the map dims. */
const CONFIRM_MS = 4000;

/**
 * Tunnel dimming heuristic: a sustained dead-reckoned fix at driving speed
 * means a tunnel (reckoning only engages above ~11 km/h, and brief urban
 * dropouts are filtered by the confirmation delay), so darken the map,
 * Google-style, until live GPS returns. Returns the overlay's animated
 * opacity: a slow fade in (eyes adjust to the dark), a quick fade out at the
 * bright portal.
 */
export function useTunnelDim(fix: NavFix | null | undefined): Animated.Value {
  const opacity = useRef(new Animated.Value(0)).current;
  const [dimmed, setDimmed] = useState(false);

  useEffect(() => {
    if (fix !== 'estimated') {
      setDimmed(false);
      return;
    }
    const timer = setTimeout(() => setDimmed(true), CONFIRM_MS);
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
