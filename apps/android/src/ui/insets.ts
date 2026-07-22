import { useMemo } from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/** Horizontal safe-area insets, in dp. Both are 0 in portrait. */
export interface SideInsets {
  left: number;
  right: number;
}

/**
 * The left/right safe-area insets, for chrome anchored to a vertical screen
 * edge.
 *
 * In landscape Android moves the system navigation bar to one side of the
 * screen (and a display cut-out can take the other), so anything positioned
 * against that edge lands underneath it — both hidden and untappable. Portrait
 * reports 0 on both sides, which is why only the bottom inset was ever needed
 * before.
 *
 * Unlike the top/bottom insets — which App passes down with a fallback height,
 * because a missing inset there would hide controls — these are read straight
 * from the provider wherever they are needed: there is no safe guess for which
 * side a bar is on, and 0 is exactly the old behaviour.
 */
export function useSideInsets(): SideInsets {
  const insets = useSafeAreaInsets();
  const { left, right } = insets;
  // Stable identity: these end up in effect/memo dependency lists.
  return useMemo(() => ({ left, right }), [left, right]);
}
