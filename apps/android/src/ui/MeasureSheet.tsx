import type { MeasureController } from '@atlas/app-hooks';
import { fmtRadius, MEASURE_RADII_M } from '@atlas/core';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { BottomSheet } from './BottomSheet';
import { theme } from './theme';

/**
 * The measure / radius tool on Android — the web MeasureTool's twin.
 *
 * Range rings around a stand are a field feature and the field device is the
 * phone, which is why this exists at all (ROADMAP §7.5): the geometry had been
 * shared in `@atlas/core` *for* Android since the web tool shipped, with
 * nothing here consuming it.
 *
 * A map sheet, not a modal: the tool's whole point is that the next tap lands
 * on the map, so the sheet sits at the bottom and leaves everything above it
 * live. Mode, points, rings and every word shown here come from `useMeasure`
 * (@atlas/app-hooks), so the two clients cannot drift apart on what a
 * measurement is or what it is called.
 */
export function MeasureSheet({
  visible,
  measure,
  bottomInset,
}: {
  visible: boolean;
  measure: MeasureController;
  bottomInset: number;
}) {
  const { mode, radii, readout, hasWork } = measure;
  return (
    <BottomSheet
      visible={visible}
      mode="map"
      onClose={() => measure.setOpen(false)}
      initialSnap="peek"
      // Tall enough that Undo/Clear are fully on screen at the lowest snap —
      // the radius mode adds the chip row, and a bent line adds the
      // straight-line comparison under the total.
      peekHeight={mode === 'radius' ? 312 : 264}
      bottomInset={bottomInset}
      testID="measure-sheet"
    >
      <View style={styles.header}>
        <Text style={styles.heading}>Measure</Text>
        <Pressable onPress={() => measure.setOpen(false)} hitSlop={10} testID="measure-close">
          <Text style={styles.close}>✕</Text>
        </Pressable>
      </View>

      <View style={styles.modes} accessibilityRole="radiogroup">
        {(['distance', 'radius'] as const).map((option) => {
          const on = mode === option;
          return (
            <Pressable
              key={option}
              style={[styles.mode, on && styles.modeOn]}
              onPress={() => measure.setMode(option)}
              accessibilityRole="radio"
              accessibilityState={{ checked: on }}
              testID={`measure-mode-${option}`}
            >
              <Text style={[styles.modeText, on && styles.modeTextOn]}>
                {option === 'distance' ? 'Distance' : 'Radius'}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {mode === 'radius' ? (
        <View style={styles.chips} accessibilityLabel="Ring radii">
          {MEASURE_RADII_M.map((r) => {
            const on = radii.includes(r);
            return (
              <Pressable
                key={r}
                style={[styles.chip, on && styles.chipOn]}
                onPress={() => measure.toggleRadius(r)}
                accessibilityRole="switch"
                accessibilityState={{ checked: on }}
                testID={`measure-radius-${r}`}
              >
                <Text style={[styles.chipText, on && styles.chipTextOn]}>{fmtRadius(r)}</Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}

      <View style={styles.body}>
        {readout.headline ? (
          <Text style={styles.readout} testID="measure-readout">
            {readout.headline}
          </Text>
        ) : null}
        {readout.detail ? <Text style={styles.detail}>{readout.detail}</Text> : null}
        {readout.hint ? <Text style={styles.hint}>{readout.hint}</Text> : null}
      </View>

      <View style={styles.actions}>
        <Pressable
          style={[styles.button, !hasWork && styles.buttonDisabled]}
          disabled={!hasWork}
          onPress={measure.undo}
          testID="measure-undo"
        >
          <Text style={styles.buttonText}>Undo</Text>
        </Pressable>
        <Pressable
          style={[styles.button, !hasWork && styles.buttonDisabled]}
          disabled={!hasWork}
          onPress={measure.clear}
          testID="measure-clear"
        >
          <Text style={styles.buttonText}>Clear</Text>
        </Pressable>
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  heading: { color: theme.text, fontSize: 17, fontWeight: '700' },
  close: { color: theme.textMuted, fontSize: 18, paddingHorizontal: 4 },
  modes: { flexDirection: 'row', gap: 8, marginTop: 12 },
  mode: {
    flex: 1,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 10,
    backgroundColor: theme.surfaceMuted,
  },
  modeOn: { backgroundColor: theme.accentFaint },
  modeText: { color: theme.text, fontSize: 14, fontWeight: '600' },
  modeTextOn: { color: theme.accent, fontWeight: '800' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 },
  chip: {
    minHeight: 36,
    paddingHorizontal: 12,
    justifyContent: 'center',
    borderRadius: 999,
    backgroundColor: theme.surfaceMuted,
  },
  chipOn: { backgroundColor: theme.accentFaint },
  chipText: { color: theme.text, fontSize: 13 },
  chipTextOn: { color: theme.accent, fontWeight: '800' },
  body: { marginTop: 12, minHeight: 44 },
  readout: { color: theme.text, fontSize: 26, fontWeight: '800' },
  detail: { color: theme.textMuted, fontSize: 12, marginTop: 2 },
  hint: { color: theme.textMuted, fontSize: 13 },
  actions: { flexDirection: 'row', gap: 8, marginTop: 12 },
  button: {
    flex: 1,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 10,
    backgroundColor: theme.surfaceMuted,
  },
  buttonDisabled: { opacity: 0.45 },
  buttonText: { color: theme.text, fontSize: 14, fontWeight: '700' },
});
