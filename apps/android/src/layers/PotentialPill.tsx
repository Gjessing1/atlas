import type { PotentialPrep } from '@atlas/app-hooks';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { theme } from '../ui/theme';

/**
 * The preparation pill for a derived potential surface — the Android twin of
 * the web's, with the same rule: it says only things that are findings (how
 * many areas are being read, that this is Norway-only ground, that there is
 * nothing here to score) and disappears the moment the answer is "ready".
 *
 * Placed under the search bar rather than over the map's bottom half, which on
 * a phone belongs to the sheets.
 */
/**
 * Whether the pill is on screen at all.
 *
 * Exported because whatever sits under it has to know: the "best spots"
 * affordance stacks below the pill, and computing that offset from a second,
 * hand-copied version of this rule is how the two would end up overlapping the
 * first time a state was added here.
 */
export function potentialPillVisible(prep: PotentialPrep): boolean {
  return prep.status !== 'off' && prep.status !== 'ready' && Boolean(prep.message);
}

export function PotentialPill({
  prep,
  top,
  left,
  right,
}: {
  prep: PotentialPrep;
  top: number;
  left: number;
  right: number;
}) {
  if (!potentialPillVisible(prep)) return null;
  const working = prep.status === 'preparing';
  return (
    <View style={[styles.pill, { top, left, right }]} testID="potential-pill">
      <Text style={styles.text} numberOfLines={1}>
        {prep.message}
      </Text>
      {working ? (
        <Pressable onPress={prep.pause} hitSlop={8} testID="potential-pause">
          <Text style={styles.action}>Stop</Text>
        </Pressable>
      ) : null}
      {prep.status === 'paused' ? (
        <Pressable onPress={prep.resume} hitSlop={8} testID="potential-resume">
          <Text style={styles.action}>Resume</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    position: 'absolute',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    alignSelf: 'flex-start',
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: theme.surfaceOverlay,
    elevation: 3,
  },
  text: { flex: 1, color: theme.text, fontSize: 12 },
  action: { color: theme.accent, fontSize: 12, fontWeight: '700' },
});
